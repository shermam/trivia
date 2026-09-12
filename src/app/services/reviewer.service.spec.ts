import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AuthService } from './auth.service';
import { FirestoreRestClient, RestDocument } from './firestore-rest/firestore-rest.client';
import { REPORTS_PAGE_SIZE, ReviewerService } from './reviewer.service';

/**
 * `ReviewerService` decides whether the review link and page render. It is UX
 * and carries no authority — `firestore.rules` is what refuses a non-reviewer's
 * write — but H6 is the standing lesson that a client signal which is *broader*
 * than the server's gate is still a real bug: it unlocks a screen the server is
 * bound to refuse, which the user experiences as a page whose buttons never
 * work. The `reviewer: false` case below is the row that pins the strict half,
 * the same way `subscription.service.spec.ts` pins `role: null`.
 */

interface FakeUser {
  uid: string;
}

function setup(document: unknown, options: { throws?: boolean } = {}) {
  const user = signal<FakeUser | null>(null);
  const paths: string[] = [];
  /**
   * Resolvers keyed by the path that was read, so a test can answer one
   * account's in-flight read and leave another's outstanding. Keeping a single
   * resolver would let the second read overwrite the first, and the
   * stale-answer test below would then pass for the wrong reason — it would be
   * asserting on the *current* account's answer, which is exactly the thing it
   * is supposed to prove cannot happen.
   */
  const pending = new Map<string, (value: unknown) => void>();
  let deferred = false;

  const getDocument = vi.fn((path: string) => {
    paths.push(path);
    if (options.throws) {
      return Promise.reject(new Error('boom'));
    }
    if (deferred) {
      return new Promise((resolve) => pending.set(path, resolve));
    }
    return Promise.resolve(document);
  });

  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: { user } },
      { provide: FirestoreRestClient, useValue: { getDocument } },
    ],
  });

  const service = TestBed.inject(ReviewerService);
  return {
    service,
    user,
    paths,
    getDocument,
    defer: () => {
      deferred = true;
    },
    /** Answers the outstanding read for exactly one account. */
    release: (uid: string, value: unknown) => pending.get(`user_roles/${uid}`)?.(value),
    flush: async () => {
      TestBed.tick();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('ReviewerService', () => {
  it('reports a granted reviewer', async () => {
    const h = setup({ data: { reviewer: true } });
    h.user.set({ uid: 'rev' });
    await h.flush();

    expect(h.service.isReviewer()).toBe(true);
    expect(h.service.isResolved()).toBe(true);
  });

  it('reads the caller own document, never a path derived from anything else', async () => {
    const h = setup({ data: { reviewer: true } });
    h.user.set({ uid: 'rev' });
    await h.flush();

    expect(h.paths).toEqual(['user_roles/rev']);
  });

  // The strict half. An existing document that says false is not a reviewer,
  // and must not be mistaken for one by a truthiness or existence check —
  // exactly the shape of the bug H6 shipped.
  it('reports an account whose document says reviewer: false as not a reviewer', async () => {
    const h = setup({ data: { reviewer: false } });
    h.user.set({ uid: 'demoted' });
    await h.flush();

    expect(h.service.isReviewer()).toBe(false);
    expect(h.service.isResolved()).toBe(true);
  });

  it('reports a non-boolean reviewer value as not a reviewer', async () => {
    const h = setup({ data: { reviewer: 'yes' } });
    h.user.set({ uid: 'sneaky' });
    await h.flush();

    expect(h.service.isReviewer()).toBe(false);
  });

  it('reports an account with no role document as not a reviewer', async () => {
    const h = setup(null);
    h.user.set({ uid: 'nobody' });
    await h.flush();

    expect(h.service.isReviewer()).toBe(false);
    expect(h.service.isResolved()).toBe(true);
  });

  it('treats a failed read as not a reviewer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = setup(null, { throws: true });
    h.user.set({ uid: 'rev' });
    await h.flush();

    // The safe direction: a reviewer who has to reload, never a non-reviewer
    // handed a page the server would refuse.
    expect(h.service.isReviewer()).toBe(false);
  });

  it('does not read anything while signed out', async () => {
    const h = setup({ data: { reviewer: true } });
    await h.flush();

    expect(h.getDocument).not.toHaveBeenCalled();
    expect(h.service.isReviewer()).toBe(false);
    expect(h.service.isResolved()).toBe(true);
  });

  it('clears the role on sign-out rather than leaving the last answer behind', async () => {
    const h = setup({ data: { reviewer: true } });
    h.user.set({ uid: 'rev' });
    await h.flush();
    expect(h.service.isReviewer()).toBe(true);

    h.user.set(null);
    await h.flush();

    expect(h.service.isReviewer()).toBe(false);
  });

  // The whole reason this is a document and not a claim is that revocation
  // takes effect immediately. A signal that keeps the old answer after the
  // account changes would hand that back.
  it('does not let a read in flight answer for a different account', async () => {
    const h = setup(null);
    h.defer();
    h.user.set({ uid: 'rev' });
    await h.flush();

    // The reviewer signs out and another account signs in. Only *then* does the
    // first account's read come back saying "yes, a reviewer" — for a user who
    // is no longer signed in.
    h.user.set({ uid: 'someone-else' });
    await h.flush();
    h.release('rev', { data: { reviewer: true } });
    await h.flush();

    expect(h.service.isReviewer()).toBe(false);

    // And the answer that does belong to the current account still lands.
    h.release('someone-else', null);
    await h.flush();
    expect(h.service.isReviewer()).toBe(false);
    expect(h.service.isResolved()).toBe(true);
  });

  it('is unresolved until the register has actually answered', async () => {
    const h = setup(null);
    h.defer();
    h.user.set({ uid: 'rev' });
    await h.flush();

    expect(h.service.isResolved()).toBe(false);
  });
});

/**
 * The reports read (`FEAT-026`).
 *
 * Two properties are worth a unit test each and are invisible to the e2e suite,
 * which sees only what a reviewer's screen renders: that the read is **bounded
 * and ordered** — `CLAUDE.md` §4.1, on a collection that grows with other
 * people's complaints and has no `where` to bound it — and that `reportedBy`
 * never leaves this service, which is the whole of "a reviewer needs the
 * complaint, not the complainant".
 */
describe('ReviewerService.getQuestionReports', () => {
  function reportsSetup(documents: RestDocument[], options: { throws?: boolean } = {}) {
    const runQuery = vi.fn(() =>
      options.throws ? Promise.reject(new Error('permission-denied')) : Promise.resolve(documents),
    );

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { user: signal(null) } },
        { provide: FirestoreRestClient, useValue: { getDocument: vi.fn(), runQuery } },
      ],
    });

    return { service: TestBed.inject(ReviewerService), runQuery };
  }

  function reportDoc(id: string, data: Record<string, unknown>): RestDocument {
    return { id, path: `question_reports/${id}`, data };
  }

  const FULL_REPORT = {
    questionId: 'q1',
    reason: 'incorrect',
    detail: 'We live on Earth.',
    reportedBy: 'anon-uid',
    createdAt: 1_760_000_000_000,
  };

  /**
   * The order is two fields, and both are there for a measured reason (see the
   * method): `__name__` descending **on its own** is refused by Firestore —
   * "does not support descending key scans" — and `createdAt` on its own gives
   * a cursor that skips a report whenever two share a millisecond. A test that
   * only checked "ordered by createdAt" would pass against both broken forms.
   */
  it('asks for one bounded page, newest first, with a unique tiebreaker', async () => {
    const h = reportsSetup([]);

    await h.service.getQuestionReports();

    expect(h.runQuery).toHaveBeenCalledWith(
      {
        collectionPath: 'question_reports',
        orderBy: [
          { field: 'createdAt', direction: 'DESCENDING' },
          { field: '__name__', direction: 'DESCENDING' },
        ],
        limit: REPORTS_PAGE_SIZE,
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  /**
   * Paging is a cursor rather than a growing limit, so a second page costs one
   * page of reads instead of two — and the cursor carries **both** ordering
   * values, positionally, or the tiebreaker above buys nothing.
   */
  it('hands back a cursor, and pages from it exclusively', async () => {
    const page = Array.from({ length: REPORTS_PAGE_SIZE }, (_, index) =>
      reportDoc(`r${index}`, { ...FULL_REPORT, createdAt: 1_760_000_000_000 - index }),
    );
    const h = reportsSetup(page);

    const first = await h.service.getQuestionReports();
    expect(first.next).toEqual([1_760_000_000_000 - (REPORTS_PAGE_SIZE - 1), 'r24']);

    await h.service.getQuestionReports(first.next!);

    expect(h.runQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        startAfterValues: [1_760_000_000_000 - (REPORTS_PAGE_SIZE - 1), 'r24'],
        limit: REPORTS_PAGE_SIZE,
      }),
      expect.anything(),
    );
  });

  // A short page is the end of the collection, and saying so is what takes the
  // "Show more" affordance away rather than leaving it to return nothing.
  it('reports no next page when the page came back short', async () => {
    const h = reportsSetup([reportDoc('r1', FULL_REPORT)]);

    expect((await h.service.getQuestionReports()).next).toBeNull();
  });

  // The cursor carries the **stored** value, not the narrowed one: it has to
  // mean to Firestore what the ordering means, whatever a console-written
  // document put in the field.
  it('cursors on the stored createdAt even when the queue could not read it', async () => {
    const page = Array.from({ length: REPORTS_PAGE_SIZE }, (_, index) =>
      reportDoc(`r${index}`, { ...FULL_REPORT, createdAt: '2026-09-12' }),
    );
    const h = reportsSetup(page);

    const { reports, next } = await h.service.getQuestionReports();

    expect(reports[0].createdAt).toBeNull();
    expect(next).toEqual(['2026-09-12', 'r24']);
  });

  /**
   * The uid is the one field in the document that identifies a person, and a
   * reviewer's token reads it whatever this method does — so the narrowing here
   * is the only thing that keeps it out of the component, the template and any
   * future screenshot of the queue. Asserted as an absent *key*, not as an
   * undefined value: `toEqual` ignores the difference and a spread would carry
   * the field straight through.
   */
  it('drops reportedBy before the report reaches anything that renders', async () => {
    const h = reportsSetup([reportDoc('5954006-3-anon-uid', FULL_REPORT)]);

    const [report] = (await h.service.getQuestionReports()).reports;

    expect(Object.keys(report).sort()).toEqual([
      'createdAt',
      'detail',
      'id',
      'questionId',
      'reason',
    ]);
    // The document **id** still ends in that uid and has to: it is the row's
    // stable key. What keeps it off the screen is the template, pinned by the
    // rendered half of `review-queue.component.spec.ts`.
    expect(report.id).toBe('5954006-3-anon-uid');
  });

  it('keeps the document id as the row key, and the rest of the complaint', async () => {
    const h = reportsSetup([reportDoc('5954006-3-anon-uid', FULL_REPORT)]);

    expect((await h.service.getQuestionReports()).reports).toEqual([
      {
        id: '5954006-3-anon-uid',
        questionId: 'q1',
        reason: 'incorrect',
        detail: 'We live on Earth.',
        createdAt: 1_760_000_000_000,
      },
    ]);
  });

  it('omits an absent detail rather than carrying an undefined one', async () => {
    const { detail: _detail, ...withoutDetail } = FULL_REPORT;
    const h = reportsSetup([reportDoc('r1', withoutDetail)]);

    const [report] = (await h.service.getQuestionReports()).reports;

    expect('detail' in report).toBe(false);
  });

  // The rules admit only the four reasons, so an unrecognised one means a
  // document written by hand in the console — which is the owner's own doing
  // and still a complaint. It reads as "other", which is what it is, rather
  // than vanishing from a queue nobody would then know to look at.
  it('reads an unrecognised reason as other rather than dropping the report', async () => {
    const h = reportsSetup([reportDoc('r1', { ...FULL_REPORT, reason: 'dislike' })]);

    const [report] = (await h.service.getQuestionReports()).reports;

    expect(report.reason).toBe('other');
  });

  it('reads a non-numeric createdAt as unknown rather than as a date', async () => {
    const h = reportsSetup([reportDoc('r1', { ...FULL_REPORT, createdAt: '2026-09-12' })]);

    const [report] = (await h.service.getQuestionReports()).reports;

    expect(report.createdAt).toBeNull();
  });

  // A refused or timed-out read is not an empty queue. Returning `[]` here
  // would make the tab say "No reports have been filed" on the strength of a
  // read that never answered — `CLAUDE.md` §4.4.
  it('throws when the read fails, so the caller cannot mistake it for an empty queue', async () => {
    const h = reportsSetup([], { throws: true });

    await expect(h.service.getQuestionReports()).rejects.toThrow();
  });
});
