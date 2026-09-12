import { Locator, Page } from '@playwright/test';
import { FirebaseBackend } from '../../fixtures/firebase-backend';
import { expect, test } from '../../fixtures/test';
import { signInViaUi } from '../../support/auth';
import { answerQuestion, optionLabel, waitForPlayRoute } from '../../support/game';
import { stubExtraCategory, stubOpenTrivia } from '../../support/open-trivia';

/**
 * The moderation role and queue, end to end (`BACKLOG.md` item 4b-ii).
 *
 * This is the layer neither the rules suite nor the unit specs can reach. The
 * rules tests prove `firestore.rules` refuses the right writes; the unit specs
 * prove the service sends the right ones. Only this proves that a role document
 * created out of band actually reaches `ReviewerService`, renders the link, and
 * that a decision made in the browser is accepted by the real rules — which is
 * the seam `AuthService` has already produced three bugs in.
 *
 * **Everything this file touches carries a per-test tag**, and that is the
 * whole of its isolation. Workers share one emulator, so `custom_questions`
 * holds every other test's contributions
 * and the queue lists all of them: a count of rows, a game drawn from the bank,
 * and an email address are all global unless the test makes them its own. The
 * tag goes in the question text (so rows can be counted), the document ids, the
 * accounts, and a **category** that exists for this test alone — which is what
 * makes the custom game below deterministic rather than a draw from whatever
 * the bank happens to hold.
 */
