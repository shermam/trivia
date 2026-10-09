import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { answerQuestion, startGame, waitForPlayRoute } from '../../support/game';
import { expectBoxUnmoved, settledBox } from '../../support/layout';
import { readSavedGame } from '../../support/offline-storage';
import { CORRECT_ANSWERS, stubOpenTrivia } from '../../support/open-trivia';
import { holdRequests, isPlayChunk } from '../../support/requests';
import { runTag, startTopicGame } from '../../support/topics';

/**
 * Finding B8's resume path, in a browser — which, until finding B11, nothing
 * covered. The unit suites verify that `GamePersistenceService` round-trips a
 * game and that `GameControllerService` reads it back, but neither can show
 * that a real page load restores one, and that is the entire promise B8 makes:
 * a refresh, a tab crash or a PWA relaunch does not cost you the game.
 *
 * This spec is what found **B11**, and the staging is why it could: a failure
 * says *where* the game was lost rather than only that it was.
 *
 *   1. persisted before the reload  → the write landed at all
 *   2. still persisted after it     → the record survived the page load
 *   3. quiz rendered                → bootstrap actually restored it
 *
 * (1) and (2) passed and (3) failed, which located the bug between storage and
 * the signals: the record was there and the app would not take it. It was
 * being *rejected* on read — `GameConfig.amount` is declared `number`, the
 * setup form's `<select>` was writing the string `"5"` into it, and
 * `parseSavedGame` type-checks that field. The reader was right; the writer
 * was wrong. See `game-setup.component.spec.ts`.
 *
 * **`startGame(page, 5)` is load-bearing, not incidental.** It picks a question
 * count through the real `<select>`, which is what produced the bad value; the
 * form's *default* stayed a genuine number, so a version of this test that
 * never touched that control would have passed against the bug. Whatever else
 * changes here, keep something that chooses a non-default amount.
 *
 * Kept staged rather than collapsed into one assertion, because the next
 * regression here will not necessarily be the same one.
 */
test.describe('resuming a game after a reload (B8)', () => {
  test('restores the in-progress game when the page is reloaded', async ({ page }) => {
    await startGame(page, 5);

    // The persisting effect queues an async write with no observable "landed"
    // signal, so reloading immediately would be racing it rather than testing
    // the feature. Asserting the record exists is what makes the wait honest.
    await expect
      .poll(() => readSavedGame(page), { message: 'a game is persisted before the reload' })
      .not.toBeNull();

    await page.reload();

    await expect
      .poll(() => readSavedGame(page), { message: 'the persisted game survives the page load' })
      .not.toBeNull();

    // Anchored on the quiz itself, not on the URL: after a reload the URL is
    // already /play, so a pathname assertion passes before Angular boots and
    // keeps passing if the guard then redirects to /.
    await expect(page.getByTestId('question-text')).toBeVisible();
    // The count as well as the screen. It is the field that was corrupted, so
    // a restore that came back with the wrong one would still be a failure.
    await expect(page.getByText('Question 1 / 5').first()).toBeVisible();
  });
});

/**
 * The rest of B8's persistence, which the single test above does not reach.
 *
 * That test reloads `/play`. One test was the right size for a bug fix; it is
 * the wrong size for the feature, and every path below goes through the same
 * stored record by a route nothing exercised:
 *
 * - a **completed** game reloaded on `/game-over` — persisted deliberately, so
 *   a refresh does not lose a score that is about to be submitted;
 * - the **setup screen's banner**, which is what a PWA relaunch or a tap on the
 *   logo actually reaches, because both land on `/` rather than `/play`;
 * - **Discard**, which has to remove the record and not just the banner;
 * - **flags**, which are in the snapshot (`flaggedQuestionIds`) and had no
 *   round-trip test of their own.
 *
 * `parseSavedGame` *clears* the record when it rejects it, which is what made
 * B11 destructive rather than merely broken. So every one of these is a path
 * along which a future validation change can silently delete a player's game,
 * and none of them had a browser-level test.
 */
