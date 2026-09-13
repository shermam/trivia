import { Locator, Page } from '@playwright/test';
import { FirebaseBackend } from '../../fixtures/firebase-backend';
import { expect, test } from '../../fixtures/test';
import { authMenu, openAuthMenu, signInViaUi } from '../../support/auth';
import { optionLabel, waitForPlayRoute } from '../../support/game';
import { stubExtraCategory, stubOpenTrivia } from '../../support/open-trivia';

/**
 * `/my-questions` end to end (`FEAT-007`).
 *
 * This is the layer neither the rules suite nor the unit specs can reach. The
 * rules tests prove `firestore.rules` serves an author their own unapproved
 * questions and refuses everyone else; the unit specs prove the service sends
 * the right writes. Only this proves the seam: that a question submitted by one
 * account, rejected with a reason by *another*, is read back by the first —
 * through the real rules, with the real query, against a real Firestore.
 *
 * **The author is deliberately not the reviewer.** One account holding both
 * roles would satisfy the read rule through its reviewer branch, and the widened
 * ownership branch — the thing this feature could not exist without — would
 * never be exercised.
 *
 * **Everything this file touches carries a per-test tag**, and that is the whole
 * of its isolation. Workers share one emulator, so `custom_questions` holds
 * every other test's contributions: the tag goes in the question text, the
 * document ids, the accounts, and a **category** that exists for this test
 * alone, which is what makes the custom game below deterministic rather than a
 * draw from whatever the bank happens to hold.
 *
 * Questions submitted through the UI get Firestore auto-ids that reach no sweep
 * list, which is why this spec is emulator-only — the same reason
 * `review-queue.spec.ts` is (`playwright.preview.config.ts`).
 */
