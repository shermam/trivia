import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FieldPath } from 'firebase-admin/firestore';
import {
  ANONYMISED_REPORT_KEYS,
  QUESTION_REPORTS_COLLECTION,
  REPORT_SWEEP_MAX_PASSES,
  REPORT_SWEEP_PAGE_SIZE,
  anonymiseDecidedReports,
  anonymisedReport,
  isDecidedQuestion,
  isStillAttributable,
  leaverReportFate,
  questionReportsFor,
  sweepLeaverReports,
  type ReportQuery,
  type ReportSnapshot,
  type ReportStore,
} from './report-anonymisation';

/**
 * Report anonymisation (`FEAT-042`): when a report stops naming its reporter,
 * and the three readers that act on it — the daily pass, the leaver's pass in
 * `deleteAccount`, and the export.
 *
 * **The ids are the point.** A report's id is `{window}-{slot}-{uid}`, so a
 * version that deleted `reportedBy` and left the document where it was would
 * pass every assertion about the field and leave the uid in the name, readable
 * by every reviewer. The assertions below look at ids as well as fields for
 * that reason — the shape the spec's acceptance list asks for.
 *
 * Driven against a fake rather than the emulator, because the decisions
 * being pinned are which documents are read and what is written. The fake
 * applies the filters, the orderings and the cursor literally, refuses an
 * oversized batch and an empty one, and honours a delete's precondition the
 * way a real batch does — atomically, for every write in it. The e2e suite
 * runs the leaver's pass and the export against the emulator
 * (`account-management.spec.ts`).
 */

/**
 * The most writes one `WriteBatch` may commit. Enforced by the fake rather
 * than read off `REPORT_SWEEP_PAGE_SIZE`, so a page size raised past what a
 * batch can hold fails here rather than every batching test scaling with it.
 */
const WRITE_BATCH_LIMIT = 500;

type Doc = Record<string, unknown>;

interface Ref {
  path: string;
  id: string;
}

interface Filter {
  field: string;
  op: '==' | '>';
  value: string;
}

type Order = string | FieldPath;

const isDocumentId = (order: Order): boolean =>
  order instanceof FieldPath && order.isEqual(FieldPath.documentId());

