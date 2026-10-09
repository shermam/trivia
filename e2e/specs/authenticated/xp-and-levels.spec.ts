import { Browser, BrowserContext, Page, Response } from '@playwright/test';
import { FirebaseBackend } from '../../fixtures/firebase-backend';
import { expect, test } from '../../fixtures/test';
import { authMenu, openAuthMenu, signInViaUi } from '../../support/auth';
import { installAuthUidTracker } from '../../support/auth-uid-tracker';
import { expectNoAxeViolations } from '../../support/axe';
import { answerQuestion, startNewGame } from '../../support/game';
import { expectSameHeight, settledHeight } from '../../support/layout';
import { CORRECT_ANSWERS, stubOpenTrivia } from '../../support/open-trivia';
import { runTag, startTopicGame } from '../../support/topics';

const password = 'Str0ngPassw0rd!';
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const uniqueEmail = () => `xp-${unique()}@example.com`;

/**
 * The `users/{uid}` read `/profile` makes for its totals and XP — a `GET` on
 * the document. The avatar's read is a `documents:batchGet` that names the
 * document in its body, so this pattern cannot catch it.
 */
const STATS_READ = /\/documents\/users\//;

/**
 * The two widths the brief names, each tall enough that the page does not pin
 * a card against an edge, which can hide a resize (`CLAUDE.md` §4.4).
 */
const VIEWPORTS = [
  { width: 390, height: 1000 },
  { width: 1280, height: 1000 },
] as const;

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

/** `users/{uid}.xp` as stored, polled — `recordGameResult` changes nothing in the DOM. */
async function expectStoredXp(firebase: FirebaseBackend, uid: string, xp: number): Promise<void> {
  await expect
    .poll(async () => (await firebase.inspectAccountState({ uid })).gameplayStats?.['xp'], {
      message: `users/${uid}.xp never reached ${xp}`,
    })
    .toBe(xp);
}

/** Opens `/profile` through the auth menu — an in-app navigation, so this tab's state survives. */
async function openProfileFromMenu(page: Page): Promise<void> {
  await openAuthMenu(page);
  await authMenu(page).getByTestId('auth-menu-stats-link').click();
  await expect(page).toHaveURL(/\/profile$/);
}

/**
 * The `users/{uid}` read, under the test's control: passed through, held open
 * until `release()`, or refused. One handler with a mode rather than routes
 * added and removed, because unrouting races the read the next step triggers.
 */
async function controlStatsRead(page: Page) {
  const control = { mode: 'pass' as 'pass' | 'hold' | 'fail', held: 0, refused: 0 };
  let release: () => void = () => undefined;

  await page.route(STATS_READ, async (route) => {
    if (route.request().method() !== 'GET' || control.mode === 'pass') {
      await route.fallback();
      return;
    }
    if (control.mode === 'fail') {
      control.refused += 1;
      await route.abort();
      return;
    }
    const response = await route.fetch();
    control.held += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response });
  });

  return { control, release: () => release() };
}

/** An account at a known XP, signed in on `/profile` in a context of its own. */
async function accountAt(
  browser: Browser,
  baseURL: string | undefined,
  firebase: FirebaseBackend,
  xp: number,
): Promise<{ page: Page; context: BrowserContext; done: () => Promise<void> }> {
  const email = uniqueEmail();
  const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Ada' });
  // Totals beside the XP, as `recordGameResult` always writes them: `/profile`
  // reads a document with no `gamesPlayed` as nothing banked, XP and all.
  await firebase.seedGameplayStats({
    uid,
    gamesPlayed: 6,
    questionsAnswered: 30,
    correctAnswers: 22,
    bestStreak: 5,
    statsSince: Date.UTC(2026, 0, 15),
    xp,
  });

  // The fixture's uid tracker covers only the test's own context, so this one
  // reports its uids the same way (`avatar-choice.spec.ts` does the same).
  const context = await browser.newContext({ baseURL });
  const tracker = await installAuthUidTracker(context);
  const page = await context.newPage();
  await page.goto('/profile');
  await signInViaUi(page, email, password);
  await expect(page.getByTestId('avatar-idle')).toBeVisible();

  return {
    page,
    context,
    done: async () => {
      firebase.trackAuthUids(tracker.take());
      await context.close();
    },
  };
}

/**
 * `FEAT-041`: experience points computed from real play, a level derived from
 * them, and the built-avatar set level 3 unlocks.
 *
 * **Emulator-only.** Every test here leans on `recordGameResult` or
 * `setAvatar`, and Cloud Functions are not channel-scoped (`docs/ci-cd.md`
 * §4.2a): on a preview channel the XP this PR adds is not computed until the
 * merge deploys it. `playwright.preview.config.ts` includes authenticated
 * specs by name, so this file reaches the real project only if somebody adds
 * it.
 */