test.describe('reloading a finished game on /game-over (B8)', () => {
  test('keeps the completed game, and the score waiting to be submitted', async ({ page }) => {
    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }

    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByText('Game Over!').first()).toBeVisible();
    await expect(
      page.getByText(`${CORRECT_ANSWERS.length} / ${CORRECT_ANSWERS.length}`).first(),
    ).toBeVisible();

    await expect
      .poll(() => readSavedGame(page), { message: 'a finished game is persisted too' })
      .toMatchObject({ isComplete: true });

    await page.reload();

    // Anchored on rendered content, never on the URL: `/game-over` is already
    // the pathname after a reload, so a location assertion passes before
    // Angular boots and keeps on passing if `hasCompletedGameGuard` then
    // sends the player home.
    await expect(page.getByText('Game Over!').first()).toBeVisible();
    await expect(
      page.getByText(`${CORRECT_ANSWERS.length} / ${CORRECT_ANSWERS.length}`).first(),
    ).toBeVisible();
    await expect(page.getByTestId('leaderboard-title')).toBeVisible();
  });

  test('does not offer a finished game as one to resume', async ({ page }) => {
    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page.getByText('Game Over!').first()).toBeVisible();

    // A fresh load of `/`, so the banner's only possible source is IndexedDB.
    await page.goto('/');

    // Positive anchor before the negative assertion — a count of zero is
    // satisfied by a page that has not rendered yet (`docs/ci-cd.md` §4.3).
    await expect(page.locator('#amount')).toBeVisible();
    // `hasResumableGame()` is `totalQuestions() > 0 && !isComplete()`. The
    // record is still there — the test above proves that — and it is still
    // deliberately not offered, because resuming would send the player back to
    // replay and re-score the final question.
    await expect(page.getByTestId('resume-banner')).toHaveCount(0);
  });
});

test.describe('resuming from the setup screen (B8)', () => {
  test('offers the saved game after a fresh page load, and resumes where it left off', async ({
    page,
  }) => {
    await startGame(page, 5);
    await expect(page.getByText('Question 1 / 5').first()).toBeVisible();
    await answerQuestion(page, CORRECT_ANSWERS[0]);
    await expect(page.getByText('Question 2 / 5').first()).toBeVisible();
    await expect(page.getByText('Score: 1').first()).toBeVisible();

    // How a player actually abandons a game part-way: the top-bar logo is a
    // plain `routerLink="/"`, with no guard and no reset behind it.
    await page.locator('header a[href="/"]').first().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await expect(page.getByTestId('resume-banner')).toBeVisible();

    // Reloading is what makes this the PWA-relaunch case rather than a
    // navigation: after it, the in-memory signals are gone and the banner can
    // only be coming back out of IndexedDB.
    await page.reload();
    const banner = page.getByTestId('resume-banner');
    await expect(banner).toBeVisible();
    // Whitespace-tolerant: the count is interpolated across a line break in
    // the template, so an exact substring match would pin the formatting
    // rather than the content.
    await expect(banner).toContainText(/question\s+2\s+of\s+5/);

    await page.getByTestId('resume-game').click();

    await expect(page).toHaveURL(/\/play$/);
    await expect(page.getByTestId('question-text')).toBeVisible();
    // Position *and* score: a restore that came back at the right question
    // with the wrong score is still a lost game.
    await expect(page.getByText('Question 2 / 5').first()).toBeVisible();
    await expect(page.getByText('Score: 1').first()).toBeVisible();
  });

  test('discards the saved game — the banner goes, and so does the record', async ({ page }) => {
    await startGame(page, 5);
    await answerQuestion(page, CORRECT_ANSWERS[0]);
    await expect(page.getByText('Question 2 / 5').first()).toBeVisible();

    await page.goto('/');
    await expect(page.getByTestId('resume-banner')).toBeVisible();
    await page.getByTestId('discard-game').click();
    await expect(page.getByTestId('resume-banner')).toHaveCount(0);

    // The banner disappearing only proves the signals were cleared.
    // `discardSavedGame()` also enqueues a write, and if that half were
    // missing the game would be back on the next load — which is the whole
    // difference between discarding and hiding.
    await expect
      .poll(() => readSavedGame(page), { message: 'the discarded game is gone from storage' })
      .toBeNull();

    await page.reload();
    await expect(page.locator('#amount')).toBeVisible();
    await expect(page.getByTestId('resume-banner')).toHaveCount(0);
  });
});

