import { Locator, Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { signInFromGameOver } from '../../support/auth';
import { answerQuestion, startGame, startNewGame } from '../../support/game';
import { CORRECT_ANSWERS, questionsFixture } from '../../support/open-trivia';

/**
 * **Every game in this file is played to a score no multiplier touches**, and
 * that is a property of where the file runs rather than of what it tests.
 *
 * It is one of two `authenticated/` specs in the preview slice
 * (`playwright.preview.config.ts`), so it writes real leaderboard entries into
 * the real `trivimind-dev` project — where `firestore.rules` is whatever `main`
 * last deployed, because rules are per project and a preview channel is
 * Hosting only (`docs/ci-cd.md` §4.2a). A spec that ran here therefore has to
 * write documents the rules on `main` accept as well as the ones in the branch
 * under test. A streak of three or more earns a multiplier (`FEAT-004`), which
 * carries the score past the question count and takes `percentage` off the
 * score it used to be derived from — so a perfect five-question round is
 * exactly the kind of entry that is legitimate on one side of a rules change
 * and refused on the other. Missing a question keeps the streak under the first
 * bonus tier and the entry acceptable to both.
 *
 * The multiplied entry has a spec of its own, `streak-leaderboard.spec.ts`,
 * which is emulator-only for that reason.
 *
 * **What was saved is asserted through the Admin SDK, never off the board**,
 * and that is the second thing this file's location decides. The board renders
 * the top ten by score, and `trivimind-dev`'s is a shared, permanent ranking
 * that every PR adds to and nothing prunes — so "my row is on screen" is a
 * claim about everybody else's scores as much as about the save under test. It
 * held until it didn't: with ten entries above four points on the 15-second
 * board, a four-point save writes correctly, renders nothing, and fails a test
 * whose subject is the write. Re-running cannot clear that and neither can any
 * amount of unique naming, because the row is genuinely not in the top ten.
 * `firebase.getLeaderboardEntry` reads the document this test's own account
 * wrote, which is the thing the test is actually about; the board is asserted
 * only for what this test controls — that the section renders and finishes
 * loading.
 */
test.describe('verified user saves a score to the leaderboard', () => {
  const password = 'correct horse battery staple';

  /**
   * What `playMissing(page, [2])` is worth: four of five right, no streak past
   * the first bonus tier, so the score is the plain correct-answer count.
   */
  const oneMissedScore = { score: 4, totalQuestions: 5, percentage: 80 } as const;

  /**
   * Answers all five fixture questions, missing the ones named by index, so the
   * run never reaches a third consecutive correct answer.
   */
  async function playMissing(page: Page, missing: readonly number[]): Promise<void> {
    for (const [index, correct] of CORRECT_ANSWERS.entries()) {
      await answerQuestion(
        page,
        missing.includes(index) ? questionsFixture.results[index].incorrect_answers[0] : correct,
      );
    }
    await expect(page).toHaveURL(/\/game-over$/);
  }

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
     * The displayed names stay unique per run even though nothing addresses a
     * row by its text any more: the name is what gets written and read back,
     * and two concurrent runs sharing "Test Player" would let this assertion
     * pass against the wrong save. A **short** tag rather than `unique()`,
     * because `firestore.rules` caps a leaderboard name at 30 characters and
     * the input carries `maxlength="30"` — a long suffix is truncated by the
     * browser before it is written, and the assertion then compares against a
     * string nothing stored.
     */
    const tag = Math.random().toString(36).slice(2, 8);
    const rival = `Reigning Champ ${tag}`;
    const player = `Test Player ${tag}`;

    const email = `player-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });
    const rivalUid = `existing-leader-${unique()}`;
    await firebase.seedLeaderboardEntry({
      uid: rivalUid,
      name: rival,
      score: 5,
      totalQuestions: 5,
      percentage: 100,
    });

    await startGame(page, 5);
    await playMissing(page, [2]);

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

    // The board is asserted for what this test controls: that the section is
    // there and has stopped loading. Which rows it ends up showing is a
    // property of every other score in the project.
    await expect(page.getByTestId('leaderboard-body')).toBeVisible();
    await expect(page.getByTestId('leaderboard-skeleton')).toHaveCount(0);

    // What the save actually wrote, for this test's own account. Polled
    // because the confirmation above is rendered from the client's own view of
    // the write and a read-back can still be a beat behind it — and a single
    // read would be a race dressed as an assertion (`CLAUDE.md` §4.6).
    await expect
      .poll(() => firebase.getLeaderboardEntry({ uid }), {
        message: 'the score was never written to the 15-second board',
      })
      .toMatchObject({ name: player, ...oneMissedScore, timeLimit: '15' });

    // And that saving one account's score left another account's row alone.
    // The screen could never distinguish that from "it happens to be in the
    // top ten", which is what this assertion used to be doing.
    await expect
      .poll(() => firebase.getLeaderboardEntry({ uid: rivalUid }), {
        message: "the rival's entry did not survive the save",
      })
      .toMatchObject({ name: rival, score: 5 });
  });

  test('surfaces a friendly message when the new score does not beat the existing best', async ({
    page,
    firebase,
  }) => {
    const email = `player-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });

    await startGame(page, 5);
    await playMissing(page, [2]);

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

    // Miss one more question this time, so the new attempt scores below the
    // four already on file for this uid.
    await playMissing(page, [0, 3]);

    await page.locator('input[name=playerName]').fill('Repeat Player');
    await page.getByRole('button', { name: 'Save Score', exact: true }).click();

    // Addressed by `data-cy` rather than by the message alone: the same text is
    // written into two places in the template, and which one renders depends on
    // whether the failure set `hasSaved` — so a bare text locator asserts
    // against whichever happens to be there (`CLAUDE.md` §4.6).
    await expect(page.getByTestId('score-save-failed')).toBeVisible();
    await expect(page.getByTestId('score-save-failed')).toContainText('already higher');

    // The message is what the player is told; this is what the rules did. A
    // refusal that the app narrated correctly while the lower score overwrote
    // the higher one would satisfy every assertion above and lose the entry
    // the test is named for.
    await expect
      .poll(() => firebase.getLeaderboardEntry({ uid }), {
        message: 'the refused save overwrote the better score',
      })
      .toMatchObject(oneMissedScore);
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