test.describe('XP and levels', () => {
  /**
   * The whole arc, on the real callable: a game banked, the XP it earned
   * stored, the level it crossed said on `/profile` — on the card and through
   * the live region — and the set it opened chosen and saved.
   *
   * 590 XP is ten short of level 3. Five easy Open Trivia questions answered
   * right earn 5 × 10, and a run of five earns 5 × 2: 60, so 650.
   *
   * `/profile` is reached through the auth menu rather than a reload, because
   * the level-up is the answer this tab got from the callable and a reload is
   * a new tab's worth of state.
   */
  test('a finished game earns XP, crosses a level and opens the bold set', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Ada' });
    await firebase.seedGameplayStats({
      uid,
      gamesPlayed: 7,
      questionsAnswered: 35,
      correctAnswers: 28,
      bestStreak: 6,
      statsSince: Date.UTC(2026, 0, 15),
      xp: 590,
    });

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);
    await startNewGame(page, 5);
    const banked = recordGameResultResponse(page);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    expect(await callableResult(await banked)).toEqual({ recorded: true, xp: 650, xpGained: 60 });
    await expectStoredXp(firebase, uid, 650);
    // Merged beside the totals rather than over them.
    expect((await firebase.inspectAccountState({ uid })).gameplayStats).toMatchObject({
      gamesPlayed: 8,
      correctAnswers: 33,
    });

    await openProfileFromMenu(page);
    await expect(page.getByTestId('progress-level')).toHaveText('3');
    await expect(page.getByTestId('progress-xp')).toHaveText('650 XP');
    await expect(page.getByTestId('progress-next')).toHaveText('350 XP to level 4');
    await expect(page.getByTestId('progress-level-up')).toBeVisible();
    await expect(page.getByTestId('progress-ready')).toBeHidden();
    await expect(page.getByTestId('progress-level-up')).toHaveText(
      'Your last game took you to level 3.',
    );
    await expect(page.getByTestId('profile-announcement')).toHaveText(
      'Your stats are ready. Your last game took you to level 3.',
    );
    const bar = page.getByRole('progressbar', { name: 'Progress to the next level', exact: true });
    await expect(bar).toHaveAttribute('aria-valuenow', '50');
    await expect(bar).toHaveAttribute('aria-valuemin', '0');
    await expect(bar).toHaveAttribute('aria-valuemax', '400');
    await expect(bar).toHaveAttribute('aria-valuetext', '50 of 400 XP towards level 4');

    // The set it opened, chosen and saved through the real `setAvatar`.
    await expect(page.getByTestId('avatar-set-bold-unlocked')).toBeVisible();
    await expect(page.getByTestId('progress-unlock-unlocked')).toBeVisible();
    await page
      .locator('label')
      .filter({ has: page.getByTestId('avatar-shape-crown') })
      .click();
    await page.getByTestId('avatar-save').click();
    await expect(page.getByTestId('avatar-saved')).toBeVisible();
    await expect
      .poll(async () => (await firebase.inspectAccountState({ uid })).gameplayStats?.['avatar'])
      .toEqual({ kind: 'built', seed: 'bold-30', showPublicly: false });
    await expect(page.getByTestId('auth-menu-avatar')).toHaveAttribute('data-avatar', 'built');
  });

  /**
   * The hardness half, which only the real transaction can show: the bank
   * questions' counters are read by field mask together with their wrong
   * answers, whose number the guessing correction needs. Each of these two
   * hard questions has been answered 40 times and right 10 — exactly the rate
   * a guess between four options manages, so nobody knew it, and it pays half
   * as much again as its label: 20 × 1.5 = 30. Two in a row: 60 + 2 × 2 = 64.
   */
  test('prices a bank question by how players have done on it', async ({ page, firebase }) => {
    const topic = runTag('xp');
    const runId = unique();
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({ email, password });
    await firebase.seedCustomQuestions(
      ['a', 'b'].map((suffix) => ({
        id: `xp-${runId}-${suffix}`,
        type: 'multiple' as const,
        difficulty: 'hard' as const,
        question: `XP question ${runId} ${suffix}?`,
        correct_answer: 'Right',
        incorrect_answers: ['Wrong a', 'Wrong b', 'Wrong c'],
        tags: [topic],
        answered: 40,
        correct: 10,
      })),
    );

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);
    await startTopicGame(page, { topics: [topic], found: 2, noTimeLimit: true });
    const banked = recordGameResultResponse(page);
    await answerQuestion(page, 'Right');
    await answerQuestion(page, 'Right');
    await expect(page).toHaveURL(/\/game-over$/);

    expect(await callableResult(await banked)).toEqual({ recorded: true, xp: 64, xpGained: 64 });
    await expectStoredXp(firebase, uid, 64);
  });

  /**
   * **The server enforces the unlock**, through the callable a request built
   * outside the app reaches as easily as the picker does — so a set the
   * picker shows locked is not merely hidden behind a disabled tile. And what
   * it has granted it does not take back: a stored bold avatar can be saved
   * again after the player's XP falls under the threshold, the way it would
   * if a threshold moved above them, while the rest of the set stays shut.
   */
  test('setAvatar refuses a locked set, opens it at level 3, and never re-locks a stored seed', async ({
    firebase,
  }) => {
    const caller = await firebase.signInAs({ kind: 'password', emailVerified: true });
    const bold = { kind: 'built', seed: 'bold-21', showPublicly: false };
    const stored = async () =>
      (await firebase.inspectAccountState({ uid: caller.uid })).gameplayStats?.['avatar'];

    const refused = await firebase.invokeCallable('setAvatar', caller.idToken, bold);
    expect(refused.status, JSON.stringify(refused)).toBe(403);
    expect(refused.error?.status).toBe('PERMISSION_DENIED');
    expect(await stored()).toBeUndefined();

    // The set every level has is open at none.
    const core = { kind: 'built', seed: 'core-35', showPublicly: false };
    expect((await firebase.invokeCallable('setAvatar', caller.idToken, core)).status).toBe(200);
    expect(await stored()).toEqual(core);

    await firebase.seedXp({ uid: caller.uid, xp: 600 });
    const opened = await firebase.invokeCallable('setAvatar', caller.idToken, bold);
    expect(opened.status, JSON.stringify(opened)).toBe(200);
    expect(await stored()).toEqual(bold);

    await firebase.seedXp({ uid: caller.uid, xp: 100 });
    const again = { ...bold, showPublicly: true };
    const kept = await firebase.invokeCallable('setAvatar', caller.idToken, again);
    expect(kept.status, JSON.stringify(kept)).toBe(200);
    expect(await stored()).toEqual(again);

    const other = await firebase.invokeCallable('setAvatar', caller.idToken, {
      kind: 'built',
      seed: 'bold-22',
      showPublicly: false,
    });
    expect(other.status, JSON.stringify(other)).toBe(403);
    expect(await stored()).toEqual(again);
  });

  /**
   * **A locked set is shown locked, not hidden, and the card is one height
   * locked or not** — measured, at both widths, on two accounts side by side:
   * one at 120 XP and one at 640. Each is first asserted to be showing its
   * state, or two locked cards would pass vacuously. Then the locked tiles are
   * driven the way a person would: a pointer click at a tile, and the arrow
   * keys and Space on one, none of which may choose it. axe reads both cards.
   */
  test('shows a locked set locked, at the same height as an open one', async ({
    browser,
    baseURL,
    firebase,
  }) => {
    const locked = await accountAt(browser, baseURL, firebase, 120);
    const open = await accountAt(browser, baseURL, firebase, 640);

    try {
      // Shown and its siblings hidden, for the reason the progress card's test
      // gives: the three lines share one cell, and "Checking your level…"
      // until `/profile`'s read lands.
      await expect(locked.page.getByTestId('avatar-set-bold-locked')).toBeVisible();
      await expect(locked.page.getByTestId('avatar-set-bold-checking')).toBeHidden();
      await expect(locked.page.getByTestId('avatar-set-bold-unlocked')).toBeHidden();
      await expect(locked.page.getByTestId('avatar-set-bold-locked')).toHaveText(
        'Unlocks at level 3',
      );
      await expect(open.page.getByTestId('avatar-set-bold-unlocked')).toBeVisible();
      await expect(open.page.getByTestId('avatar-set-bold-checking')).toBeHidden();
      await expect(open.page.getByTestId('avatar-set-bold-locked')).toBeHidden();

      for (const viewport of VIEWPORTS) {
        await locked.page.setViewportSize(viewport);
        await open.page.setViewportSize(viewport);
        const lockedCard = locked.page.getByTestId('avatar-card');
        const openCard = open.page.getByTestId('avatar-card');
        const height = await settledHeight(lockedCard, `the locked card at ${viewport.width}px`);
        await expectSameHeight(openCard, height, `the open card at ${viewport.width}px`);
      }

      const tiles = locked.page.locator(
        '[data-cy="avatar-set-bold-shapes"] input, [data-cy="avatar-set-bold-colours"] input',
      );
      await expect(tiles).toHaveCount(12);
      for (const tile of await tiles.all()) {
        await expect(tile).toHaveAttribute('aria-disabled', 'true');
        await expect(tile).toHaveAccessibleDescription('Unlocks at level 3');
      }
      await expect(
        open.page.locator('[data-cy="avatar-set-bold-shapes"] input[aria-disabled]'),
      ).toHaveCount(0);

      // A person's click, not `locator.click()`: Playwright waits for an
      // `aria-disabled` control to enable, which would measure nothing.
      const star = locked.page.getByTestId('avatar-shape-star');
      const label = await locked.page.locator('label').filter({ has: star }).boundingBox();
      await locked.page.mouse.click(label!.x + label!.width / 2, label!.y + label!.height / 2);
      await star.focus();
      await locked.page.keyboard.press('ArrowRight');
      await locked.page.keyboard.press('Space');
      // Two frames, so any change detection those gestures scheduled has run.
      await locked.page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      await expect(star).toBeFocused();
      await expect(star).not.toBeChecked();
      await expect(locked.page.getByTestId('avatar-shape-bolt')).not.toBeChecked();
      await expect(locked.page.getByTestId('avatar-kind-initials')).toBeChecked();

      await expectNoAxeViolations(locked.page.getByTestId('avatar-card'), 'the locked avatar card');
      await expectNoAxeViolations(open.page.getByTestId('avatar-card'), 'the open avatar card');
    } finally {
      await locked.done();
      await open.done();
    }
  });

  /**
   * **The progress card is one height in every state, at both widths**
   * (`CLAUDE.md` §4.4): signed out — the state most visitors see, designed
   * first — then signed in with the read held open, then loaded, then a
   * failed read after a reload. Each state is asserted before it is measured,
   * and the held and refused reads are counted, so an intercept that stopped
   * matching fails rather than measuring one state twice.
   */
  for (const viewport of VIEWPORTS) {
    test(`keeps the progress card one height across its states at ${viewport.width}px`, async ({
      page,
      firebase,
    }) => {
      const email = uniqueEmail();
      const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Ada' });
      await firebase.seedGameplayStats({
        uid,
        gamesPlayed: 4,
        questionsAnswered: 20,
        correctAnswers: 15,
        bestStreak: 5,
        statsSince: Date.UTC(2026, 0, 15),
        xp: 340,
      });

      await page.setViewportSize(viewport);
      await page.goto('/profile');
      const card = page.getByTestId('progress-card');
      // Each state is asserted by a sentence shown **and** a sibling hidden.
      // The sentences share one grid cell and only `invisible` separates them,
      // and a component's first binding pass runs a task after its DOM is
      // created — so for that moment every one of them reads as visible, and
      // a lone `toBeVisible` can pass before the state it names exists.
      await expect(page.getByTestId('progress-signed-out')).toBeVisible();
      await expect(page.getByTestId('progress-loading')).toBeHidden();
      await expect(page.getByTestId('progress-unlock-preview')).toHaveAttribute(
        'data-avatar',
        'guest',
      );
      const height = await settledHeight(card, 'the progress card, signed out');
      await expectNoAxeViolations(card, 'the progress card, signed out');

      const read = await controlStatsRead(page);
      read.control.mode = 'hold';
      await signInViaUi(page, email, password);
      await expect.poll(() => read.control.held, { message: 'the read was held' }).toBe(1);
      await expect(page.getByTestId('progress-loading')).toBeVisible();
      await expect(page.getByTestId('progress-signed-out')).toBeHidden();
      await expectSameHeight(card, height, 'the progress card while the read is in flight');

      read.control.mode = 'pass';
      read.release();
      await expect(page.getByTestId('progress-level')).toHaveText('2');
      await expect(page.getByTestId('progress-xp')).toHaveText('340 XP');
      await expect(page.getByTestId('progress-unlock-preview')).toHaveAttribute(
        'data-avatar',
        'built',
      );
      await expectSameHeight(card, height, 'the progress card once the XP arrives');
      await expect(
        page.getByRole('progressbar', { name: 'Progress to the next level', exact: true }),
      ).toHaveAttribute('aria-valuenow', '40');
      await expectNoAxeViolations(card, 'the progress card, loaded');

      read.control.mode = 'fail';
      await page.reload();
      await expect.poll(() => read.control.refused, { message: 'the read was refused' }).toBe(1);
      await expect(page.getByTestId('progress-failed')).toBeVisible();
      await expect(page.getByTestId('progress-loading')).toBeHidden();
      await expect(page.getByTestId('progress-level')).toHaveText('—');
      await expectSameHeight(card, height, 'the progress card after a failed read');
    });
  }
});