test.describe('flagged questions survive a reload (B8 + H4)', () => {
  test('keeps the flag, and the chosen time limit, across a reload', async ({ page, firebase }) => {
    // Unique per test, not merely per run: workers share one emulator, so the
    // ids **and** the topic have to be this test's alone — see
    // `e2e/support/topics.ts`. Against the preview target the same uniqueness
    // is what keeps the real bank from colliding with itself.
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const topic = runTag('resume');
    const customQuestions = [
      {
        id: `resume-flag-q1-${runId}`,
        tags: [topic],
        type: 'multiple' as const,
        difficulty: 'easy' as const,
        question: 'Which planet is known as the Red Planet?',
        correct_answer: 'Mars',
        incorrect_answers: ['Venus', 'Jupiter', 'Mercury'],
      },
      {
        id: `resume-flag-q2-${runId}`,
        tags: [topic],
        type: 'boolean' as const,
        difficulty: 'easy' as const,
        question: 'Sound travels faster in water than in air.',
        correct_answer: 'True',
        incorrect_answers: ['False'],
      },
    ];

    // Community questions only — an Open Trivia DB question has no flag button,
    // because its id is minted per fetch and a report about one could never be
    // acted on.
    await firebase.seedCustomQuestions(customQuestions);
    await stubOpenTrivia(page);
    await page.goto('/');

    // The count is chosen — five, away from the default ten — for the same
    // reason `startGame(page, 5)` is load-bearing above: B11 only ever bit a
    // player who touched that control, and a spec that leaves it alone passes
    // against that bug. Two questions against five, so the short-draw offer is
    // accepted on the way in.
    //
    // No countdown. This test is about what survives a reload, and a 15-second
    // deadline running underneath it would auto-answer the question being
    // asserted on. It also puts the chosen limit — part of the persisted
    // config, and the field that decides which leaderboard the score lands on
    // — through the same round trip, which is the assertion G7 wanted and
    // could not have while the reload itself was broken. The topic goes
    // through it too: it is part of the config a resumed game is restored with.
    await startTopicGame(page, {
      topics: [topic],
      amount: 5,
      found: customQuestions.length,
      noTimeLimit: true,
    });
    await expect(page.getByTestId('no-time-limit')).toBeVisible();

    // Read from the DOM rather than assumed: the bank serves in an order this
    // test does not control.
    //
    // Asserted non-empty rather than asserted away with `!`. `textContent()`
    // is a one-shot read, so an empty string is exactly what a question that
    // has not rendered yet returns — and `toHaveText('')` after the reload
    // would then pass against a screen with no question on it, which is the
    // opposite of what this test is for.
    const flaggedQuestion = (await page.getByTestId('question-text').textContent())?.trim();
    expect(flaggedQuestion, 'the question text this test flags').toBeTruthy();

    await page.getByTestId('flag-question').click();
    await expect(page.getByTestId('flag-notice')).toBeVisible();

    await expect
      .poll(async () => (await readSavedGame(page))?.['flaggedQuestionIds'], {
        message: 'the flag reaches storage before the reload',
      })
      .toHaveLength(1);

    await page.reload();

    await expect(
      page.getByTestId('question-text'),
      'the same question is back on screen',
    ).toHaveText(flaggedQuestion as string);
    // The flag is a promise to the player — it says they will be asked for
    // detail at game over — so a reload that dropped it would break that
    // promise with nothing on screen to say so.
    await expect(page.getByTestId('flag-question')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('flag-notice')).toBeVisible();
    await expect(page.getByTestId('no-time-limit')).toBeVisible();

    // ...and so does what the game is about: the question's own topic on the
    // card, and the topic the restored config records. A config that lost it
    // would describe, from then on, a game about anything.
    await expect(page.getByTestId('question-topic')).toHaveText(`#${topic}`);
    await expect
      .poll(async () => {
        const config = (await readSavedGame(page))?.['config'] as
          Record<string, unknown> | undefined;
        return config?.['tags'];
      })
      .toEqual([topic]);
  });
});