/** Compares two ordering keys field by field, the way Firestore orders strings. */
function compareKeys(a: unknown[], b: unknown[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const [x, y] = [String(a[i]), String(b[i])];
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

interface QueryRecord {
  filters: Filter[];
  orders: string[];
  cursor: boolean;
  limit?: number;
}

/**
 * A `question_reports` collection and a `custom_questions` one, faked to the
 * depth the sweeps use them: queries on the first, `getAll` on the second,
 * batches of creates and deletes on the first.
 */
function fakeFirestore(seed: {
  reports?: ({ id: string } & Doc)[];
  questions?: Record<string, Doc>;
}) {
  const reports = new Map<string, Doc>(
    (seed.reports ?? []).map(({ id, ...data }) => [id, { ...data }]),
  );
  const questions = new Map<string, Doc>(Object.entries(seed.questions ?? {}));
  const commits: { creates: string[]; deletes: string[] }[] = [];
  const queries: QueryRecord[] = [];
  const lookups: { ids: string[]; fieldMask: unknown }[] = [];
  let nextAutoId = 0;
  let beforeCommit: (() => void) | undefined;

  const snapshotOf = (id: string, data: Doc): ReportSnapshot => {
    const copy = { ...data };
    return {
      id,
      ref: { path: `${QUESTION_REPORTS_COLLECTION}/${id}`, id } satisfies Ref,
      data: () => ({ ...copy }),
    };
  };

  const queryOver = (
    path: string,
    filters: Filter[],
    orders: Order[],
    cursor?: ReportSnapshot,
    max?: number,
  ): ReportQuery => ({
    where(field, op, value) {
      return queryOver(path, [...filters, { field, op, value }], orders, cursor, max);
    },
    orderBy(field) {
      return queryOver(path, filters, [...orders, field], cursor, max);
    },
    startAfter(snapshot) {
      return queryOver(path, filters, orders, snapshot, max);
    },
    limit(count) {
      return queryOver(path, filters, orders, cursor, count);
    },
    get() {
      assert.equal(path, QUESTION_REPORTS_COLLECTION, 'only reports are queried');
      // Firestore's own rule: a range filter's field must be the first ordering.
      const range = filters.find((filter) => filter.op === '>');
      if (range !== undefined && orders.length > 0) {
        assert.equal(orders[0], range.field, 'a range filter is ordered on its own field first');
      }
      queries.push({
        filters,
        orders: orders.map((order) => (isDocumentId(order) ? '__name__' : String(order))),
        cursor: cursor !== undefined,
        limit: max,
      });

      // The document id is always the last ordering, as it is in Firestore.
      const keys = [...orders, FieldPath.documentId()];
      const keyOf = (id: string, data: Doc) =>
        keys.map((key) => (isDocumentId(key) ? id : data[key as string]));

      let rows = [...reports.entries()]
        .filter(([, data]) =>
          filters.every(({ field, op, value }) =>
            op === '=='
              ? data[field] === value
              : typeof data[field] === 'string' && data[field] > value,
          ),
        )
        // An ordering on a field leaves out every document that lacks it.
        .filter(([, data]) =>
          orders.every((order) => isDocumentId(order) || (order as string) in data),
        )
        .sort(([idA, a], [idB, b]) => compareKeys(keyOf(idA, a), keyOf(idB, b)));
      if (cursor !== undefined) {
        const after = keyOf(cursor.id, cursor.data());
        rows = rows.filter(([id, data]) => compareKeys(keyOf(id, data), after) > 0);
      }
      return Promise.resolve({
        docs: rows.slice(0, max).map(([id, data]) => snapshotOf(id, data)),
      });
    },
  });

  const store: ReportStore = {
    collection(path) {
      return {
        ...queryOver(path, [], []),
        doc(id?: string): Ref {
          if (id === undefined) {
            nextAutoId += 1;
            return {
              path: `${path}/auto${String(nextAutoId).padStart(16, '0')}`,
              id: `auto${String(nextAutoId).padStart(16, '0')}`,
            };
          }
          return { path: `${path}/${id}`, id };
        },
      };
    },
    getAll(...items) {
      const refs = items.filter((item): item is Ref => 'path' in item);
      const options = items.find((item) => 'fieldMask' in item) as
        { fieldMask: string[] } | undefined;
      // The Admin SDK refuses a `getAll` with no references at all.
      assert.ok(refs.length > 0, 'getAll is called with at least one reference');
      for (const ref of refs) {
        assert.ok(ref.path.startsWith('custom_questions/'), 'only questions are looked up');
      }
      lookups.push({ ids: refs.map((ref) => ref.id), fieldMask: options?.fieldMask });
      return Promise.resolve(
        refs.map((ref) => {
          const question = questions.get(ref.id);
          return {
            id: ref.id,
            exists: question !== undefined,
            get: (field: string) => question?.[field],
          };
        }),
      );
    },
    batch() {
      const ops: (
        { kind: 'create'; ref: Ref; data: Doc } | { kind: 'delete'; ref: Ref; mustExist: boolean }
      )[] = [];
      return {
        create(ref, data) {
          ops.push({ kind: 'create', ref: ref as Ref, data: { ...data } });
        },
        delete(ref, precondition) {
          ops.push({ kind: 'delete', ref: ref as Ref, mustExist: precondition?.exists === true });
        },
        commit() {
          beforeCommit?.();
          assert.ok(ops.length > 0, 'no empty batch is committed');
          assert.ok(
            ops.length <= WRITE_BATCH_LIMIT,
            `a batch of ${ops.length} writes is over the ${WRITE_BATCH_LIMIT}-write limit`,
          );
          // Validated whole before anything is applied: a batch is atomic.
          for (const op of ops) {
            assert.ok(
              op.ref.path.startsWith(`${QUESTION_REPORTS_COLLECTION}/`),
              'only reports are written',
            );
            if (op.kind === 'create' && reports.has(op.ref.id)) {
              return Promise.reject(new Error(`ALREADY_EXISTS: ${op.ref.id}`));
            }
            if (op.kind === 'delete' && op.mustExist && !reports.has(op.ref.id)) {
              return Promise.reject(new Error(`NOT_FOUND: ${op.ref.id}`));
            }
          }
          for (const op of ops) {
            if (op.kind === 'create') {
              reports.set(op.ref.id, op.data);
            } else {
              reports.delete(op.ref.id);
            }
          }
          commits.push({
            creates: ops.filter((op) => op.kind === 'create').map((op) => op.ref.id),
            deletes: ops.filter((op) => op.kind === 'delete').map((op) => op.ref.id),
          });
          return Promise.resolve();
        },
      };
    },
  };

  return {
    store,
    commits,
    queries,
    lookups,
    /** Every report the collection holds now, id included, in id order. */
    remaining: () =>
      [...reports.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, data]) => ({ id, ...data }) as { id: string } & Doc),
    onCommit(hook: () => void) {
      beforeCommit = hook;
    },
    deleteReport(id: string) {
      reports.delete(id);
    },
  };
}

