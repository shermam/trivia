import { Locator, Page } from '@playwright/test';
import { FirebaseBackend } from '../../fixtures/firebase-backend';
import { expect, test } from '../../fixtures/test';
import { signInViaUi } from '../../support/auth';
import { answerQuestion } from '../../support/game';
import { expectBoxUnmoved, expectNoSidewaysScroll, settledBox } from '../../support/layout';
import { stubOpenTrivia } from '../../support/open-trivia';
import { addQuestionTopic, runTag, startTopicGame } from '../../support/topics';

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
 * tag goes in the question text (so rows can be counted), the document ids and
 * the accounts, and every question carries a **topic** that exists for this
 * test alone — which is what makes the custom game below deterministic rather
 * than a draw from whatever the bank happens to hold (`e2e/support/topics.ts`).
 */
/**
 * Markup typed as text into a Markdown question — the lines of the sanitiser
 * payload `markdown-rendering.spec.ts` seeds, word for word, sentinel
 * included. Escaped, it is a run of long words with no break opportunity in
 * them, the shape that widened a review card past a 320px window.
 */
const FIRE = 'window.__xssFired = true';
const TYPED_MARKUP = [
  `<script>${FIRE}</script>`,
  `<img src=x onerror="${FIRE}">`,
  `<svg onload="${FIRE}"></svg>`,
  `<iframe src="data:text/html,<script>${FIRE}</script>"></iframe>`,
  `<form action="https://evil.example"><input name="p"><button>go</button></form>`,
  `<p style="position:fixed;inset:0;z-index:99">covering everything</p>`,
  `<math><mi href="//evil.example">m</mi><annotation-xml encoding="text/html"><img src=x onerror="${FIRE}"></annotation-xml></math>`,
  `<a href="javascript:${FIRE}">raw anchor</a>`,
  `[markdown link](javascript:${FIRE})`,
].join('\n');

/** One word longer than a phone's line, with nowhere to break it. */
const LONG_WORD = 'Pneumonoultramicroscopicsilicovolcanoconiosis';