test.describe('the review queue', () => {
  const password = 'Password123!';

  let tag: string;
  let category: string;
  let pendingText: string;
  let approvedText: string;

  test.beforeEach(async ({ page, firebase }) => {
    tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    category = `Review ${tag}`;
    pendingText = `Is this question waiting for review? (${tag})`;
    approvedText = `Is this question already live? (${tag})`;

    await stubOpenTrivia(page);
    await stubExtraCategory(page, category);
    await seedQuestions(firebase, { tag, category, pendingText, approvedText });
  });

  /** The reviewer account for this test, with the role already granted. */
  async function signInAsReviewer(page: Page, firebase: FirebaseBackend): Promise<void> {
    const email = `reviewer-${tag}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Rev' });
    await firebase.seedReviewer({ uid, reviewer: true });
    await page.goto('/');
    await signInViaUi(page, email, password);
  }

  /** This test's own rows, as distinct from every other worker's. */
  function myRows(page: Page): Locator {
    return page.getByTestId('review-question').filter({ hasText: tag });
  }

  test('shows the link and the queue to a reviewer', async ({ page, firebase }) => {
    await signInAsReviewer(page, firebase);

    await expect(page.getByTestId('review-queue-link')).toBeVisible();
    await page.getByTestId('review-queue-link').click();
    await expect(page).toHaveURL(/\/review$/);
    await expect(page.getByText(pendingText)).toBeVisible();
    await expect(page.getByText(approvedText)).toHaveCount(0);
  });

  /**
   * Every button here is addressed by `data-cy`, never by its text, and that is
   * not stylistic. The first version of this test clicked a button *containing*
   * "Approve" — which matched the **"Approved" tab**, because "Approved"
   * contains "Approve" and the tab bar precedes the list in the DOM. It switched
   * tabs instead of approving anything, and the "no longer present" assertion
   * that followed then passed for entirely the wrong reason: the pending
   * question was absent because the *Approved* tab was showing, not because it
   * had been approved. Only the assertion after it failed, which is the sole
   * reason this was caught at all.
   */
  test('approves a pending question, and the decision survives a reload', async ({
    page,
    firebase,
  }) => {
    await signInAsReviewer(page, firebase);
    await page.goto('/review');

    await expect(myRows(page)).toHaveCount(1);
    await expect(page.getByText(pendingText)).toBeVisible();
    await myRows(page).getByTestId('approve-question').click();

    // Gone from Pending — and *both* of this test's questions are, rather than
    // merely the one string being absent. A globally empty tab would be the
    // stronger claim and a meaningless one against a shared bank: the rows this
    // test owns are the strongest form of it available here.
    await expect(myRows(page)).toHaveCount(0);

    // ...and the write actually landed, rather than only the row disappearing
    // from a list the browser was holding in memory.
    await reviewTab(page, 'approved').click();
    await expect(myRows(page)).toHaveCount(2);
    await expect(page.getByText(pendingText)).toBeVisible();

    await page.reload();
    await reviewTab(page, 'approved').click();
    await expect(page.getByText(pendingText)).toBeVisible();
  });

  test('hides the link from an account with no role document', async ({ page, firebase }) => {
    const email = `plain-${tag}@example.com`;
    await firebase.createVerifiedUser({ email, password, displayName: 'Plain' });
    await page.goto('/');
    await signInViaUi(page, email, password);

    await expect(page.getByTestId('review-queue-link')).toHaveCount(0);
  });

  // The H6 shape: a document that exists and says `false` is not a reviewer. A
  // truthiness or existence check would pass this and unlock a page whose
  // buttons the server is bound to refuse.
  test('hides the link from an account whose role document says false', async ({
    page,
    firebase,
  }) => {
    const email = `plain-${tag}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Plain' });
    await firebase.seedReviewer({ uid, reviewer: false });
    await page.goto('/');
    await signInViaUi(page, email, password);

    await expect(page.getByTestId('review-queue-link')).toHaveCount(0);
  });

  test('tells a non-reviewer who navigates straight to /review that it is not for them', async ({
    page,
    firebase,
  }) => {
    const email = `plain-${tag}@example.com`;
    await firebase.createVerifiedUser({ email, password, displayName: 'Plain' });
    await page.goto('/');
    await signInViaUi(page, email, password);
    await page.goto('/review');

    await expect(page.getByText('This page is for question reviewers')).toBeVisible();
    await expect(page.getByText(pendingText)).toHaveCount(0);
    // Not a tab in sight, the reports one included — so there is no control
    // offering a read `firestore.rules` would refuse anyway (`FEAT-026`).
    await expect(page.getByTestId('review-tab')).toHaveCount(0);
  });

  /**
   * `FEAT-026`, end to end: a player files a report and a reviewer acts on it.
   *
   * The whole point of the feature is the seam between those two people, and
   * this is the only test that crosses it. The rules suite proves the read is
   * refused for everyone but a reviewer; the unit specs prove the service drops
   * `reportedBy` and the component pairs each report with its question. None of
   * them can show that a report written by one session through the reporting
   * form is the one a *different* account reads back through the real rules.
   *
   * The reporter is the anonymous session every page load mints, because that
   * is who reports in practice (finding H4) — and it is also the strongest
   * version of the test, since an anonymous uid cannot be a reviewer and the
   * report is therefore unreadable by the account that filed it.
   */
  test('shows a filed report to a reviewer, who rejects the question from it', async ({
    page,
    firebase,
  }) => {
    // Exactly one question in this category is approved, so the game is
    // deterministic and the report is about a question this test owns.
    await startCustomGame(page, category);
    await answerQuestion(page, 'Yes');
    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByText('Game Over!').first()).toBeVisible();

    const questionId = `approved-${tag}`;
    const detail = `The answer is not Yes (${tag}).`;
    await page.getByTestId('open-report-dialog').click();
    await page.getByTestId(`report-question-${questionId}`).click();
    await page.getByRole('radio', { name: 'The answer is wrong', exact: true }).check();
    await page.locator('textarea[name="report-detail"]').fill(detail);
    await page.getByTestId(`send-report-${questionId}`).click();
    await expect(page.getByTestId(`reported-badge-${questionId}`)).toHaveText('Reported');

    // Whose report it is, read through the Admin SDK: the uid belongs to the
    // anonymous session and is not knowable from the browser afterwards, and
    // the reviewer's screen must not show it.
    const [filed] = await firebase.getQuestionReports([questionId]);
    expect(filed.reportedBy).toBeTruthy();

    await signInAsReviewer(page, firebase);
    await page.goto('/review');
    await reviewTab(page, 'reports').click();

    // Scoped to this test's own report. The emulator is shared, so the tab
    // lists every worker's complaints and a count of rows would be about all of
    // them.
    const row = page.getByTestId('review-report').filter({ hasText: tag });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('The answer is wrong');
    await expect(row).toContainText(detail);
    await expect(row).toContainText(approvedText);
    // The complaint, not the complainant.
    await expect(row).not.toContainText(filed.reportedBy);

    // The decision the report exists to prompt, made from the report itself.
    await row.getByTestId('reject-question').click();
    await expect(row.getByTestId('question-status')).toHaveText('rejected');
    // The report stays — it is the record that somebody complained, not a task
    // that has been ticked off.
    await expect(row).toHaveCount(1);

    // ...and the write landed under the real rules, rather than only the row
    // repainting from memory.
    await reviewTab(page, 'rejected').click();
    await expect(page.getByText(approvedText)).toBeVisible();
  });

  /**
   * Paging the reports tab, against a real Firestore.
   *
   * This is the half of the cursor no unit test can reach: whether a
   * `__name__`-descending query with an inclusive `startAt` actually returns
   * the next page. A faked `runQuery` proves the arguments and nothing about
   * what Firestore does with them.
   *
   * **The seeds are backdated on purpose.** The queue orders by `createdAt`
   * descending, so timestamps an hour old put all of them *below* anything
   * another worker files during the run — which is what keeps this test from
   * pushing other specs' reports off their own first page, and what makes its
   * own assertions independent of how many other reports exist.
   *
   * `PAGE` mirrors `REPORTS_PAGE_SIZE` in `reviewer.service.ts` deliberately
   * rather than importing it: e2e specs compile under their own tsconfig and
   * none of them reaches into `src/`. If the two drift, the last assertion
   * fails loudly — which is the point of writing `PAGE + 1` seeds.
   */
  test('pages the reports tab with a cursor, keeping the rows already read', async ({
    page,
    firebase,
  }) => {
    const PAGE = 25;
    const backdated = Date.now() - 3_600_000;
    const seeded = Array.from({ length: PAGE + 1 }, (_, index) => ({
      // Report 0 is the oldest, report 25 the newest — the order the
      // assertions below reason about. The ID keeps the `{window}-{slot}-{uid}`
      // shape a real report has, though nothing here depends on it.
      id: `${Math.floor(backdated / 300_000)}-${String(index).padStart(2, '0')}-${tag}`,
      questionId: `approved-${tag}`,
      reason: 'spam' as const,
      detail: `Seeded report ${index} (${tag})`,
      reportedBy: `seed-${tag}`,
      createdAt: backdated + index,
    }));
    await firebase.seedQuestionReports(seeded);

    await signInAsReviewer(page, firebase);
    await page.goto('/review');
    await reviewTab(page, 'reports').click();

    const mine = page.getByTestId('review-report').filter({ hasText: tag });
    const newest = page.getByTestId('review-report').filter({ hasText: `report ${PAGE} (${tag})` });
    const oldest = page.getByTestId('review-report').filter({ hasText: `report 0 (${tag})` });

    // The oldest of the 26 cannot be on a 25-row first page, whatever else the
    // emulator holds: this test's own 25 newer reports sort above it.
    await expect(newest).toHaveCount(1);
    await expect(oldest).toHaveCount(0);

    await page.getByTestId('show-more-reports').click();

    // All 26, once — the rows already read are kept rather than replaced, and
    // the cursor's own row is not repeated, which an inclusive `startAt` does
    // by default.
    await expect(oldest).toHaveCount(1);
    await expect(newest).toHaveCount(1);
    await expect(mine).toHaveCount(PAGE + 1);
  });

  /**
   * Item 4c end to end, and the only test that covers the whole promise: a
   * contribution is stored, is *not* served, appears in the queue, and starts
   * being served the moment it is approved.
   *
   * The rules half is covered by the rules suite and the service half by the
   * unit specs, but neither can see the seam — that the status the client writes
   * on submit is the same one the queue filters on, and that the game's query
   * starts matching once a reviewer moves it.
   */
  test('takes a real submission through review and into a game', async ({ page, firebase }) => {
    const email = `reviewer-${tag}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Rev' });
    await firebase.seedReviewer({ uid, reviewer: true });
    await firebase.setProSubscription({ uid });
    await page.goto('/');
    await signInViaUi(page, email, password);

    const submittedText = `Which planet has the Great Red Spot? (${tag})`;
    await page.goto('/add-question');
    await page.locator('#category').fill(category);
    await page.locator('#question').fill(submittedText);
    await page.locator('#correctAnswer').fill('Jupiter');
    await page.getByPlaceholder('Incorrect answer 1', { exact: true }).fill('Mars');
    await page.getByPlaceholder('Incorrect answer 2', { exact: true }).fill('Venus');
    await page.getByPlaceholder('Incorrect answer 3', { exact: true }).fill('Saturn');
    await page.getByRole('button', { name: 'Add Question', exact: true }).click();
    await expect(page.getByText('submitted for review')).toBeVisible();

    // Not served while pending — the whole point of the feature. Exactly one
    // question in this test's category is approved at this moment, so the game
    // is deterministic and the assertion below is about which question was
    // served, not about which of several happened to come up first.
    await startCustomGame(page, category);
    await expect(page.getByText(approvedText)).toBeVisible();
    await expect(page.getByText(submittedText)).toHaveCount(0);

    await page.goto('/review');
    await expect(page.getByText(submittedText)).toBeVisible();
    await decideOn(page, submittedText, 'approve');

    // Reject the one that was already live, so that again exactly one question
    // is approved. That keeps the next game deterministic *and* proves the other
    // half in the same breath: rejecting takes a question out of play.
    await reviewTab(page, 'approved').click();
    await decideOn(page, approvedText, 'reject');

    await startCustomGame(page, category);
    await expect(page.getByText(submittedText)).toBeVisible();
    await expect(page.getByText(approvedText)).toHaveCount(0);
  });

  test('never serves an unapproved question to a player', async ({ page }) => {
    // The client half of review-before-publish. The rule is still open for one
    // release, so this filter is the only thing keeping a pending question out
    // of a game — which makes it worth an e2e row of its own.
    //
    // It has to be a **Custom** game. `startGame` uses the Open Trivia source,
    // which never touches `custom_questions` at all, so the negative assertion
    // below would hold no matter what the filter did.
    await startCustomGame(page, category);

    // The positive control, and the reason this test is not vacuous: the
    // approved question really is being served from the bank. Without it a
    // custom game that failed to start at all would pass the assertion that
    // follows.
    await expect(page.getByText(approvedText)).toBeVisible();
    await expect(page.getByText(pendingText)).toHaveCount(0);
  });
});

function seedQuestions(
  firebase: FirebaseBackend,
  ids: { tag: string; category: string; pendingText: string; approvedText: string },
): Promise<void> {
  return firebase.seedCustomQuestions([
    {
      id: `pending-${ids.tag}`,
      category: ids.category,
      type: 'multiple',
      difficulty: 'easy',
      question: ids.pendingText,
      correct_answer: 'Yes',
      incorrect_answers: ['No', 'Maybe', 'Unsure'],
      createdBy: 'someone-else',
      createdAt: Date.now(),
      status: 'pending',
    },
    {
      id: `approved-${ids.tag}`,
      category: ids.category,
      type: 'multiple',
      difficulty: 'easy',
      question: ids.approvedText,
      correct_answer: 'Yes',
      incorrect_answers: ['No', 'Maybe', 'Unsure'],
      createdBy: 'someone-else',
      createdAt: Date.now(),
      status: 'approved',
    },
  ]);
}

/**
 * Starts a **Custom** game in one category. Not `startGame`, which uses the Open
 * Trivia source and never reads `custom_questions` at all — a negative assertion
 * after that would hold no matter what the status filter did.
 *
 * The category is what makes the draw deterministic: `getCustomQuestions` filters
 * on it server-side, so a category only this test has written to holds only this
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

/** The Pending / Approved / Rejected / Reports picker, by view rather than by label. */
function reviewTab(page: Page, view: 'pending' | 'approved' | 'rejected' | 'reports'): Locator {
  return page.locator(`[data-cy="review-tab"][data-status="${view}"]`);
}

/**
 * Acts on the queue row containing `text`.
 *
 * Scoped to the row and addressed by `data-cy` on purpose: a button matched by
 * the substring "Approve" is the **"Approved" tab**, which precedes the list in
 * the DOM. That shipped once and made a "no longer present" assertion pass for
 * the wrong reason.
 */
async function decideOn(page: Page, text: string, decision: 'approve' | 'reject'): Promise<void> {
  const row = page.getByTestId('review-question').filter({ hasText: text });
  await expect(row).toHaveCount(1);
  await row.getByTestId(`${decision}-question`).click();
}