const NOW = 1_757_900_000_000;
const WINDOW = 5_859_666;

/** The id the create rule demands: `{window}-{slot}-{uid}`. */
const reportId = (uid: string, slot = 0, window = WINDOW) => `${window}-${slot}-${uid}`;

function report(uid: string, questionId: string, slot = 0, overrides: Doc = {}) {
  return {
    id: reportId(uid, slot),
    questionId,
    reason: 'incorrect',
    reportedBy: uid,
    createdAt: NOW,
    ...overrides,
  };
}

/** One question in each state a report can find its question in; `q-gone` is not here at all. */
const QUESTIONS: Record<string, Doc> = {
  'q-approved': { status: 'approved' },
  'q-rejected': { status: 'rejected' },
  'q-pending': { status: 'pending' },
};

/** The four content keys of a report, which is what an anonymised copy must still carry. */
const contentOf = ({ id: _id, reportedBy: _by, ...content }: { id: string } & Doc) => content;

// ---------------------------------------------------------------------------
// The decision. Both directions, because a predicate that answered "decided"
// to everything would satisfy a suite of nothing but decided cases.
// ---------------------------------------------------------------------------

test('a report about a question awaiting review keeps its reporter', () => {
  assert.equal(isDecidedQuestion({ status: 'pending' }), false);
  assert.equal(isStillAttributable({ status: 'pending' }), true);
});

test('a report about an approved or a rejected question does not', () => {
  assert.equal(isStillAttributable({ status: 'approved' }), false);
  assert.equal(isStillAttributable({ status: 'rejected' }), false);
});

test('nor does one about a question that no longer exists', () => {
  assert.equal(isDecidedQuestion(null), true);
  assert.equal(isStillAttributable(null), false);
});

/**
 * Only the two terminal statuses are decisions. A status nobody has defined —
 * a future quarantine value, a console typo, the field missing altogether — is
 * not evidence that a reviewer has looked, so it is read the cautious way.
 */
test('a status nobody has defined reads as undecided rather than as a decision', () => {
  for (const status of ['quarantined', 'Approved', '', undefined, null, 7]) {
    assert.equal(isStillAttributable({ status }), true, `status ${String(status)}`);
  }
  assert.equal(isStillAttributable({}), true, 'no status at all');
});

test('a leaver’s report about a decided question goes with them', () => {
  assert.equal(leaverReportFate({ status: 'approved' }), 'delete');
  assert.equal(leaverReportFate({ status: 'rejected' }), 'delete');
  assert.equal(leaverReportFate(null), 'delete');
});

test('a leaver’s report about a question still under review stays, without them', () => {
  assert.equal(leaverReportFate({ status: 'pending' }), 'anonymise');
  assert.equal(leaverReportFate({ status: 'quarantined' }), 'anonymise');
});

// ---------------------------------------------------------------------------
// The copy.
// ---------------------------------------------------------------------------

test('the copy keeps what was complained about and drops who complained', () => {
  assert.deepEqual(
    anonymisedReport({
      questionId: 'q1',
      reason: 'spam',
      detail: 'Same question three times.',
      reportedBy: 'alice',
      createdAt: NOW,
    }),
    { questionId: 'q1', reason: 'spam', detail: 'Same question three times.', createdAt: NOW },
  );
});

test('the copy is rebuilt from the allowlist, so an unknown key stays behind as well', () => {
  const copy = anonymisedReport({
    questionId: 'q1',
    reason: 'other',
    reportedBy: 'alice',
    createdAt: NOW,
    reporterEmail: 'alice@example.com',
  });

  assert.deepEqual(Object.keys(copy).sort(), ['createdAt', 'questionId', 'reason']);
});

test('a report filed with no detail is copied with no detail key, not an undefined one', () => {
  const copy = anonymisedReport({
    questionId: 'q1',
    reason: 'other',
    reportedBy: 'a',
    createdAt: NOW,
  });

  assert.equal('detail' in copy, false);
});

