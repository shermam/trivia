import { Page, Response } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { authMenu, openAuthMenu, signInViaUi } from '../../support/auth';
import { answerQuestion, startNewGame } from '../../support/game';
import { expectSameHeight, settledHeight } from '../../support/layout';
import { CORRECT_ANSWERS, stubOpenTrivia } from '../../support/open-trivia';

const password = 'Str0ngPassw0rd!';
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC day an instant falls in, as `YYYY-MM-DD` — the server's own reading of a day. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Waits out the end of a UTC day, if the test starts within `marginMs` of it.
 *
 * The daily ceiling counts a UTC day, and the tests that seed a day's count
 * seed **today's**: a test still running when midnight passes would watch the
 * count it seeded become yesterday's, and the call it expects refused would
 * bank. That is a fact about the clock rather than the code, so the test
 * steps past it instead of failing on it — rarely, for at most the margin, and
 * with its timeout extended by what it waited.
 */
async function clearOfUtcMidnight(marginMs: number): Promise<void> {
  const now = Date.now();
  const left = Math.ceil((now + 1) / DAY_MS) * DAY_MS - now;
  if (left < marginMs) {
    test.setTimeout(test.info().timeout + left + 1_000);
    await new Promise((resolve) => setTimeout(resolve, left + 1_000));
  }
}

/**
 * One finished five-question Open Trivia game, every answer right, as the app
 * sends it — per-answer records included, so a banked game writes a play
 * history and earns XP: five easy answers at 10 and a run of five at 2 each,
 * 60 XP. A refused one must do neither.
 */
function finishedGame(gameId: string) {
  return {
    gameId,
    totalQuestions: 5,
    correctAnswers: 5,
    bestStreak: 5,
    answers: Array.from({ length: 5 }, () => ({
      correct: true,
      ms: 3_000,
      difficulty: 'easy',
      tags: ['general-knowledge'],
    })),
  };
}

/** Waits for the results screen's own call to `recordGameResult` to come back. */
function recordGameResultResponse(page: Page): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      /\/recordGameResult(\?|$)/.test(response.url()) && response.request().method() === 'POST',
  );
}

/** What the callable answered, out of the callable protocol's envelope. */
async function callableResult(response: Response): Promise<unknown> {
  return ((await response.json()) as { result?: unknown }).result;
}

/** The viewports the card is held to one height at, with and without the daily-limit sentence. */
const CARD_WIDTHS = [320, 390, 1280] as const;

/** The stats card's status cell: every sentence it can show, stacked in one grid cell. */
function statusCell(page: Page) {
  return page.getByTestId('stats-status');
}

/** The status cell's width at a viewport — read once the resize has landed. */
async function statusCellWidthAt(page: Page, width: number): Promise<number> {
  await page.setViewportSize({ width, height: 1000 });
  return statusCell(page).evaluate((cell) => Math.round(cell.getBoundingClientRect().width));
}

/** One width of the sweep: the daily-limit sentence's text height, and the tallest other's. */
interface CellReading {
  width: number;
  dailyLimit: number;
  tallestOther: number;
}

/**
 * The daily-limit sentence's text height against the tallest of the cell's
 * other sentences, at every width from `from` to `to`, a pixel at a time, in
 * one `evaluate`.
 *
 * **Measured with a Range over each sentence's text, not the `<p>`'s own
 * box.** Every sentence is a grid item in the same cell, so every `<p>`
 * stretches to the row — the tallest sentence's height — and their boxes all
 * read the same whatever their text does. A Range around the text measures the
 * lines the text actually takes, `visibility: hidden` or not.
 *
 * **The cell's width is set directly** rather than the viewport resized a
 * width at a time: the text wraps on the cell's width and nothing else, and
 * the cell takes every width between its narrowest, at a 320px viewport, and
 * its widest, from 816px on — the `sm` breakpoint only steps it back within
 * that range — so sweeping the one covers every viewport from 320px to 1280px.
 */