test.describe('my questions', () => {
  const password = 'Password123!';

  let tag: string;
  let category: string;

  test.beforeEach(async ({ page }) => {
    tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    category = `Mine ${tag}`;
    await stubOpenTrivia(page);
    await stubExtraCategory(page, category);
  });

  /**
   * Creates a Pro account that can contribute and is **not** a reviewer, once
   * per test. Signing in is a separate step because the main test below moves
   * between two accounts three times, and creating an account twice is a 400
   * from Auth rather than a second sign-in.
   */
  async function createAuthor(firebase: FirebaseBackend): Promise<string> {
    const { uid } = await firebase.createVerifiedUser({
      email: authorEmail(),
      password,
      displayName: 'Ada',
    });
    await firebase.setProSubscription({ uid });
    return uid;
  }

  async function createReviewer(firebase: FirebaseBackend): Promise<void> {
    const { uid } = await firebase.createVerifiedUser({
      email: reviewerEmail(),
      password,
      displayName: 'Rev',
    });
    await firebase.seedReviewer({ uid, reviewer: true });
  }

  const authorEmail = () => `author-${tag}@example.com`;
  const reviewerEmail = () => `reviewer-${tag}@example.com`;

  async function signIn(page: Page, email: string): Promise<void> {
    await page.goto('/');
    await signInViaUi(page, email, password);
  }

  async function signOut(page: Page): Promise<void> {
    await openAuthMenu(page);
    await authMenu(page).getByRole('button', { name: 'Sign out', exact: true }).click();
    // The chip returns to its signed-out face; without waiting for it the next
    // sign-in races the sign-out and lands on the previous account.
    await expect(page.getByTestId('auth-menu-trigger')).toContainText('Sign in');
  }

  /** This test's own rows, as distinct from every other worker's. */
  function myRows(page: Page): Locator {
    return page.getByTestId('my-question').filter({ hasText: tag });
  }

  /**
   * The whole loop, in the order a contributor lives it.
   *
   * One test rather than six because every step is the previous one's fixture:
   * there is no way to reach "the author sees the reviewer's reason" without
   * having submitted, and re-establishing that state per test would cost four
   * more sign-ins against a shared emulator for no additional coverage.
   */
  test('submits, is rejected with a reason, edits, and withdraws', async ({ page, firebase }) => {
    const submitted = `Which planet has the Great Red Spot? (${tag})`;
    const corrected = `Which planet has the Great Red Spot, really? (${tag})`;
    const reason = `The distractors are all gas giants too (${tag}).`;
    const revisedReason = `The distractors are all gas giants, so it is a giveaway (${tag}).`;

    await createAuthor(firebase);
    await createReviewer(firebase);
    await signIn(page, authorEmail());

    // 1. Contribute.
    await page.goto('/add-question');
    await page.locator('#category').fill(category);
    await page.locator('#question').fill(submitted);
    await page.locator('#correctAnswer').fill('Jupiter');
    await page.getByPlaceholder('Incorrect answer 1', { exact: true }).fill('Mars');
    await page.getByPlaceholder('Incorrect answer 2', { exact: true }).fill('Venus');
    await page.getByPlaceholder('Incorrect answer 3', { exact: true }).fill('Saturn');
    await page.getByRole('button', { name: 'Add Question', exact: true }).click();
    await expect(page.getByText('submitted for review')).toBeVisible();

    // 2. The author can see it, pending — which the read rule refused before
    // this feature, and which this account cannot reach any other way: it holds
    // no reviewer role.
    await page.goto('/my-questions');
    await expect(myRows(page)).toHaveCount(1);
    await expect(myRows(page).getByTestId('my-question-status')).toHaveText('Pending review');
    await expect(myRows(page)).toContainText(submitted);

    // 3. Somebody else rejects it, and says why.
    await signOut(page);
    await signIn(page, reviewerEmail());
    await page.goto('/review');
    const queueRow = page.getByTestId('review-question').filter({ hasText: tag });
    await expect(queueRow).toHaveCount(1);
    await queueRow.getByTestId('rejection-reason').fill(reason);
    await queueRow.getByTestId('reject-question').click();
    await expect(queueRow).toHaveCount(0);

    // 3b. ...and can change their mind about the wording without deciding the
    // question again — the write `firestore.rules` was widened for, and the one
    // the queue had no control that could reach until the Rejected tab grew
    // this button.
    await reviewTab(page, 'rejected').click();
    const rejectedRow = page.getByTestId('review-question').filter({ hasText: tag });
    await expect(rejectedRow.getByTestId('rejection-reason')).toHaveValue(reason);
    await rejectedRow.getByTestId('rejection-reason').fill(revisedReason);
    await rejectedRow.getByTestId('reject-question').click();
    // Still in the Rejected tab it was already in, rather than dropped from a
    // list it still belongs to.
    await expect(rejectedRow).toHaveCount(1);

    // 4. The author reads the reviewer's words.
    await signOut(page);
    await signIn(page, authorEmail());
    await page.goto('/my-questions');
    await expect(myRows(page).getByTestId('my-question-status')).toHaveText('Rejected');
    await expect(myRows(page).getByTestId('my-question-rejection')).toContainText(revisedReason);

    // 5. Editing sends it back for review — and takes the note with it, because
    // the note was about the text that has just been replaced.
    await myRows(page).getByTestId('edit-question').click();
    const dialog = page.getByTestId('edit-question-dialog');
    await expect(dialog).toBeFocused();
    await expect(dialog.locator('#edit-question')).toHaveValue(submitted);
    await dialog.locator('#edit-question').fill(corrected);
    await dialog.getByTestId('save-question').click();

    await expect(page.getByTestId('edit-question-dialog')).toHaveCount(0);
    await expect(myRows(page).getByTestId('my-question-status')).toHaveText('Pending review');
    await expect(myRows(page).getByTestId('my-question-rejection')).toHaveCount(0);
    await expect(myRows(page)).toContainText(corrected);

    // ...and it really landed, rather than the row repainting from memory.
    await page.reload();
    await expect(myRows(page).getByTestId('my-question-status')).toHaveText('Pending review');
    await expect(myRows(page)).toContainText(corrected);

    // 6. Withdrawing it. The confirmation says what removal actually does — the
    // licence granted at contribution is irrevocable, so "delete permanently"
    // would be a promise the app cannot keep (`FEAT-007` §0).
    await myRows(page).getByTestId('remove-question').click();
    const confirm = page.getByTestId('remove-question-dialog');
    await expect(confirm).toContainText('does not withdraw the licence');
    await confirm.getByTestId('confirm-remove').click();

    await expect(myRows(page)).toHaveCount(0);
    await expect(page.getByTestId('my-questions-empty')).toBeVisible();
    // Focus went somewhere a keyboard user can work from. The row the Remove
    // button lived on has just been deleted, so the restore has no opener to
    // return to and would otherwise drop silently to `<body>`, putting them
    // back at the top of the document (`CLAUDE.md` §4.5). jsdom cannot see
    // this; a browser can.
    await expect(page.getByTestId('my-questions-status')).toBeFocused();

    // Gone from the bank, not merely from this screen: the reviewer's queue no
    // longer has anything to decide.
    await signOut(page);
    await signIn(page, reviewerEmail());
    await page.goto('/review');
    await expect(page.getByTestId('review-question').filter({ hasText: tag })).toHaveCount(0);
  });

  /**
   * Removal takes the question out of play, which is the half `/my-questions`
   * cannot show on its own.
   *
   * Seeded rather than submitted, because this one has to start **approved** —
   * a pending question is not in the draw to begin with, so removing it would
   * prove nothing. Exactly one approved question exists in this category, so
   * the game is deterministic and the "no questions" state after removal is
   * about this test's own bank rather than about the emulator's.
   */
  test('withdrawing an approved question takes it out of the draw', async ({ page, firebase }) => {
    const live = `Is this question in play? (${tag})`;
    const uid = await createAuthor(firebase);
    await signIn(page, authorEmail());
    await firebase.seedCustomQuestions([
      {
        id: `mine-${tag}`,
        category,
        type: 'multiple',
        difficulty: 'easy',
        question: live,
        correct_answer: 'Yes',
        incorrect_answers: ['No', 'Maybe', 'Unsure'],
        createdBy: uid,
        createdAt: Date.now(),
        status: 'approved',
      },
    ]);

    // The positive control, and the reason this test is not vacuous: the
    // question really is being served before it is withdrawn.
    await startCustomGame(page, category);
    await expect(page.getByText(live)).toBeVisible();

    await page.goto('/my-questions');
    await expect(myRows(page).getByTestId('my-question-status')).toHaveText('Approved');
    await myRows(page).getByTestId('remove-question').click();
    await page.getByTestId('remove-question-dialog').getByTestId('confirm-remove').click();
    await expect(myRows(page)).toHaveCount(0);

    // Nothing approved is left in this category, so the draw comes up empty
    // rather than serving the withdrawn question.
    await page.goto('/');
    await page.locator('#amount').selectOption({ label: '5' });
    await page.locator('#category').selectOption(category);
    await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await expect(page.getByText('No questions were found for the selected options.')).toBeVisible();
  });

  test('explains itself to a visitor who has not signed in', async ({ page }) => {
    // No redirect and no guard: there is no `/login` route in this app, and an
    // anonymous session can never have written a question, so the page says so
    // rather than answering a question the visitor did not ask.
    await page.goto('/my-questions');

    await expect(page.getByTestId('my-questions-signed-out')).toBeVisible();
    await expect(page.getByTestId('my-questions-sign-in')).toBeVisible();
    await expect(page.getByTestId('my-question')).toHaveCount(0);
  });

  test('offers the link from the auth menu of a real account', async ({ page, firebase }) => {
    await createAuthor(firebase);
    await signIn(page, authorEmail());

    await openAuthMenu(page);
    await authMenu(page).getByTestId('auth-menu-my-questions-link').click();

    await expect(page).toHaveURL(/\/my-questions$/);
  });
});

/** The Pending / Approved / Rejected / Reports picker, by view rather than by label. */
function reviewTab(page: Page, view: 'pending' | 'approved' | 'rejected' | 'reports'): Locator {
  return page.locator(`[data-cy="review-tab"][data-status="${view}"]`);
}

/**
 * Starts a **Custom** game in one category. Not `startGame`, which uses the Open
 * Trivia source and never reads `custom_questions` at all — an assertion about
 * the bank after that would hold no matter what the draw did.
 *
 * The category is what makes it deterministic: `getCustomQuestions` filters on
 * it server-side, so a category only this test has written to holds only this
 * test's questions however busy the shared bank is.
 */
async function startCustomGame(page: Page, category: string): Promise<void> {
  await page.goto('/');
  await page.locator('#amount').selectOption({ label: '5' });
  // Retries until the stubbed category list has actually populated the picker,
  // which is the thing a wait on the categories request would be standing in
  // for.
  await page.locator('#category').selectOption(category);
  await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();
  await waitForPlayRoute(page);
}