test('the allowlist is exactly the four content keys a report is filed with', () => {
  assert.deepEqual([...ANONYMISED_REPORT_KEYS], ['questionId', 'reason', 'detail', 'createdAt']);
});

// ---------------------------------------------------------------------------
// The daily pass.
// ---------------------------------------------------------------------------

test('anonymises every report whose question is decided and keeps the ones under review', async () => {
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: [
      report('alice', 'q-approved', 0, { detail: 'The answer is misspelled.' }),
      report('alice', 'q-pending', 1),
      report('bob', 'q-rejected', 0, { reason: 'inappropriate' }),
      report('bob', 'q-gone', 1, { reason: 'spam' }),
    ],
  });

  const result = await anonymiseDecidedReports(fake.store);

  assert.deepEqual(result, { examined: 4, anonymised: 3, kept: 1 });
  const left = fake.remaining();
  // The one under review is exactly where it was, reporter and all.
  assert.deepEqual(
    left.filter((doc) => 'reportedBy' in doc),
    [report('alice', 'q-pending', 1)],
  );
  // The other three are copies carrying their content and nothing else.
  assert.deepEqual(
    left
      .filter((doc) => !('reportedBy' in doc))
      .map(contentOf)
      .sort((a, b) => String(a['questionId']).localeCompare(String(b['questionId']))),
    [
      {
        questionId: 'q-approved',
        reason: 'incorrect',
        detail: 'The answer is misspelled.',
        createdAt: NOW,
      },
      { questionId: 'q-gone', reason: 'spam', createdAt: NOW },
      { questionId: 'q-rejected', reason: 'inappropriate', createdAt: NOW },
    ],
  );
});

/**
 * **The acceptance assertion.** A version that deleted the field in place
 * would satisfy every check on `reportedBy` and leave `alice` and `bob` in the
 * document names — so this one reads the ids.
 */
test('leaves no document whose id names a reporter whose question was decided', async () => {
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: [
      report('alice', 'q-approved'),
      report('bob', 'q-rejected'),
      report('carol', 'q-pending'),
    ],
  });

  await anonymiseDecidedReports(fake.store);

  for (const doc of fake.remaining()) {
    for (const uid of ['alice', 'bob']) {
      assert.ok(!doc.id.includes(uid), `${doc.id} still names ${uid} in its id`);
      assert.notEqual(doc['reportedBy'], uid, `${doc.id} still names ${uid} in a field`);
    }
  }
  // Non-vacuous: the report still under review names its reporter both ways.
  assert.ok(
    fake.remaining().some((doc) => doc.id === reportId('carol') && doc['reportedBy'] === 'carol'),
  );
});

test('is idempotent: a second run reads what it kept and writes nothing', async () => {
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: [report('alice', 'q-approved'), report('bob', 'q-pending')],
  });

  await anonymiseDecidedReports(fake.store);
  const afterFirst = fake.remaining();
  const second = await anonymiseDecidedReports(fake.store);

  assert.deepEqual(second, { examined: 1, anonymised: 0, kept: 1 });
  assert.deepEqual(fake.remaining(), afterFirst);
  assert.equal(fake.commits.length, 1, 'only the first run committed anything');
});

test('never reads an anonymised report, so a copy is never copied again', async () => {
  const anonymised = {
    id: 'Xq3vL9aT2bRk8mNc4PdE',
    questionId: 'q-approved',
    reason: 'other',
    createdAt: NOW,
  };
  const fake = fakeFirestore({ questions: QUESTIONS, reports: [anonymised] });

  const result = await anonymiseDecidedReports(fake.store);

  assert.deepEqual(result, { examined: 0, anonymised: 0, kept: 0 });
  assert.deepEqual(fake.remaining(), [anonymised]);
  assert.deepEqual(fake.commits, []);
  assert.deepEqual(fake.lookups, [], 'an empty page looks nothing up');
});

test('copies and deletes in the same batch, the copy at a fresh id', async () => {
  const fake = fakeFirestore({ questions: QUESTIONS, reports: [report('alice', 'q-approved')] });

  await anonymiseDecidedReports(fake.store);

  assert.equal(fake.commits.length, 1);
  const [{ creates, deletes }] = fake.commits;
  assert.deepEqual(deletes, [reportId('alice')]);
  assert.equal(creates.length, 1);
  assert.notEqual(creates[0], reportId('alice'));
  assert.ok(!creates[0].includes(String(WINDOW)), 'the copy does not keep the window either');
});