function sweepStatusCell(page: Page, from: number, to: number): Promise<CellReading[]> {
  return statusCell(page).evaluate(
    (cell, [narrowest, widest]) => {
      const lines = [...cell.querySelectorAll('p')];
      const dailyLimit = lines.find((line) => line.dataset['cy'] === 'stats-daily-limit');
      const others = lines.filter((line) => line !== dailyLimit);
      const textHeight = (line: Element) => {
        const range = document.createRange();
        range.selectNodeContents(line);
        return range.getBoundingClientRect().height;
      };
      const readings = [];
      try {
        for (let width = narrowest; width <= widest; width += 1) {
          cell.style.width = `${width}px`;
          readings.push({
            width,
            dailyLimit: dailyLimit ? textHeight(dailyLimit) : Number.NaN,
            tallestOther: Math.max(...others.map(textHeight)),
          });
        }
      } finally {
        cell.style.width = '';
      }
      return readings;
    },
    [from, to] as const,
  );
}

/**
 * `recordGameResult`'s two bounds on what one account can bank — the ring of
 * recent game ids behind `duplicate`, and the daily ceiling behind
 * `daily-limit` — against the deployed function in the emulator.
 *
 * **Over HTTP for the bounds, the way `caller-gate.spec.ts` and the unlock
 * check in `xp-and-levels.spec.ts` drive their callables**: the claims are
 * about what the server answers and what it keeps, and a request built outside
 * the app reaches the callable as easily as the results screen does. The
 * ceiling is reached by **seeding the day's count** through the Admin SDK
 * rather than by playing 199 games, which the document's lack of any client
 * write path makes the only way in besides the callable itself. One test then
 * plays a real game into a full day, for the half only the screen can show:
 * the refusal reaching `/profile` in words.
 *
 * Every test owns a fresh account. Emulator-only by construction — it drives
 * the real callable and seeds `users/{uid}` — and outside the preview slice,
 * which names the authenticated specs it runs.
 */
