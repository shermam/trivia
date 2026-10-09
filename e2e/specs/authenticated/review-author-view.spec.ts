import { Locator, Page, Route } from '@playwright/test';
import { FirebaseBackend } from '../../fixtures/firebase-backend';
import { CustomQuestionSeed } from '../../fixtures/types';
import { expect, test } from '../../fixtures/test';
import { signInViaUi } from '../../support/auth';
import { expectBoxUnmoved, settledBox } from '../../support/layout';

/**
 * Everything one account contributed, for a reviewer (`FEAT-006`), end to end.
 *
 * The seams only this layer reaches: that a card's "Everything this account
 * contributed" really reads that account's questions through the real rules
 * as a reviewer; that a bulk rejection lands under the reviewer's update rule
 * one document at a time, partial failure included; that the uid the read is
 * filtered on never reaches the screen; that focus goes where it should on
 * the way in, across pages and on the way back; and that nothing moves while
 * the read and the action land — jsdom has no layout, and Lighthouse never
 * visits `/review`.
 *
 * **Isolation is the author.** Every question here is seeded under an author
 * uid minted for the test, and the view lists that author's questions and
 * nobody else's, so a count of rows is about this test however busy the
 * shared emulator is. The reviewer is a fresh account per test, too.
 *
 * Emulator-only, like the rest of `authenticated/` that is not listed in
 * `playwright.preview.config.ts`: it writes rejections and reports no sweep
 * tracks.
 */

const password = 'Password123!';

/** A pending question by `createdBy`, its text carrying the test's tag so a row can be found by it. */
function seedQuestion(
  id: string,
  createdBy: string,
  text: string,
  overrides: Partial<CustomQuestionSeed> = {},
): CustomQuestionSeed {
  return {
    id,
    tags: ['abuse-tooling'],
    type: 'multiple',
    difficulty: 'easy',
    question: text,
    correct_answer: 'Yes',
    incorrect_answers: ['No', 'Maybe', 'Unsure'],
    createdBy,
    createdAt: Date.now(),
    status: 'pending',
    ...overrides,
  };
}

async function signInAsReviewer(page: Page, firebase: FirebaseBackend, tag: string): Promise<void> {
  const email = `reviewer-${tag}@example.com`;
  const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Rev' });
  await firebase.seedReviewer({ uid, reviewer: true });
  await page.goto('/');
  await signInViaUi(page, email, password);
}

/** The queue card carrying `text`, in whichever list is showing. */
function queueCard(page: Page, text: string): Locator {
  return page.getByTestId('review-question').filter({ hasText: text });
}

/** One row of the per-author view, by its question's text. */
function authorRow(page: Page, text: string): Locator {
  return page.getByTestId('author-question').filter({ hasText: text });
}

function pill(row: Locator): Locator {
  return row.getByTestId('author-question-status');
}

function reviewTab(page: Page, view: 'pending' | 'approved' | 'rejected' | 'reports'): Locator {
  return page.locator(`[data-cy="review-tab"][data-status="${view}"]`);
}

/**
 * Counts the question writes the page sends, by document — what proves a bulk
 * action is one write per selected question, and that a refused submit sent
 * none. Counted at the request rather than read back, because a write that was
 * never sent and one that has not landed yet look the same in the database.
 */
function countQuestionWrites(page: Page): Map<string, number> {
  const writes = new Map<string, number>();
  page.on('request', (request) => {
    const match = /\/custom_questions\/([^/?]+)\?/.exec(request.url());
    if (request.method() === 'PATCH' && match) {
      writes.set(match[1], (writes.get(match[1]) ?? 0) + 1);
    }
  });
  return writes;
}

/** The questions this author has in the bank, keyed by id, read through the Admin SDK. */
async function storedById(
  firebase: FirebaseBackend,
  author: string,
): Promise<Record<string, Record<string, unknown>>> {
  const stored = await firebase.getContributedQuestions(author);
  return Object.fromEntries(stored.map((question) => [question['id'] as string, question]));
}