/**
 * **Atomic, which is what keeps a race from writing a report twice.** The
 * daily pass and a leaver's `deleteAccount` can read the same report at the
 * same moment. Whichever commits second finds the original gone; its delete
 * demands the original, so its whole batch is refused, the copy included —
 * and so is every other report in that page, which the next run reads again.
 */
test('a report removed before the batch lands fails the batch, and nothing is copied', async () => {
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: [report('alice', 'q-approved'), report('bob', 'q-approved')],
  });
  fake.onCommit(() => fake.deleteReport(reportId('alice')));

  await assert.rejects(anonymiseDecidedReports(fake.store), /NOT_FOUND/);

  assert.deepEqual(
    fake.remaining().map((doc) => doc.id),
    [reportId('bob')],
    'no copy of either report, and bob’s original untouched',
  );
});

test('every read is bounded: filtered on the reporter, ordered for its cursor, limited', async () => {
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: [
      report('alice', 'q-approved', 0),
      report('alice', 'q-approved', 1),
      report('bob', 'q-approved', 0),
      report('bob', 'q-pending', 1),
    ],
  });

  await anonymiseDecidedReports(fake.store);

  assert.deepEqual(fake.queries, [
    {
      filters: [{ field: 'reportedBy', op: '>', value: '' }],
      orders: ['reportedBy', '__name__'],
      cursor: false,
      limit: REPORT_SWEEP_PAGE_SIZE,
    },
  ]);
  // One read per question however many reports name it, and only the field
  // the decision needs.
  assert.equal(fake.lookups.length, 1);
  assert.deepEqual([...fake.lookups[0].ids].sort(), ['q-approved', 'q-pending']);
  assert.deepEqual(fake.lookups[0].fieldMask, ['status']);
});

/**
 * A question id that cannot name a document — empty, a path, a reserved name,
 * past Firestore's 1,500 bytes, not a string — names a question that is not
 * there. It must not reach `getAll`, which would refuse the whole page for
 * one malformed report, and nothing could ever clear it.
 */
test('reads a report naming an unusable question id as a question that is gone', async () => {
  const unusable = ['', 'a/b', '..', '__reserved__', 'q'.repeat(1_501), 42];
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: unusable.map((questionId, slot) => report('alice', questionId as string, slot)),
  });

  const result = await anonymiseDecidedReports(fake.store);

  assert.deepEqual(result, { examined: unusable.length, anonymised: unusable.length, kept: 0 });
  assert.deepEqual(fake.lookups, [], 'nothing usable to look up, so no lookup');
});

test('a question id of exactly 1,500 bytes is still looked up', async () => {
  const longest = 'q'.repeat(1_500);
  const fake = fakeFirestore({
    questions: { [longest]: { status: 'pending' } },
    reports: [report('alice', longest)],
  });

  const result = await anonymiseDecidedReports(fake.store);

  assert.deepEqual(result, { examined: 1, anonymised: 0, kept: 1 });
  assert.deepEqual(fake.lookups[0].ids, [longest]);
});

test('an empty collection costs one query and writes nothing', async () => {
  const fake = fakeFirestore({ questions: QUESTIONS });

  assert.deepEqual(await anonymiseDecidedReports(fake.store), {
    examined: 0,
    anonymised: 0,
    kept: 0,
  });
  assert.equal(fake.queries.length, 1);
  assert.deepEqual(fake.commits, []);
});

test('a page of reports it keeps commits nothing', async () => {
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: [report('alice', 'q-pending'), report('bob', 'q-pending')],
  });

  assert.deepEqual(await anonymiseDecidedReports(fake.store), {
    examined: 2,
    anonymised: 0,
    kept: 2,
  });
  assert.deepEqual(fake.commits, []);
});

/** `n` reports by `n` reporters, each about `questionId`, sorting in the order they are numbered. */
const reportsAbout = (questionId: string, n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => report(`${prefix}${String(i).padStart(5, '0')}`, questionId));

/**
 * **The batching.** 600 anonymisations are 1,200 writes, which cannot go in one
 * `WriteBatch`: the pass has to page, 250 reports — 500 writes — at a time,
 * and a full page has to be followed by another query rather than taken as the
 * end of the run.
 */