test.describe('the review queue', () => {
  const password = 'Password123!';

  let tag: string;
  let topic: string;
  let pendingText: string;
  let approvedText: string;

  test.beforeEach(async ({ page, firebase }) => {
    tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    topic = runTag('review');
    pendingText = `Is this question waiting for review? (${tag})`;
    approvedText = `Is this question already live? (${tag})`;

    await stubOpenTrivia(page);
    await seedQuestions(firebase, { tag, topic, pendingText, approvedText });
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

  /**
   * The page fits its window, whichever tab is chosen. The four tabs in one
   * row are 382px, wider than a phone's content box, so below `sm` they are
   * two rows of two — and what a reader meets when they are not is the whole
   * page scrolling sideways, so that is what is measured: the document's width
   * against the window's, polled rather than read once (`CLAUDE.md` §4.6), on
   * every tab, each anchored on a row of this test's own having rendered. The
   * Reports tab carries a report whose detail is one unbroken 500-character
   * word, the longest the rules allow, which has to wrap inside its card. The
   * tabs are measured across all four choices too, because choosing one must
   * not resize the control just pressed (`CLAUDE.md` §4.4) — at 1280 as well,
   * where they are one row sized by their labels and a state that changed a
   * label's width would move its neighbours.
   *
   * Resized after signing in, not before: the auth menu has no business being
   * driven at a width it is not otherwise tested at, and `/review` is then
   * loaded fresh at the window's size.
   */
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    test(`fits a ${viewport.width}px window on every tab, without scrolling sideways`, async ({
      page,
      firebase,
    }) => {
      const rejectedText = `Was this question turned down? (${tag})`;
      const markupText = `Which markup was typed here? (${tag})`;
      const wordText = `Is ${LONG_WORD} one word? (${tag})`;
      await firebase.seedCustomQuestions([
        {
          id: `rejected-${tag}`,
          tags: [topic],
          type: 'multiple',
          difficulty: 'easy',
          question: rejectedText,
          correct_answer: 'Yes',
          incorrect_answers: ['No', 'Maybe', 'Unsure'],
          createdBy: 'someone-else',
          createdAt: Date.now(),
          status: 'rejected',
        },
        // Question text with words that cannot wrap, in both of the
        // renderer's branches: markup typed into a Markdown question, which is
        // a run of long unbroken words once escaped, and one long word in a
        // plain one. Both are approved, so the Approved tab carries them.
        {
          id: `approved-${tag}-markup`,
          tags: [topic],
          type: 'multiple',
          difficulty: 'easy',
          question: `${markupText}\n\n${TYPED_MARKUP}`,
          format: 'markdown',
          correct_answer: 'Yes',
          incorrect_answers: ['No', 'Maybe', 'Unsure'],
          createdBy: 'someone-else',
          createdAt: Date.now(),
          status: 'approved',
        },
        {
          id: `approved-${tag}-word`,
          tags: [topic],
          type: 'multiple',
          difficulty: 'easy',
          question: wordText,
          correct_answer: 'Yes',
          incorrect_answers: ['No', 'Maybe', 'Unsure'],
          createdBy: 'someone-else',
          createdAt: Date.now(),
          status: 'approved',
        },
      ]);
      // The ID keeps the `{window}-{slot}-{uid}` shape, in the current window,
      // so the report sorts onto the tab's first page.
      const now = Date.now();
      await firebase.seedQuestionReports([
        {
          id: `${Math.floor(now / 300_000)}-00-${tag}`,
          questionId: `pending-${tag}`,
          reason: 'other',
          detail: 'Unbrokenreportdetail'.repeat(25),
          reportedBy: `seed-${tag}`,
          createdAt: now,
        },
      ]);

      await signInAsReviewer(page, firebase);
      await page.setViewportSize(viewport);
      await page.goto('/review');
      await expect(myRows(page)).toHaveCount(1);
      await expect(reviewTab(page, 'pending')).toHaveAttribute('aria-checked', 'true');
      await expectNoSidewaysScroll(page, `/review's Pending tab at ${viewport.width}px`);

      // What each tab has to have rendered before its width means anything —
      // on Approved, the Markdown question as Markdown rather than the source
      // text the renderer shows until its engine arrives.
      const anchors: Record<'pending' | 'approved' | 'rejected' | 'reports', () => Promise<void>> =
        {
          approved: async () => {
            await expect(myRows(page).filter({ hasText: approvedText })).toHaveCount(1);
            await expect(myRows(page).filter({ hasText: wordText })).toHaveCount(1);
            await expect(
              myRows(page).filter({ hasText: markupText }).getByTestId('rendered-text').first(),
            ).toHaveAttribute('data-rendered', 'markdown');
          },
          rejected: async () => {
            await expect(myRows(page).filter({ hasText: rejectedText })).toHaveCount(1);
          },
          reports: async () => {
            await expect(
              page.getByTestId('review-report').filter({ hasText: pendingText }),
            ).toHaveCount(1);
          },
          pending: async () => {
            await expect(myRows(page).filter({ hasText: pendingText })).toHaveCount(1);
          },
        };
      const tabs = page.getByTestId('review-tabs');
      const box = await settledBox(tabs, `the tabs at ${viewport.width}px`);
      for (const view of ['approved', 'rejected', 'reports', 'pending'] as const) {
        await reviewTab(page, view).click();
        await expect(reviewTab(page, view)).toHaveAttribute('aria-checked', 'true');
        await anchors[view]();
        await expectNoSidewaysScroll(page, `/review's ${view} tab at ${viewport.width}px`);
        await expectBoxUnmoved(tabs, box, `the tabs with ${view} chosen, at ${viewport.width}px`);
      }
    });
  }

  /**
   * The answer almost every account gets, so it has to arrive as an answer and
   * not as an error. A role read that answers "no document" with a `404` puts
   * Chromium's own `Failed to load resource` line in the console on every page
   * load, whatever the app does with the result — which only a real browser
   * shows, and which Lighthouse no longer sees at all, because its anonymous
   * visitor is not read for (`docs/app.md` §1.4). So the read is pinned here: a
   * `batchGet` for this account's role that answers `200`, which is what keeps
   * it out of the console, since Chromium writes that line only for a response
   * with an error status.
   */
  test('hides the link from an account with no role document', async ({ page, firebase }) => {
    const email = `plain-${tag}@example.com`;
    await firebase.createVerifiedUser({ email, password, displayName: 'Plain' });
    await page.goto('/');
    const roleRead = page.waitForResponse(
      (response) =>
        response.url().includes('/documents:batchGet') &&
        (response.request().postData() ?? '').includes('/user_roles/'),
    );
    await signInViaUi(page, email, password);

    expect((await roleRead).status()).toBe(200);
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
    // ...and no way into everything one account contributed (`FEAT-006`): the
    // view is reached only from a card, and the rules refuse its read to
    // anybody who is not a reviewer regardless (`firestore-tests`).
    await expect(page.getByTestId('open-author-view')).toHaveCount(0);
    await expect(page.getByTestId('author-view')).toHaveCount(0);
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
    // Exactly one question under this topic is approved, so the game is
    // deterministic and the report is about a question this test owns.
    await startCustomGame(page, topic);
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
    await addQuestionTopic(page, topic);
    await page.locator('#question').fill(submittedText);
    await page.locator('#correctAnswer').fill('Jupiter');
    await page.getByPlaceholder('Incorrect answer 1', { exact: true }).fill('Mars');
    await page.getByPlaceholder('Incorrect answer 2', { exact: true }).fill('Venus');
    await page.getByPlaceholder('Incorrect answer 3', { exact: true }).fill('Saturn');
    await page.getByRole('button', { name: 'Add Question', exact: true }).click();
    await expect(page.getByText('submitted for review')).toBeVisible();

    // Not served while pending — the whole point of the feature. Exactly one
    // question under this test's topic is approved at this moment, so the game
    // is deterministic and the assertion below is about which question was
    // served, not about which of several happened to come up first.
    await startCustomGame(page, topic);
    await expect(page.getByText(approvedText)).toBeVisible();
    await expect(page.getByText(submittedText)).toHaveCount(0);

    await page.goto('/review');
    await expect(page.getByText(submittedText)).toBeVisible();
    // The topic arrived on the reviewer's card from what Firestore stored — the
    // only topic a contribution has, since there is no category to fall back
    // on (`FEAT-052`).
    await expect(
      page
        .getByTestId('review-question')
        .filter({ hasText: submittedText })
        .getByTestId('review-question-tags')
        .getByTestId('question-tag'),
    ).toHaveText([`#${topic}`]);
    await decideOn(page, submittedText, 'approve');

    // Reject the one that was already live, so that again exactly one question
    // is approved. That keeps the next game deterministic *and* proves the other
    // half in the same breath: rejecting takes a question out of play.
    await reviewTab(page, 'approved').click();
    await decideOn(page, approvedText, 'reject');

    await startCustomGame(page, topic);
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
    await startCustomGame(page, topic);

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
  ids: { tag: string; topic: string; pendingText: string; approvedText: string },
): Promise<void> {
  return firebase.seedCustomQuestions([
    {
      id: `pending-${ids.tag}`,
      tags: [ids.topic],
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
      tags: [ids.topic],
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
 * Starts a **Custom** game over this test's topic. Not `startGame`, which uses
 * the Open Trivia source and never reads `custom_questions` at all — a negative
 * assertion after that would hold no matter what the status filter did.
 *
 * The topic is what makes the draw deterministic: `getCustomQuestions` filters
 * on it in the query, so a tag only this test has written holds only this
 * test's questions however busy the shared bank is. Exactly one of them is
 * approved whenever a game starts here, so the setup screen offers that one and
 * the offer is accepted.
 */
async function startCustomGame(page: Page, topic: string): Promise<void> {
  await page.goto('/');
  await startTopicGame(page, { topics: [topic], found: 1 });
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
