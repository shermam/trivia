import { Locator } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { signInFromGameOver } from '../../support/auth';
import { answerQuestion, startGame, startNewGame } from '../../support/game';
import { CORRECT_ANSWERS, questionsFixture } from '../../support/open-trivia';

test.describe('verified user saves a score to the leaderboard', () => {
  const password = 'correct horse battery staple';

  /**
   * Unique per test, not per file: workers share one emulator and there is no
   * `resetBackend()` between them, so a second `createVerifiedUser` with an
   * address another test already used would fail with "email address already in
   * use". The same is true of the seeded rival below, and against the real
   * preview project, where two concurrent deploys share one database.
   */
  const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  test('shows the save-score form once fully authenticated and records the entry', async ({
    page,
    firebase,
  }) => {
    /**
     * The **displayed names** are unique per run, not only the uids behind
     * them, and that is the half that was missing. A unique uid stops two runs
     * writing the same document; it does nothing for an assertion that
     * addresses a row by the text it shows. Both preview suites seed a rival
     * and save a score on every PR, so a fixed "Reigning Champ" put two
     * identical rows on one board — which Playwright reports as a strict-mode
     * violation rather than quietly matching the first, which would have passed
     * against another run's row while proving nothing about its own.
     *
     * A **short** tag rather than `unique()`: `firestore.rules` caps a
     * leaderboard name at 30 characters and the input carries `maxlength="30"`,
     * so a long suffix is truncated by the browser before it is ever written
     * and the assertion then looks for a string nothing shows.
     */
    const tag = Math.random().toString(36).slice(2, 8);
    const rival = `Reigning Champ ${tag}`;
    const player = `Test Player ${tag}`;

    const email = `player-${unique()}@example.com`;
    await firebase.createVerifiedUser({ email, password });
    await firebase.seedLeaderboardEntry({
      uid: `existing-leader-${unique()}`,
      name: rival,
      score: 5,
      totalQuestions: 5,
      percentage: 100,
    });

    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    // Anonymous at game-over: prompted to sign in instead of the save form.
    // Visible, because every face of the card is always in the DOM — see the
    // height test in `game-flow.spec.ts`.
    await expect(page.getByText('Sign in to save this score to the leaderboard.')).toBeVisible();

    // The same card, measured across a real auth transition rather than
    // face-by-face. Only a couple of pixels are at stake at this viewport, so
    // the load-bearing version of this assertion is the mobile one in
    // `game-flow.spec.ts`; this is the end-to-end confirmation that the states
    // the app actually reaches behave like the boxes that reserve them.
    const card = page.getByTestId('score-action');
    const signedOutHeight = (await card.boundingBox())!.height;

    await signInFromGameOver(page, email, password);

    // Closing the menu returns focus to whatever opened it — here game-over's
    // own "Sign in" button, which signing in has just hidden rather than
    // removed, because the card's faces are stacked and only toggle
    // `visibility`. `focus()` on a hidden element is a silent no-op that drops
    // focus to `<body>`, so without the visibility check in `TopBarComponent` a
    // keyboard user loses their place with nothing logged anywhere. jsdom
    // enforces neither half of that, which is why this assertion is here and not
    // in the unit spec.
    await expect(page.getByTestId('auth-menu-trigger')).toBeFocused();

    await expect(page.getByTestId('score-save')).toBeVisible();
    await expectCardHeightUnmoved(card, signedOutHeight, 'card height moved when auth resolved');

    // G6: the leaderboard name is data about the user (the `nickname` purpose),
    // so a browser can prefill it from the profile it knows.
    await expect(page.locator('input[name=playerName]')).toHaveAttribute(
      'autocomplete',
      'nickname',
    );
    await page.locator('input[name=playerName]').fill(player);
    await page.getByRole('button', { name: 'Save Score', exact: true }).click();

    await expect(page.getByTestId('score-saved')).toBeVisible();
    await expectCardHeightUnmoved(card, signedOutHeight, 'card height moved when the score saved');
    await expect(page.getByText(rival)).toBeVisible();
    await expect(page.getByText(player)).toBeVisible();
  });

  test('surfaces a friendly message when the new score does not beat the existing best', async ({
    page,
    firebase,
  }) => {
    const email = `player-${unique()}@example.com`;
    await firebase.createVerifiedUser({ email, password });

    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    await signInFromGameOver(page, email, password);
    await page.locator('input[name=playerName]').fill('Repeat Player');
    await page.getByRole('button', { name: 'Save Score', exact: true }).click();
    await expect(page.getByTestId('score-saved')).toBeVisible();

    await page.getByRole('button', { name: 'Play Again', exact: true }).click();
    // Replays via the app's own "Play Again" reset — no revisit — since a
    // redundant navigation back to the page it is already on, right after heavy
    // Auth/Firestore activity, was flaky in CI (occasionally left the auth-menu
    // dropdown rendered open for no in-app reason).
    await startNewGame(page, 5);

    // Miss the first question this time so the new attempt can't beat the
    // perfect score already on file for this uid.
    const wrongAnswer = questionsFixture.results[0].incorrect_answers[0];
    await answerQuestion(page, wrongAnswer);
    for (const answer of CORRECT_ANSWERS.slice(1)) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    await page.locator('input[name=playerName]').fill('Repeat Player');
    await page.getByRole('button', { name: 'Save Score', exact: true }).click();

    // Addressed by `data-cy` rather than by the message alone: the same text is
    // written into two places in the template, and which one renders depends on
    // whether the failure set `hasSaved` — so a bare text locator asserts
    // against whichever happens to be there (`CLAUDE.md` §4.6).
    await expect(page.getByTestId('score-save-failed')).toBeVisible();
    await expect(page.getByTestId('score-save-failed')).toContainText('already higher');
  });
});

/**
 * The card must not change height as its faces swap.
 *
 * Polled rather than measured once: the state change that precedes each call
 * has been asserted, but the box it produces can still be a frame behind, and a
 * single `boundingBox()` would read that frame and call it a layout shift.
 */
async function expectCardHeightUnmoved(
  card: Locator,
  expected: number,
  message: string,
): Promise<void> {
  await expect
    .poll(async () => Math.abs((await card.boundingBox())!.height - expected), { message })
    .toBeLessThanOrEqual(0.5);
}