test('pages a backlog larger than one batch, 250 reports and 500 writes at a time', async () => {
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: reportsAbout('q-approved', 600, 'u'),
  });

  const result = await anonymiseDecidedReports(fake.store);

  assert.deepEqual(result, { examined: 600, anonymised: 600, kept: 0 });
  assert.deepEqual(
    fake.commits.map(({ creates, deletes }) => creates.length + deletes.length),
    [500, 500, 200],
  );
  assert.ok(fake.remaining().every((doc) => !('reportedBy' in doc)));
});

/**
 * **The cursor.** The reports the pass keeps stay in the set it reads, so a
 * page made of them comes back first on every query that starts from the top
 * — and a pass without a cursor would read the same 250 reports about a
 * question under review twenty times and never reach the decided ones sorting
 * after them.
 */
test('pages past a full page of reports it keeps, to the decided ones behind them', async () => {
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: [...reportsAbout('q-pending', 300, 'a'), ...reportsAbout('q-approved', 5, 'z')],
  });

  const result = await anonymiseDecidedReports(fake.store);

  assert.deepEqual(result, { examined: 305, anonymised: 5, kept: 300 });
  assert.deepEqual(
    fake.queries.map((query) => query.cursor),
    [false, true],
  );
});

/**
 * A page that comes back exactly full cannot tell "250 and nothing else" from
 * "250 of many", so it asks once more — one empty read, no empty batch.
 */
test('asks once more after a page that is exactly full', async () => {
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: reportsAbout('q-approved', REPORT_SWEEP_PAGE_SIZE, 'u'),
  });

  await anonymiseDecidedReports(fake.store);

  assert.equal(fake.queries.length, 2);
  assert.equal(fake.commits.length, 1);
});

/**
 * The run stops itself rather than running until the platform kills it.
 * Nothing is lost by stopping: tomorrow's run reads what is left, which is the
 * property that makes a ceiling safe at all.
 */
test('stops after the pass ceiling, leaving the rest for the next run', async () => {
  const backlog = REPORT_SWEEP_PAGE_SIZE * (REPORT_SWEEP_MAX_PASSES + 2);
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: reportsAbout('q-approved', backlog, 'u'),
  });

  const first = await anonymiseDecidedReports(fake.store);

  assert.equal(first.anonymised, REPORT_SWEEP_PAGE_SIZE * REPORT_SWEEP_MAX_PASSES);
  assert.equal(fake.queries.length, REPORT_SWEEP_MAX_PASSES);
  assert.equal(
    fake.remaining().filter((doc) => 'reportedBy' in doc).length,
    REPORT_SWEEP_PAGE_SIZE * 2,
  );

  const second = await anonymiseDecidedReports(fake.store);
  assert.equal(second.anonymised, REPORT_SWEEP_PAGE_SIZE * 2);
  assert.ok(fake.remaining().every((doc) => !('reportedBy' in doc)));
});

// ---------------------------------------------------------------------------
// The leaver's pass, for `deleteAccount`.
// ---------------------------------------------------------------------------

test('deletes the leaver’s reports about decided questions and keeps the rest without them', async () => {
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: [
      report('leaver', 'q-approved', 0),
      report('leaver', 'q-rejected', 1),
      report('leaver', 'q-gone', 2),
      report('leaver', 'q-pending', 3, { detail: 'Two answers are right.' }),
      report('leaver', 'q-pending', 4, { reason: 'other' }),
      // Somebody else's, on the same questions: none of these is the leaver's.
      report('bob', 'q-approved'),
      report('carol', 'q-pending'),
    ],
  });

  const result = await sweepLeaverReports(fake.store, 'leaver');

  assert.deepEqual(result, { deleted: 3, anonymised: 2 });
  const left = fake.remaining();
  for (const doc of left) {
    assert.ok(!doc.id.includes('leaver'), `${doc.id} still names the leaver in its id`);
    assert.notEqual(doc['reportedBy'], 'leaver');
  }
  // Nobody else's report moved.
  assert.deepEqual(
    left.filter((doc) => 'reportedBy' in doc),
    [report('bob', 'q-approved'), report('carol', 'q-pending')],
  );
  // The two under review survive as complaints, content intact.
  assert.deepEqual(
    left
      .filter((doc) => !('reportedBy' in doc))
      .map(contentOf)
      .sort((a, b) => String(a['reason']).localeCompare(String(b['reason']))),
    [
      {
        questionId: 'q-pending',
        reason: 'incorrect',
        detail: 'Two answers are right.',
        createdAt: NOW,
      },
      { questionId: 'q-pending', reason: 'other', createdAt: NOW },
    ].sort((a, b) => a.reason.localeCompare(b.reason)),
  );
});