test.describe('everything one account contributed, as a reviewer', () => {
  /**
   * Wide, and tall enough to leave the page room to move: `/review` is not
   * vertically centred, so a shift here is a direct one, and a viewport this
   * size lets every box under the action be measured on screen.
   */
  test.use({ viewport: { width: 1024, height: 900 } });

  /**
   * The spec's end-to-end row — from a queued question to its author's set and
   * back — with everything that happens on the way: the read, the uid kept off
   * the screen, a refused submit, the bulk rejection landing under the real
   * rules, nothing moving while it does, and focus on the way back.
   */
  test('opens an account from a queued question, rejects the set with a reason, and comes back', async ({
    page,
    firebase,
  }) => {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const author = `author-${tag}`;
    const now = Date.now();
    const pendingText = `Is this the account's newest question? (${tag})`;
    const approvedText = `Is this one of theirs already live? (${tag})`;
    const rejectedText = `Was this one of theirs already turned down? (${tag})`;
    const otherText = `Is this somebody else's question? (${tag})`;
    await firebase.seedCustomQuestions([
      seedQuestion(`author-pending-${tag}`, author, pendingText, { createdAt: now }),
      seedQuestion(`author-approved-${tag}`, author, approvedText, {
        status: 'approved',
        createdAt: now - 1000,
      }),
      // Already rejected, with a note its author has been shown — which the
      // action must leave alone: it is not selectable, so nothing overwrites it.
      seedQuestion(`author-rejected-${tag}`, author, rejectedText, {
        status: 'rejected',
        rejectionReason: 'Too vague to approve.',
        createdAt: now - 2000,
      }),
      seedQuestion(`other-pending-${tag}`, `someone-else-${tag}`, otherText, { createdAt: now }),
    ]);

    await signInAsReviewer(page, firebase, tag);
    // Through the link rather than a reload: the role read the sign-in just
    // started is what renders the link, and reloading under it aborts that
    // read, which `ReviewerService` reports as a console error — on the setup
    // screen, before anything this test is about.
    await page.getByTestId('review-queue-link').click();
    await expect(page).toHaveURL(/\/review$/);
    const opener = queueCard(page, pendingText).getByTestId('open-author-view');
    await expect(opener).toBeVisible();

    // From here to the end — the view, its read, a refused submit, the
    // action and the way back — nothing may log an error.
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(`console: ${message.text()} @ ${message.location().url}`);
      }
    });
    const writes = countQuestionWrites(page);

    // The read is held open, so the loading face can be measured rather than
    // raced: against the emulator it lasts a few milliseconds.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let markSeen!: () => void;
    const seen = new Promise<void>((resolve) => (markSeen = resolve));
    let held = 0;
    await page.route(/\/documents:runQuery/, async (route: Route) => {
      const body = route.request().postData() ?? '';
      if (body.includes('createdBy') && body.includes(author)) {
        held++;
        markSeen();
        await released;
      }
      await route.continue();
    });

    await opener.click();
    await seen;
    const heading = page.getByTestId('author-view-heading');
    await expect(heading).toBeFocused();
    await expect(page.getByTestId('author-loading')).toBeVisible();
    await expect(page.getByTestId('review-queue-body')).toBeHidden();
    const status = page.getByTestId('author-status');
    const statusWhileLoading = await settledBox(status, 'the status block while loading');
    const headingWhileLoading = await settledBox(heading, 'the heading while loading');

    release();
    await expect(page.getByTestId('author-summary')).toHaveText('3 contributions, newest first.');
    expect(held).toBe(1);
    await expectBoxUnmoved(status, statusWhileLoading, 'the status block when the read lands');
    await expectBoxUnmoved(heading, headingWhileLoading, 'the heading when the read lands');
    await page.unroute(/\/documents:runQuery/);

    // This account's three, newest first, and not the other author's.
    const rows = page.getByTestId('author-question');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText(pendingText);
    await expect(rows.nth(1)).toContainText(approvedText);
    await expect(rows.nth(2)).toContainText(rejectedText);
    await expect(authorRow(page, otherText)).toHaveCount(0);
    await expect(pill(rows.nth(0))).toHaveAttribute('data-status', 'pending');
    await expect(pill(rows.nth(1))).toHaveAttribute('data-status', 'approved');
    await expect(pill(rows.nth(2))).toHaveAttribute('data-status', 'rejected');
    // Named by a question, never by the uid the read was filtered on
    // (`FEAT-006` §0) — the hidden queue's cards carry it, so the assertion is
    // scoped to the view.
    await expect(page.getByTestId('author-view')).not.toContainText(author);
    await expect(page.getByTestId('author-view-anchor')).toContainText(pendingText);

    // Select-all takes the two that can be rejected and not the one that is.
    const selectAll = page.getByRole('checkbox', { name: 'Select all on this page', exact: true });
    await selectAll.check();
    await expect(page.getByTestId('selection-count')).toBeVisible();
    await expect(page.getByTestId('selection-count')).toHaveText('2 of 2 selected');
    await expect(
      page.getByRole('checkbox', { name: 'Select question 1', exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole('checkbox', { name: 'Select question 2', exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole('checkbox', { name: 'Select question 3', exact: true }),
    ).toBeDisabled();

    // No reason, no write: the field says so, is marked invalid, and has focus.
    // The error lands in a line reserved for it from the first frame, so the
    // button just pressed and the rows under it stay put (`CLAUDE.md` §4.4).
    const reject = page.getByTestId('bulk-reject');
    const reason = page.getByTestId('bulk-reason');
    const beforeRefusal = {
      reject: await settledBox(reject, 'the Reject button before a refused submit'),
      first: await settledBox(rows.nth(0), 'the first row before a refused submit'),
    };
    await reject.click();
    await expect(page.getByTestId('bulk-reason-error')).toHaveText(
      'Give a reason — it is shown to the author on every question this rejects.',
    );
    await expect(reason).toHaveAttribute('aria-invalid', 'true');
    await expect(reason).toBeFocused();
    await expectBoxUnmoved(
      reject,
      beforeRefusal.reject,
      'the Reject button when the error appears',
    );
    await expectBoxUnmoved(
      rows.nth(0),
      beforeRefusal.first,
      'the first row when the error appears',
    );
    expect([...writes.keys()]).toEqual([]);

    // Typing the reason clears the error, in place, before the measured
    // action, so what is measured below is the action landing and nothing else.
    const note = `This account is posting spam (${tag}).`;
    await reason.fill(note);
    await expect(page.getByTestId('bulk-reason-error')).toHaveCount(0);
    await expectBoxUnmoved(reject, beforeRefusal.reject, 'the Reject button when the error clears');
    const boxes = {
      bar: page.getByTestId('bulk-bar'),
      first: rows.nth(0),
      last: rows.nth(2),
    };
    const before = {
      bar: await settledBox(boxes.bar, 'the bulk bar'),
      first: await settledBox(boxes.first, 'the first row'),
      last: await settledBox(boxes.last, 'the last row'),
    };

    await reject.click();
    await expect(page.getByTestId('selection-outcome')).toHaveText('Rejected 2 questions.');
    await expect(page.getByTestId('author-announcement')).toHaveText('Rejected 2 questions.');
    await expect(pill(rows.nth(0))).toHaveAttribute('data-status', 'rejected');
    await expect(pill(rows.nth(1))).toHaveAttribute('data-status', 'rejected');
    await expect(reject).toBeFocused();
    for (const key of ['bar', 'first', 'last'] as const) {
      await expectBoxUnmoved(boxes[key], before[key], `the ${key} box when the action lands`);
    }

    // One write per selected question, and none to the one that was already
    // rejected — which kept the note its author has been shown. The writes
    // landed under the real rules.
    expect(Object.fromEntries(writes)).toEqual({
      [`author-pending-${tag}`]: 1,
      [`author-approved-${tag}`]: 1,
    });
    const stored = await storedById(firebase, author);
    expect(stored[`author-pending-${tag}`]).toMatchObject({
      status: 'rejected',
      rejectionReason: note,
    });
    expect(stored[`author-approved-${tag}`]).toMatchObject({
      status: 'rejected',
      rejectionReason: note,
    });
    expect(stored[`author-rejected-${tag}`]).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Too vague to approve.',
    });

    // Back to Pending: the rejected question is gone from it without a reload,
    // and focus — whose button left with its row — lands on the tab.
    await page.getByTestId('close-author-view').click();
    await expect(page.getByTestId('author-view')).toHaveCount(0);
    await expect(reviewTab(page, 'pending')).toBeFocused();
    await expect(queueCard(page, otherText)).toBeVisible();
    await expect(queueCard(page, pendingText)).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  /**
   * Entered from a report, and a partial failure reported as one.
   *
   * One write is refused on the wire, so the set comes back as one success
   * and one failure — the spec's acceptance row — and the failure stays
   * selected, so pressing Reject again is the retry. The report row then shows
   * its question's new status, and focus returns to the button in that row,
   * which is still there because a report is never dropped.
   */
  test('opens an account from a report, and says honestly when part of the set did not land', async ({
    page,
    firebase,
  }) => {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const author = `author-${tag}`;
    const now = Date.now();
    const reportedText = `Is this the question somebody reported? (${tag})`;
    const siblingText = `Is this another of the same account's? (${tag})`;
    const reportedId = `reported-${tag}`;
    const siblingId = `sibling-${tag}`;
    await firebase.seedCustomQuestions([
      seedQuestion(reportedId, author, reportedText, { status: 'approved', createdAt: now }),
      seedQuestion(siblingId, author, siblingText, { status: 'approved', createdAt: now - 1000 }),
    ]);
    // Half an hour old, so it sits among the first page of the reports tab
    // without being the newest complaint another worker's spec is looking for.
    const filedAt = now - 1_800_000;
    await firebase.seedQuestionReports([
      {
        id: `${Math.floor(filedAt / 300_000)}-0-${tag}`,
        questionId: reportedId,
        reason: 'spam',
        detail: `Spam from this account (${tag})`,
        reportedBy: `reporter-${tag}`,
        createdAt: filedAt,
      },
    ]);

    await signInAsReviewer(page, firebase, tag);
    await page.goto('/review');
    await reviewTab(page, 'reports').click();
    const reportRow = page.getByTestId('review-report').filter({ hasText: tag });
    await expect(reportRow).toHaveCount(1);
    const opener = reportRow.getByTestId('open-author-view');

    await opener.click();
    await expect(page.getByTestId('author-view-heading')).toBeFocused();
    await expect(page.getByTestId('close-author-view')).toHaveText(/Back to Reports/);
    await expect(page.getByTestId('author-question')).toHaveCount(2);

    // The sibling's write is refused on the wire. The handler counts its own
    // hits, so a route that stopped matching fails here instead of letting the
    // test pass against a set that simply all landed.
    let refused = 0;
    await page.route(new RegExp(`/custom_questions/${siblingId}\\?`), async (route) => {
      if (route.request().method() === 'PATCH') {
        refused++;
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.getByRole('checkbox', { name: 'Select all on this page', exact: true }).check();
    await page.getByTestId('bulk-reason').fill(`Spam account (${tag}).`);
    await page.getByTestId('bulk-reject').click();

    await expect(page.getByTestId('selection-outcome')).toHaveText(
      'Rejected 1 of 2. 1 could not be confirmed and is still selected — try again.',
    );
    expect(refused).toBe(1);
    await expect(pill(authorRow(page, reportedText))).toHaveAttribute('data-status', 'rejected');
    await expect(pill(authorRow(page, siblingText))).toHaveAttribute('data-status', 'approved');
    await expect(
      page.getByRole('checkbox', { name: 'Select question 2', exact: true }),
    ).toBeChecked();
    let stored = await storedById(firebase, author);
    expect(stored[reportedId]['status']).toBe('rejected');
    expect(stored[siblingId]['status']).toBe('approved');

    // The retry is the same button, on what is still selected.
    await page.unroute(new RegExp(`/custom_questions/${siblingId}\\?`));
    await page.getByTestId('bulk-reject').click();
    await expect(page.getByTestId('selection-outcome')).toHaveText('Rejected 1 question.');
    await expect(pill(authorRow(page, siblingText))).toHaveAttribute('data-status', 'rejected');
    stored = await storedById(firebase, author);
    expect(stored[siblingId]).toMatchObject({
      status: 'rejected',
      rejectionReason: `Spam account (${tag}).`,
    });

    // The report stays and shows what became of its question; focus goes back
    // to the button in it.
    await page.getByTestId('close-author-view').click();
    await expect(reportRow.getByTestId('question-status')).toHaveText('rejected');
    await expect(opener).toBeFocused();
  });
});

test.describe('everything one account contributed, a page at a time', () => {
  /**
   * A phone, where wrapping is likeliest: a status pill that changed width, or
   * an outcome line that grew, would re-wrap rows here first.
   */
  test.use({ viewport: { width: 390, height: 1000 } });

  /**
   * Fifty-one questions by one account: a full first page and one more.
   *
   * **What this pins** is the bound the design rests on — select-all takes the
   * page and nothing past it, so one action names at most fifty — plus the
   * cursor against a real query engine (the half no unit test can reach),
   * focus across pages, and fifty rows changing status at once without
   * anything moving.
   *
   * **The ids are chosen for the other specs' sake.** The status tabs list the
   * first fifty questions in a status by document id, and `review-queue`
   * counts rows in them on the assumption that the suite holds fewer than
   * fifty per status. Fifty of these ids start `zzzz`, after every
   * Firestore auto-id and every other spec's seed, so they can never push
   * another spec's row off a tab's first page. The one the view is opened
   * from starts with a digit, so it is on that page itself.
   */
  test('pages fifty at a time, never selects past the page, and moves nothing when fifty land', async ({
    page,
    firebase,
  }) => {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const author = `author-${tag}`;
    const base = Date.now() - 3_600_000;
    const anchorText = `Where the reviewer starts (${tag})`;
    const seeds = [
      seedQuestion(`0-anchor-${tag}`, author, anchorText, { createdAt: base + 50 }),
      ...Array.from({ length: 50 }, (_, index) =>
        seedQuestion(
          `zzzz-${tag}-${String(index).padStart(2, '0')}`,
          author,
          `Bulk question ${String(index).padStart(2, '0')} (${tag})`,
          { createdAt: base + index },
        ),
      ),
    ];
    await firebase.seedCustomQuestions(seeds);

    await signInAsReviewer(page, firebase, tag);
    await page.goto('/review');
    const writes = countQuestionWrites(page);
    await queueCard(page, anchorText).getByTestId('open-author-view').click();

    const rows = page.getByTestId('author-question');
    await expect(page.getByTestId('author-summary')).toHaveText(
      'Page 1: 50 contributions, newest first.',
    );
    await expect(rows).toHaveCount(50);
    await expect(rows.nth(0)).toContainText(anchorText);
    await expect(authorRow(page, `Bulk question 00 (${tag})`)).toHaveCount(0);

    await page.getByRole('checkbox', { name: 'Select all on this page', exact: true }).check();
    await expect(page.getByTestId('selection-count')).toHaveText('50 of 50 selected');
    await page.getByTestId('bulk-reason').fill(`Spam account (${tag}).`);

    const boxes = {
      line: page.getByTestId('selection-line'),
      first: rows.nth(0),
      last: rows.nth(49),
    };
    const before = {
      line: await settledBox(boxes.line, 'the selection line'),
      first: await settledBox(boxes.first, 'the first row'),
      last: await settledBox(boxes.last, 'the fiftieth row'),
    };

    await page.getByTestId('bulk-reject').click();
    await expect(page.getByTestId('selection-outcome')).toHaveText('Rejected 50 questions.');
    for (const key of ['line', 'first', 'last'] as const) {
      await expectBoxUnmoved(boxes[key], before[key], `the ${key} box when fifty land`);
    }

    // Fifty writes, one to each question on the page, and none past it.
    expect(writes.size).toBe(50);
    expect([...writes.values()].every((count) => count === 1)).toBe(true);
    expect(writes.has(`zzzz-${tag}-00`)).toBe(false);
    const stored = Object.values(await storedById(firebase, author));
    expect(stored.filter((question) => question['status'] === 'rejected')).toHaveLength(50);
    expect(
      stored
        .filter((question) => question['status'] === 'pending')
        .map((question) => question['id']),
    ).toEqual([`zzzz-${tag}-00`]);

    // The fifty-first is on its own page, read from the cursor; focus is on
    // the status block that says which page arrived, since the button pressed
    // is disabled while the page loads; and the selection did not come along.
    await page.getByTestId('author-older').click();
    await expect(page.getByTestId('author-summary')).toHaveText(
      'Page 2: 1 contribution, newest first.',
    );
    await expect(page.getByTestId('author-status')).toBeFocused();
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText(`Bulk question 00 (${tag})`);
    await expect(page.getByTestId('selection-count')).toHaveText('0 of 1 selected');

    // Back to the first page, read again from the server: all fifty are
    // rejected now, so nothing on it can be selected.
    await page.getByTestId('author-newer').click();
    await expect(page.getByTestId('author-summary')).toHaveText(
      'Page 1: 50 contributions, newest first.',
    );
    await expect(page.getByTestId('selection-nothing')).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: 'Select all on this page', exact: true }),
    ).toBeDisabled();
  });
});