test.describe('what recordGameResult will bank', () => {
  /**
   * **The defect the ring closes.** One stored id stopped an immediate repeat
   * and nothing else: A, then B, then A again, and A counted twice. Read back
   * whole, because an answer that said `duplicate` over a write that happened
   * anyway would pass the first assertion.
   */
  test('banks A and B, then refuses A again as a duplicate', async ({ firebase }) => {
    await clearOfUtcMidnight(30_000);
    const caller = await firebase.signInAs({ kind: 'password', emailVerified: true });
    const a = `limits-${unique()}-a`;
    const b = `limits-${unique()}-b`;

    const first = await firebase.invokeCallable(
      'recordGameResult',
      caller.idToken,
      finishedGame(a),
    );
    expect(first.result, JSON.stringify(first)).toEqual({ recorded: true, xp: 60, xpGained: 60 });
    const second = await firebase.invokeCallable(
      'recordGameResult',
      caller.idToken,
      finishedGame(b),
    );
    expect(second.result, JSON.stringify(second)).toEqual({
      recorded: true,
      xp: 120,
      xpGained: 60,
    });

    const again = await firebase.invokeCallable(
      'recordGameResult',
      caller.idToken,
      finishedGame(a),
    );
    expect(again.status, JSON.stringify(again)).toBe(200);
    expect(again.result).toEqual({ recorded: false, reason: 'duplicate' });

    const { gameplayStats } = await firebase.inspectAccountState({ uid: caller.uid });
    expect(gameplayStats).toMatchObject({
      gamesPlayed: 2,
      questionsAnswered: 10,
      xp: 120,
      recentGameIds: [b, a],
      dailyGames: { day: utcDay(Date.now()), count: 2 },
    });
    expect('lastGameId' in (gameplayStats ?? {}), 'nothing writes the old field').toBe(false);
    const plays = await firebase.getPlayHistory(caller.uid);
    expect(plays.map((play) => play.id).sort()).toEqual([a, b].sort());
  });

  /**
   * **The migration, against real Firestore.** A document from before the ring
   * carries one `lastGameId`: the game it names is still a duplicate, and the
   * next game banked writes the ring with that id in it and deletes the old
   * field — a `FieldValue.delete()` inside a merging `set`, which the unit
   * suite's fake can only see being passed, not applied.
   */
  test('reads a pre-ring lastGameId as a ring of one, and drops it on the next game', async ({
    firebase,
  }) => {
    await clearOfUtcMidnight(30_000);
    const caller = await firebase.signInAs({ kind: 'password', emailVerified: true });
    const old = `limits-${unique()}-old`;
    const fresh = `limits-${unique()}-fresh`;
    await firebase.seedGameplayStats({
      uid: caller.uid,
      gamesPlayed: 3,
      questionsAnswered: 15,
      correctAnswers: 12,
      bestStreak: 4,
      statsSince: Date.UTC(2026, 0, 15),
      xp: 100,
      lastGameId: old,
    });

    const replay = await firebase.invokeCallable(
      'recordGameResult',
      caller.idToken,
      finishedGame(old),
    );
    expect(replay.result, JSON.stringify(replay)).toEqual({
      recorded: false,
      reason: 'duplicate',
    });
    expect((await firebase.inspectAccountState({ uid: caller.uid })).gameplayStats).toMatchObject({
      gamesPlayed: 3,
      lastGameId: old,
    });

    const banked = await firebase.invokeCallable(
      'recordGameResult',
      caller.idToken,
      finishedGame(fresh),
    );
    expect(banked.result, JSON.stringify(banked)).toEqual({
      recorded: true,
      xp: 160,
      xpGained: 60,
    });

    const { gameplayStats } = await firebase.inspectAccountState({ uid: caller.uid });
    expect(gameplayStats).toMatchObject({ gamesPlayed: 4, recentGameIds: [fresh, old], xp: 160 });
    expect('lastGameId' in (gameplayStats ?? {}), 'the old field is gone').toBe(false);
  });

  /**
   * **The ceiling, both sides of it, without 199 real games.** The day's count
   * is seeded at 199: the 200th game banks and takes it to 200, and the 201st
   * is refused with `daily-limit` and writes nothing — the document read back
   * after it is the document read back before it, field for field, the XP, the
   * ring, the count and `updatedAt` included, and no play-history document
   * exists for it.
   */
  test('banks the 200th game of the UTC day and refuses the 201st, writing nothing', async ({
    firebase,
  }) => {
    await clearOfUtcMidnight(30_000);
    const caller = await firebase.signInAs({ kind: 'password', emailVerified: true });
    const today = utcDay(Date.now());
    const twoHundredth = `limits-${unique()}-200`;
    const twoHundredFirst = `limits-${unique()}-201`;
    await firebase.seedGameplayStats({
      uid: caller.uid,
      gamesPlayed: 199,
      questionsAnswered: 995,
      correctAnswers: 900,
      bestStreak: 12,
      statsSince: Date.UTC(2026, 0, 15),
      xp: 1_000,
      recentGameIds: [`limits-${unique()}-earlier`],
      dailyGames: { day: today, count: 199 },
    });

    const banked = await firebase.invokeCallable(
      'recordGameResult',
      caller.idToken,
      finishedGame(twoHundredth),
    );
    expect(banked.result, JSON.stringify(banked)).toEqual({
      recorded: true,
      xp: 1_060,
      xpGained: 60,
    });
    const atTheCeiling = (await firebase.inspectAccountState({ uid: caller.uid })).gameplayStats;
    expect(atTheCeiling).toMatchObject({
      gamesPlayed: 200,
      xp: 1_060,
      dailyGames: { day: today, count: 200 },
    });

    const refused = await firebase.invokeCallable(
      'recordGameResult',
      caller.idToken,
      finishedGame(twoHundredFirst),
    );
    expect(refused.status, JSON.stringify(refused)).toBe(200);
    expect(refused.result).toEqual({ recorded: false, reason: 'daily-limit' });

    expect(
      (await firebase.inspectAccountState({ uid: caller.uid })).gameplayStats,
      'a refused game moves nothing on the document',
    ).toEqual(atTheCeiling);
    const plays = await firebase.getPlayHistory(caller.uid);
    expect(plays.map((play) => play.id)).toEqual([twoHundredth]);
  });

  /**
   * **The refusal reaches the player in words.** A full day, a real game
   * played to the end, and `/profile` reached through the auth menu — this
   * tab's state, where the refusal is held — saying what the limit is and
   * when it resets, on the card and through the live region, with the totals
   * already banked left on the tiles.
   *
   * **And it costs nobody any height** (`CLAUDE.md` §4.4). The card is one
   * height without the sentence — its read held open — and with it, at 320,
   * 390 and 1280px. That alone cannot catch a sentence that is the tallest in
   * its cell, because the cell reserves the tallest for every state alike, so
   * the cell is swept too: at every width it takes between a 320px and a
   * 1280px viewport, the daily-limit text is never taller than the tallest of
   * the sentences beside it.
   */
  test('says on /profile that the last game was over the daily limit', async ({
    page,
    firebase,
  }) => {
    await clearOfUtcMidnight(120_000);
    const email = `limits-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Ada' });
    await firebase.seedGameplayStats({
      uid,
      gamesPlayed: 200,
      questionsAnswered: 1_000,
      correctAnswers: 900,
      bestStreak: 12,
      statsSince: Date.UTC(2026, 0, 15),
      xp: 2_000,
      dailyGames: { day: utcDay(Date.now()), count: 200 },
    });
    const seeded = (await firebase.inspectAccountState({ uid })).gameplayStats;

    await page.setViewportSize({ width: 390, height: 1000 });
    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);
    await startNewGame(page, 5);
    const answered = recordGameResultResponse(page);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);
    expect(await callableResult(await answered)).toEqual({
      recorded: false,
      reason: 'daily-limit',
    });

    // The `users/{uid}` read `/profile` makes, held open until released so the
    // loading state can be measured rather than raced. Only the first is held.
    // `held` moves in the same tick that `release` is assigned, after the
    // fetch, so a test that has seen it at 1 can never call the placeholder.
    let release: () => void = () => undefined;
    let claimed = false;
    let held = 0;
    await page.route(/\/documents\/users\//, async (route) => {
      if (route.request().method() !== 'GET' || claimed) {
        await route.fallback();
        return;
      }
      claimed = true;
      const response = await route.fetch();
      held += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ response });
    });

    await openAuthMenu(page);
    await authMenu(page).getByTestId('auth-menu-stats-link').click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect.poll(() => held, { message: 'the read was held' }).toBe(1);
    await expect(page.getByTestId('stats-loading')).toBeVisible();
    await expect(page.getByTestId('stats-daily-limit')).toBeHidden();
    const card = page.getByTestId('stats-card');
    const withoutTheSentence = new Map<number, number>();
    for (const width of CARD_WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      withoutTheSentence.set(
        width,
        await settledHeight(card, `the stats card at ${width}px while the read is held`),
      );
    }

    release();
    await expect(page.getByTestId('stats-daily-limit')).toBeVisible();
    await expect(page.getByTestId('stats-loading')).toBeHidden();
    await expect(page.getByTestId('stats-not-banked')).toBeHidden();
    await expect(page.getByTestId('stats-since')).toBeHidden();
    await expect(page.getByTestId('stats-daily-limit')).toHaveText(
      'Not added: the daily limit of 200 games resets at midnight UTC.',
    );
    await expect(page.getByTestId('profile-announcement')).toHaveText(
      'Your last game was not added: you reached the daily limit of 200 games.',
    );
    await expect(page.getByTestId('stat-games-played')).toHaveText('200');
    for (const width of CARD_WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      await expectSameHeight(
        card,
        withoutTheSentence.get(width)!,
        `the stats card at ${width}px showing the daily limit`,
      );
    }

    const narrowest = await statusCellWidthAt(page, 320);
    const widest = await statusCellWidthAt(page, 1280);
    const readings = await sweepStatusCell(page, narrowest, widest);
    // The sweep swept, and saw the cell's other sentences wrap differently
    // across it — or a measurement that read one height everywhere would pass.
    expect(readings).toHaveLength(widest - narrowest + 1);
    expect(new Set(readings.map((reading) => reading.tallestOther)).size).toBeGreaterThan(1);
    expect(
      readings.filter((reading) => !(reading.dailyLimit <= reading.tallestOther + 0.5)),
      'widths at which the daily-limit sentence is the tallest in its cell',
    ).toEqual([]);

    expect(
      (await firebase.inspectAccountState({ uid })).gameplayStats,
      'the refused game moved nothing',
    ).toEqual(seeded);
  });
});