/** The setup screen at rest: the shortcut chips landed, the allowance resolved, the fonts in. */
async function setupAtRest(page: Page): Promise<void> {
  await expect(page.getByTestId('filter-tag-suggestions').getByRole('button')).not.toHaveCount(0);
  await expect(page.getByTestId('daily-allowance')).toContainText('free games left today');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/**
 * How far the setup card sits below the top of the space it is centred in,
 * beyond that space's padding — `tag-filter.spec.ts`'s guard, for its reason:
 * zero means the card is pinned to the top, where a box arriving inside it
 * moves nothing above its own bottom edge, and a check there passes for the
 * wrong reason.
 */
function centringSlack(page: Page): Promise<number> {
  return page.getByTestId('setup-card').evaluate((card) => {
    const space = card.parentElement!;
    const offset = card.getBoundingClientRect().top - space.getBoundingClientRect().top;
    return offset - parseFloat(getComputedStyle(space).paddingTop);
  });
}

/**
 * The resume banner across a start (`CLAUDE.md` §4.4). `startGame` commits the
 * new game before it navigates and `/play` is a lazy route, so for as long as
 * that chunk downloads the setup screen is still up with a loaded, unfinished
 * game in memory — which is what the banner renders on. Read live, the banner
 * arrived for the very game being started: measured with the chunk held, the
 * card grew 122px and its top rose 61px, at both widths below, under the
 * pointer that had just pressed Start.
 *
 * **The chunk is held rather than raced** (`e2e/support/requests.ts`): from
 * the dev server it arrives in milliseconds, and a test that waited to catch
 * the window would mostly measure the screen after it. `seen` resolving is
 * also the proof the game has been committed, since `beginGame` runs before
 * the navigation that requests it.
 *
 * **At two widths, and tall at both**, for `tag-filter.spec.ts`'s reason: the
 * card is 1,164px tall at 390 and 1,100px at 1280, so 1,400 is what leaves it
 * room to move, and the slack is asserted first.
 *
 * **Two shapes of start, because the obvious fix for one breaks the other.** A
 * banner hidden for the length of a start would hold still for a fresh start
 * and vanish from under a player starting a new game over a saved one — the
 * same shift, pulling the card the other way.
 */
for (const viewport of [
  { width: 390, height: 1400 },
  { width: 1280, height: 1400 },
]) {
  test.describe(`the setup card while /play loads, at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test('raises no resume banner for the game Start is starting', async ({ page }) => {
      await stubOpenTrivia(page);
      await page.goto('/');
      await setupAtRest(page);
      const card = page.getByTestId('setup-card');
      const start = card.locator('form button[type="submit"]');
      await expect(start).toHaveText('Start Game');
      await expect(page.getByTestId('resume-banner')).toHaveCount(0);
      await expect
        .poll(() => centringSlack(page), { message: 'the card has room to move' })
        .toBeGreaterThan(8);
      const cardBox = await settledBox(card, 'the setup card at rest');
      const startBox = await settledBox(start, 'Start at rest');

      const playChunk = await holdRequests(page, isPlayChunk);
      await page.getByRole('button', { name: 'Start Game', exact: true }).click();
      await playChunk.seen;

      await expect(start).toHaveText('Loading Questions…');
      await expect(page.getByTestId('resume-banner')).toHaveCount(0);
      await expectBoxUnmoved(card, cardBox, 'the setup card while /play loads');
      await expectBoxUnmoved(start, startBox, 'Start while /play loads');

      playChunk.release();
      await waitForPlayRoute(page);
    });

    test('holds a saved game’s banner as it was while another game starts', async ({ page }) => {
      await startGame(page, 5);
      await answerQuestion(page, CORRECT_ANSWERS[0]);
      await expect(page.getByText('Question 2 / 5').first()).toBeVisible();

      // A fresh page load rather than the logo: a document that has loaded
      // `/play`'s chunk never requests it again, and the gate below needs it to.
      await page.goto('/');
      const banner = page.getByTestId('resume-banner');
      await expect(banner).toContainText(/question\s+2\s+of\s+5/);
      await setupAtRest(page);
      const card = page.getByTestId('setup-card');
      const start = card.locator('form button[type="submit"]');
      await expect(start).toHaveText('Start Game');
      await expect
        .poll(() => centringSlack(page), { message: 'the card has room to move' })
        .toBeGreaterThan(8);
      const cardBox = await settledBox(card, 'the setup card with a saved game');
      const startBox = await settledBox(start, 'Start with a saved game');

      const playChunk = await holdRequests(page, isPlayChunk);
      await page.getByRole('button', { name: 'Start Game', exact: true }).click();
      await playChunk.seen;

      // Still there, and still about the game that was in progress — not
      // rewritten to describe the one replacing it.
      await expect(start).toHaveText('Loading Questions…');
      await expect(banner).toContainText(/question\s+2\s+of\s+5/);
      await expectBoxUnmoved(card, cardBox, 'the setup card while /play loads');
      await expectBoxUnmoved(start, startBox, 'Start while /play loads');

      playChunk.release();
      await waitForPlayRoute(page);
      // ...and what Start started is the new game, from its first question.
      await expect(page.getByText('Question 1 / 5').first()).toBeVisible();
    });
  });
}