test('finds the leaver’s reports by an equality on the reporter, a page at a time', async () => {
  const fake = fakeFirestore({ questions: QUESTIONS, reports: [report('leaver', 'q-approved')] });

  await sweepLeaverReports(fake.store, 'leaver');

  assert.deepEqual(fake.queries, [
    {
      filters: [{ field: 'reportedBy', op: '==', value: 'leaver' }],
      orders: [],
      cursor: false,
      limit: REPORT_SWEEP_PAGE_SIZE,
    },
  ]);
});

/**
 * A heavy reporter can leave more than one batch's worth. Each page leaves the
 * result set whichever way its reports go, so the pass re-queries from the
 * start — no cursor — until a short page says there is nothing left.
 */
test('pages through more reports than one batch can hold, re-querying from the start', async () => {
  const mine = Array.from({ length: 600 }, (_, i) => ({
    ...report('leaver', 'q-pending'),
    id: reportId('leaver', i % 10, WINDOW + Math.floor(i / 10)),
  }));
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: [...mine, report('bob', 'q-pending')],
  });

  const result = await sweepLeaverReports(fake.store, 'leaver');

  assert.deepEqual(result, { deleted: 0, anonymised: 600 });
  assert.deepEqual(
    fake.commits.map(({ creates, deletes }) => creates.length + deletes.length),
    [500, 500, 200],
  );
  assert.ok(fake.queries.every((query) => !query.cursor));
  assert.deepEqual(
    fake.remaining().filter((doc) => 'reportedBy' in doc),
    [report('bob', 'q-pending')],
  );
});

test('a full last page reads once more and commits nothing further', async () => {
  const mine = Array.from({ length: REPORT_SWEEP_PAGE_SIZE }, (_, i) => ({
    ...report('leaver', 'q-approved'),
    id: reportId('leaver', i % 10, WINDOW + Math.floor(i / 10)),
  }));
  const fake = fakeFirestore({ questions: QUESTIONS, reports: mine });

  assert.deepEqual(await sweepLeaverReports(fake.store, 'leaver'), {
    deleted: REPORT_SWEEP_PAGE_SIZE,
    anonymised: 0,
  });
  assert.equal(fake.queries.length, 2);
  assert.equal(fake.commits.length, 1);
});

test('an account that never reported anything costs one query and writes nothing', async () => {
  const fake = fakeFirestore({ questions: QUESTIONS, reports: [report('bob', 'q-approved')] });

  assert.deepEqual(await sweepLeaverReports(fake.store, 'leaver'), { deleted: 0, anonymised: 0 });
  assert.deepEqual(fake.commits, []);
  assert.deepEqual(fake.lookups, []);
});

// ---------------------------------------------------------------------------
// The export.
// ---------------------------------------------------------------------------

/**
 * Every report that still names the account, whatever its question's status:
 * one about a decided question keeps the uid until the next daily run, and an
 * export leaving it out would answer a data-access request with less than is
 * held. An anonymised one is nobody's.
 */
test('export returns every report that still names the account, whole, and nothing else', async () => {
  const fake = fakeFirestore({
    questions: QUESTIONS,
    reports: [
      report('alice', 'q-approved', 0, { detail: 'Wrong year.' }),
      report('alice', 'q-pending', 1),
      report('bob', 'q-pending'),
      { id: 'Xq3vL9aT2bRk8mNc4PdE', questionId: 'q-rejected', reason: 'spam', createdAt: NOW },
    ],
  });

  assert.deepEqual(await questionReportsFor(fake.store, 'alice'), [
    report('alice', 'q-approved', 0, { detail: 'Wrong year.' }),
    report('alice', 'q-pending', 1),
  ]);
  assert.deepEqual(fake.commits, [], 'an export writes nothing');
});

test('export of an account that never reported anything is an empty list', async () => {
  const fake = fakeFirestore({ questions: QUESTIONS, reports: [report('bob', 'q-pending')] });

  assert.deepEqual(await questionReportsFor(fake.store, 'alice'), []);
});
