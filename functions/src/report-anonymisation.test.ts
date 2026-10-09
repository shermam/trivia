import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANONYMISED_REPORT_KEYS,
  LeaverReportSweepIncompleteError,
  QUESTION_REPORTS_COLLECTION,
  REPORT_SWEEP_MAX_PAGES,
  REPORT_SWEEP_PAGE_SIZE,
  ReportSweepIndexNotReadyError,
  anonymiseExpiredReports,
  anonymisedReport,
  isIndexNotReady,
  questionReportsFor,
  reporterRetentionCutoff,
  startOfUtcDay,
  sweepLeaverReports,
  type ReportQuery,
  type ReportSnapshot,
  type ReportStore,
} from './report-anonymisation';
import { EXPIRED_REPORTS_ORDER } from './report-query';
import { REPORTER_RETENTION_DAYS, REPORTER_RETENTION_MS } from './report-retention';

/**
 * Report anonymisation (`FEAT-042`): when a report stops naming its reporter —
 * thirty days after it is filed, or at once when the reporter deletes their
 * account — and the three readers that act on it.
 *
 * **The ids are the point.** A report's id is `{window}-{slot}-{uid}`, so a
 * version that deleted `reportedBy` and left the document where it was would
 * pass every assertion about the field and leave the uid in the name, readable
 * by every reviewer. The assertions below look at ids as well as fields for
 * that reason — the shape the spec's acceptance list asks for.
 *
 * Driven against a fake rather than the emulator, because the decisions being
 * pinned are which documents are read and what is written. The fake applies
 * the filters and the orderings literally — numbers as numbers, a range
 * matching numbers only, and an ordering on a field leaving out every document
 * that lacks it, all as Firestore's do — refuses an oversized batch and an
 * empty one, and honours a delete's precondition the way a real batch does,
 * atomically for every write in it. The e2e suite runs the leaver's pass and
 * the export against the emulator (`account-management.spec.ts`).
 */

/**
 * The most writes one `WriteBatch` may commit. Enforced by the fake rather
 * than read off `REPORT_SWEEP_PAGE_SIZE`, so a page size raised past what a
 * batch can hold fails here rather than every batching test scaling with it.
 */
const WRITE_BATCH_LIMIT = 500;

/**
 * The most queries one fake answers. Every pass here stops itself — the daily
 * one pauses at its ceiling, the leaver's throws — and the longest test sends
 * two runs' worth of pages. A pass that lost its bound would otherwise loop for
 * as long as the suite let it: a per-test timeout marks such a test failed but
 * cannot stop the loop, which keeps the process alive and the suite hanging.
 * Refusing the query past this budget fails it fast instead.
 */
const QUERY_BUDGET = 100;

type Doc = Record<string, unknown>;

interface Ref {
  path: string;
  id: string;
}

interface Filter {
  field: string;
  op: '==' | '<';
  value: string | number;
}

/** Firestore's order within one type: numbers by value, strings by code point. */
function compareValues(x: unknown, y: unknown): number {
  if (typeof x === 'number' && typeof y === 'number') {
    return x - y;
  }
  const [a, b] = [String(x), String(y)];
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareKeys(a: unknown[], b: unknown[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const order = compareValues(a[i], b[i]);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

interface QueryRecord {
  filters: Filter[];
  orders: string[];
  limit?: number;
  /** How many documents the query came back with. */
  returned: number;
}

/** A `question_reports` collection, faked to the depth the sweeps use it. */
function fakeFirestore(
  seed: ({ id: string } & Doc)[],
  { failQueriesWith }: { failQueriesWith?: unknown } = {},
) {
  const reports = new Map<string, Doc>(seed.map(({ id, ...data }) => [id, { ...data }]));
  const commits: { creates: string[]; deletes: string[] }[] = [];
  const queries: QueryRecord[] = [];
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

  const matches = (data: Doc, { field, op, value }: Filter): boolean =>
    op === '=='
      ? data[field] === value
      : // A range on a number matches numbers only, as Firestore's does.
        typeof data[field] === typeof value && compareValues(data[field], value) < 0;

  const queryOver = (
    path: string,
    filters: Filter[],
    orders: string[],
    max?: number,
  ): ReportQuery => ({
    where(field, op, value) {
      return queryOver(path, [...filters, { field, op, value }], orders, max);
    },
    orderBy(field) {
      return queryOver(path, filters, [...orders, field], max);
    },
    limit(count) {
      return queryOver(path, filters, orders, count);
    },
    get() {
      assert.equal(path, QUESTION_REPORTS_COLLECTION, 'only reports are queried');
      // Firestore's own rule: a range filter's field must be the first ordering.
      const range = filters.find((filter) => filter.op === '<');
      if (range !== undefined && orders.length > 0) {
        assert.equal(orders[0], range.field, 'a range filter is ordered on its own field first');
      }
      if (failQueriesWith !== undefined) {
        return Promise.reject(failQueriesWith);
      }
      assert.ok(
        queries.length < QUERY_BUDGET,
        `a pass sent more than ${QUERY_BUDGET} queries: it is not stopping`,
      );

      // The document id is always the last ordering, as it is in Firestore.
      const keyOf = (id: string, data: Doc) => [...orders.map((field) => data[field]), id];
      const rows = [...reports.entries()]
        .filter(([, data]) => filters.every((filter) => matches(data, filter)))
        // An ordering on a field leaves out every document that lacks it.
        .filter(([, data]) => orders.every((field) => field in data))
        .sort(([idA, a], [idB, b]) => compareKeys(keyOf(idA, a), keyOf(idB, b)))
        .slice(0, max);
      queries.push({ filters, orders, limit: max, returned: rows.length });
      // Answered on a later turn of the event loop, as a real read is, so that
      // a pass that never stops reading still lets the test's timeout fire
      // rather than starving every timer in the process.
      const docs = rows.map(([id, data]) => snapshotOf(id, data));
      return new Promise((resolve) => setImmediate(() => resolve({ docs })));
    },
  });

  const store: ReportStore = {
    collection(path) {
      return {
        ...queryOver(path, [], []),
        doc(id?: string): Ref {
          if (id === undefined) {
            nextAutoId += 1;
            const auto = `auto${String(nextAutoId).padStart(16, '0')}`;
            return { path: `${path}/${auto}`, id: auto };
          }
          return { path: `${path}/${id}`, id };
        },
      };
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

/** 2025-09-15T01:33:20Z — an hour and a half into its UTC day, so the day is visible. */
const NOW = 1_757_900_000_000;
const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 5_859_666;

/** The id the create rule demands: `{window}-{slot}-{uid}`. */
const reportId = (uid: string, slot = 0, window = WINDOW) => `${window}-${slot}-${uid}`;

/** A report as filed, `daysAgo` days before {@link NOW}. */
function report(uid: string, daysAgo: number, slot = 0, overrides: Doc = {}) {
  return {
    id: reportId(uid, slot),
    questionId: 'q1',
    reason: 'incorrect',
    reportedBy: uid,
    createdAt: NOW - daysAgo * DAY,
    ...overrides,
  };
}

/** What an anonymised copy of a report filed `daysAgo` days back must carry as `createdAt`. */
const dayOf = (daysAgo: number) => startOfUtcDay(NOW - daysAgo * DAY);

/** The content keys of a document, which is what an anonymised copy must still carry. */
const contentOf = ({ id: _id, reportedBy: _by, ...content }: { id: string } & Doc) => content;

const byCreatedAt = (a: Doc, b: Doc) => compareValues(a['createdAt'], b['createdAt']);

/** The query the daily pass sends, as the fake records it. */
const dailyQuery = {
  filters: [{ field: 'createdAt', op: '<', value: reporterRetentionCutoff(NOW) }],
  orders: ['createdAt', 'reportedBy'],
  limit: REPORT_SWEEP_PAGE_SIZE,
};

const shapeOf = ({ returned: _returned, ...shape }: QueryRecord) => shape;

// ---------------------------------------------------------------------------
// The period, and the day a copy keeps.
// ---------------------------------------------------------------------------

test('a report keeps its reporter for thirty days', () => {
  assert.equal(REPORTER_RETENTION_DAYS, 30);
  assert.equal(REPORTER_RETENTION_MS, 30 * DAY);
  assert.equal(reporterRetentionCutoff(NOW), NOW - 30 * DAY);
});

/**
 * The start of the UTC day, from both sides of a boundary: the last
 * millisecond of a day belongs to it, and the first of the next starts it.
 */
test('a copy keeps the UTC day a report was filed, not the moment', () => {
  const midnight = Date.UTC(2025, 8, 15);

  assert.equal(startOfUtcDay(midnight), midnight);
  assert.equal(startOfUtcDay(midnight + 1), midnight);
  assert.equal(startOfUtcDay(midnight + DAY - 1), midnight);
  assert.equal(startOfUtcDay(midnight + DAY), midnight + DAY);
  assert.equal(startOfUtcDay(NOW), midnight);
});

// ---------------------------------------------------------------------------
// The copy.
// ---------------------------------------------------------------------------

test('the copy keeps what was complained about and when, to the day, and drops who complained', () => {
  assert.deepEqual(
    anonymisedReport({
      questionId: 'q1',
      reason: 'spam',
      detail: 'Same question three times.',
      reportedBy: 'alice',
      createdAt: NOW,
    }),
    {
      questionId: 'q1',
      reason: 'spam',
      detail: 'Same question three times.',
      createdAt: Date.UTC(2025, 8, 15),
    },
  );
});

/**
 * The millisecond is the thing being removed: a report and a score saved in the
 * same session carry `createdAt`s a few seconds apart, and the score's public
 * leaderboard entry names its player.
 */
test('two reports filed hours apart on one day are copied with the same createdAt', () => {
  const morning = anonymisedReport({ questionId: 'q1', reason: 'spam', createdAt: NOW });
  const evening = anonymisedReport({
    questionId: 'q2',
    reason: 'other',
    createdAt: NOW + 20 * 60 * 60 * 1000,
  });

  assert.equal(morning['createdAt'], evening['createdAt']);
});

/** Only a console edit can store a `createdAt` that is not a number, and there is no day to cut it to. */
test('a createdAt that is not a number is copied as it is', () => {
  const copy = anonymisedReport({ questionId: 'q1', reason: 'spam', createdAt: '2025-09-15' });

  assert.equal(copy['createdAt'], '2025-09-15');
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

/**
 * Both sides of the boundary, because a pass that anonymised everything would
 * satisfy a suite of nothing but expired cases: a report exactly thirty days
 * old keeps its reporter for one more run, a millisecond older it does not.
 */
test('anonymises every report older than thirty days and leaves the younger ones alone', async () => {
  const fake = fakeFirestore([
    report('alice', 40, 0, { detail: 'The answer is misspelled.' }),
    report('bob', 31, 0, { reason: 'inappropriate', questionId: 'q2' }),
    report('erin', 0, 0, { createdAt: reporterRetentionCutoff(NOW) - 1 }),
    report('carol', 5),
    report('dave', 30),
  ]);

  const result = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(result, { anonymised: 3, stoppedAtCeiling: false });
  const left = fake.remaining();
  // The young one, and the one exactly thirty days old, are exactly where they were.
  assert.deepEqual(
    left.filter((doc) => 'reportedBy' in doc),
    [report('carol', 5), report('dave', 30)].sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
  // The other three are copies carrying their content, to the day, and nothing else.
  assert.deepEqual(
    left
      .filter((doc) => !('reportedBy' in doc))
      .map(contentOf)
      .sort(byCreatedAt),
    [
      {
        questionId: 'q1',
        reason: 'incorrect',
        detail: 'The answer is misspelled.',
        createdAt: dayOf(40),
      },
      { questionId: 'q2', reason: 'inappropriate', createdAt: dayOf(31) },
      { questionId: 'q1', reason: 'incorrect', createdAt: dayOf(30) },
    ],
  );
});

/**
 * **The acceptance assertion.** A version that deleted the field in place
 * would satisfy every check on `reportedBy` and leave `alice` and `bob` in the
 * document names — so this one reads the ids.
 */
test('leaves no document whose id names a reporter whose report has expired', async () => {
  const fake = fakeFirestore([report('alice', 45), report('bob', 31), report('carol', 2)]);

  await anonymiseExpiredReports(fake.store, NOW);

  for (const doc of fake.remaining()) {
    for (const uid of ['alice', 'bob']) {
      assert.ok(!doc.id.includes(uid), `${doc.id} still names ${uid} in its id`);
      assert.notEqual(doc['reportedBy'], uid, `${doc.id} still names ${uid} in a field`);
    }
  }
  // Non-vacuous: the report still inside its thirty days names its reporter both ways.
  assert.ok(
    fake.remaining().some((doc) => doc.id === reportId('carol') && doc['reportedBy'] === 'carol'),
  );
});

/** `n` anonymised copies filed `daysAgo` days back, as the pass writes them. */
const copiesFiled = (daysAgo: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `copy${String(i).padStart(16, '0')}`,
    questionId: 'q1',
    reason: 'other',
    createdAt: dayOf(daysAgo),
  }));

/**
 * **The copies are never read.** Every copy keeps a `createdAt` older than the
 * cutoff, so a range on `createdAt` alone would read them — first, since they
 * are the oldest — and a run would spend its whole ceiling on them and reach
 * nothing behind them, every day; anybody can file ten reports per five
 * minutes from a fresh anonymous session, so that state is reachable on
 * purpose. The ordering on `reportedBy` leaves every copy out of the query.
 */
test('never reads an anonymised copy, however many lie in the range', async () => {
  const copies = copiesFiled(90, REPORT_SWEEP_PAGE_SIZE * REPORT_SWEEP_MAX_PAGES + 300);
  const fake = fakeFirestore([
    ...copies,
    report('alice', 40),
    report('bob', 35, 1),
    report('carol', 31, 2),
  ]);

  const result = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(result, { anonymised: 3, stoppedAtCeiling: false });
  assert.deepEqual(
    fake.queries.map((query) => query.returned),
    [3],
    'one query, which came back with the three originals and none of the copies',
  );
  assert.equal(fake.remaining().length, copies.length + 3);
  assert.ok(fake.remaining().every((doc) => !('reportedBy' in doc)));
});

test('is idempotent: a second run reads nothing and writes nothing', async () => {
  const fake = fakeFirestore([report('alice', 40), report('bob', 3)]);

  await anonymiseExpiredReports(fake.store, NOW);
  const afterFirst = fake.remaining();
  const second = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(second, { anonymised: 0, stoppedAtCeiling: false });
  assert.deepEqual(fake.remaining(), afterFirst);
  assert.equal(fake.commits.length, 1, 'only the first run committed anything');
  assert.equal(fake.queries.at(-1)?.returned, 0, 'and the second run’s one query found nothing');
});

test('copies and deletes in the same batch, the copy at a fresh id', async () => {
  const fake = fakeFirestore([report('alice', 40)]);

  await anonymiseExpiredReports(fake.store, NOW);

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
  const fake = fakeFirestore([report('alice', 40), report('bob', 40)]);
  fake.onCommit(() => fake.deleteReport(reportId('alice')));

  await assert.rejects(anonymiseExpiredReports(fake.store, NOW), /NOT_FOUND/);

  assert.deepEqual(
    fake.remaining().map((doc) => doc.id),
    [reportId('bob')],
    'no copy of either report, and bob’s original untouched',
  );
});

/**
 * The query the composite index is declared for, built from the constants
 * `firestore-tests/indexes.spec.ts` derives that index from.
 */
test('every read is the same bounded query: a range on createdAt, ordered by it and the reporter', async () => {
  const fake = fakeFirestore([report('alice', 40), report('bob', 2)]);

  await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(fake.queries.map(shapeOf), [dailyQuery]);
  assert.deepEqual(dailyQuery.orders, [...EXPIRED_REPORTS_ORDER]);
});

test('an empty collection costs one query and writes nothing', async () => {
  const fake = fakeFirestore([]);

  assert.deepEqual(await anonymiseExpiredReports(fake.store, NOW), {
    anonymised: 0,
    stoppedAtCeiling: false,
  });
  assert.equal(fake.queries.length, 1);
  assert.deepEqual(fake.commits, []);
});

/** `n` reports by `n` reporters, filed `daysAgo` days back, `n` milliseconds apart. */
const reportsFiled = (daysAgo: number, n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({
    ...report(`${prefix}${String(i).padStart(5, '0')}`, daysAgo),
    createdAt: NOW - daysAgo * DAY + i,
  }));

/**
 * **The batching, and the re-query.** 600 anonymisations are 1,200 writes,
 * which cannot go in one `WriteBatch`: the pass has to page, 250 reports — 500
 * writes — at a time. Each page it anonymises leaves the set, so every page is
 * the same query sent again from the start, with no cursor to carry.
 */
test('pages a backlog larger than one batch, re-sending the same query from the start', async () => {
  const fake = fakeFirestore(reportsFiled(40, 600, 'u'));

  const result = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(result, { anonymised: 600, stoppedAtCeiling: false });
  assert.deepEqual(
    fake.commits.map(({ creates, deletes }) => creates.length + deletes.length),
    [500, 500, 200],
  );
  assert.deepEqual(
    fake.queries.map((query) => query.returned),
    [250, 250, 100],
  );
  assert.ok(
    fake.queries.every((query) => JSON.stringify(shapeOf(query)) === JSON.stringify(dailyQuery)),
  );
  assert.ok(fake.remaining().every((doc) => !('reportedBy' in doc)));
});

/**
 * A page that comes back exactly full cannot tell "250 and nothing else" from
 * "250 of many", so it asks once more — one empty read, no empty batch.
 */
test('asks once more after a page that is exactly full', async () => {
  const fake = fakeFirestore(reportsFiled(40, REPORT_SWEEP_PAGE_SIZE, 'u'));

  await anonymiseExpiredReports(fake.store, NOW);

  assert.equal(fake.queries.length, 2);
  assert.equal(fake.commits.length, 1);
});

/**
 * **The ceiling is a pause, not a failure.** Every page anonymised leaves the
 * set, so a run that stops at its ceiling leaves exactly the rest for the next
 * run, which starts where this one stopped. Nothing throws: the run did all it
 * may, and says so.
 */
test('stops at its ceiling and leaves the rest to the next run, which finishes it', async () => {
  const backlog = REPORT_SWEEP_PAGE_SIZE * (REPORT_SWEEP_MAX_PAGES + 2);
  const fake = fakeFirestore(reportsFiled(40, backlog, 'u'));

  const first = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(first, {
    anonymised: REPORT_SWEEP_PAGE_SIZE * REPORT_SWEEP_MAX_PAGES,
    stoppedAtCeiling: true,
  });
  assert.equal(fake.queries.length, REPORT_SWEEP_MAX_PAGES, 'no read past the ceiling');
  assert.equal(
    fake.remaining().filter((doc) => 'reportedBy' in doc).length,
    REPORT_SWEEP_PAGE_SIZE * 2,
  );

  const second = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(second, { anonymised: REPORT_SWEEP_PAGE_SIZE * 2, stoppedAtCeiling: false });
  assert.ok(fake.remaining().every((doc) => !('reportedBy' in doc)));
  assert.equal(fake.remaining().length, backlog, 'one copy per report, and no original left');
});

/**
 * A run that ends on a full last page cannot tell that it has finished, so it
 * says it stopped at the ceiling; the next run's one empty read is all that
 * costs.
 */
test('a range of exactly the ceiling’s size reads as a pause, and the next run finds nothing', async () => {
  const fake = fakeFirestore(
    reportsFiled(40, REPORT_SWEEP_PAGE_SIZE * REPORT_SWEEP_MAX_PAGES, 'u'),
  );

  assert.deepEqual(await anonymiseExpiredReports(fake.store, NOW), {
    anonymised: REPORT_SWEEP_PAGE_SIZE * REPORT_SWEEP_MAX_PAGES,
    stoppedAtCeiling: true,
  });
  const commits = fake.commits.length;

  assert.deepEqual(await anonymiseExpiredReports(fake.store, NOW), {
    anonymised: 0,
    stoppedAtCeiling: false,
  });
  assert.equal(fake.commits.length, commits, 'and writes nothing');
});

// ---------------------------------------------------------------------------
// The index the daily query needs.
// ---------------------------------------------------------------------------

/** What the Admin SDK rejects a query with when its composite index is not serving. */
const indexNotServing = Object.assign(
  new Error(
    '9 FAILED_PRECONDITION: The query requires an index. That index is currently building ' +
      'and cannot be used yet.',
  ),
  { code: 9 },
);

/**
 * The deploy that ships the composite index ships the function too, and an
 * index takes a while to build: a run in between is refused. It fails — the
 * next run succeeds — under a name that says which failure it is.
 */
test('a query refused for want of its index fails the run by name, with the refusal as its cause', async () => {
  const fake = fakeFirestore([report('alice', 40)], { failQueriesWith: indexNotServing });

  await assert.rejects(anonymiseExpiredReports(fake.store, NOW), (error: unknown) => {
    assert.ok(error instanceof ReportSweepIndexNotReadyError);
    assert.equal(error.name, 'ReportSweepIndexNotReadyError');
    assert.equal(error.cause, indexNotServing);
    assert.match(error.message, /\(createdAt ASC, reportedBy ASC\) index on question_reports/);
    return true;
  });
  assert.deepEqual(fake.commits, []);
});

test('any other refusal is passed on as it came', async () => {
  const unavailable = Object.assign(new Error('14 UNAVAILABLE: try again'), { code: 14 });
  const fake = fakeFirestore([report('alice', 40)], { failQueriesWith: unavailable });

  await assert.rejects(anonymiseExpiredReports(fake.store, NOW), (error: unknown) => {
    assert.equal(error, unavailable);
    return true;
  });
});

test('recognises the index refusal by its status, numeric or named, and nothing else', () => {
  assert.equal(isIndexNotReady(indexNotServing), true);
  assert.equal(isIndexNotReady({ code: 'failed-precondition' }), true);
  assert.equal(isIndexNotReady(new Error('9 FAILED_PRECONDITION: requires an index')), true);

  assert.equal(isIndexNotReady({ code: 5, message: '5 NOT_FOUND: no entity' }), false);
  assert.equal(isIndexNotReady(new Error('14 UNAVAILABLE')), false);
  assert.equal(isIndexNotReady('FAILED_PRECONDITION'), false);
  assert.equal(isIndexNotReady(null), false);
});

// ---------------------------------------------------------------------------
// The leaver's pass, for `deleteAccount`.
// ---------------------------------------------------------------------------

/**
 * **Never a delete.** A report is evidence about somebody else's question, so
 * a leaver's reports all stay — however recent — and only the identity goes.
 */
test('anonymises every report the leaver filed, however recent, and deletes none', async () => {
  const fake = fakeFirestore([
    report('leaver', 0, 0),
    report('leaver', 12, 1, { detail: 'Two answers are right.' }),
    report('leaver', 29, 2, { reason: 'other' }),
    // Somebody else's, of every age: none of these is the leaver's.
    report('bob', 1),
    report('carol', 20),
  ]);

  const result = await sweepLeaverReports(fake.store, 'leaver');

  assert.deepEqual(result, { anonymised: 3 });
  const left = fake.remaining();
  assert.equal(left.length, 5, 'nothing was deleted outright');
  for (const doc of left) {
    assert.ok(!doc.id.includes('leaver'), `${doc.id} still names the leaver in its id`);
    assert.notEqual(doc['reportedBy'], 'leaver');
  }
  // Nobody else's report moved.
  assert.deepEqual(
    left.filter((doc) => 'reportedBy' in doc),
    [report('bob', 1), report('carol', 20)],
  );
  // The leaver's three survive as complaints, content intact and the day kept.
  assert.deepEqual(
    left
      .filter((doc) => !('reportedBy' in doc))
      .map(contentOf)
      .sort(byCreatedAt),
    [
      { questionId: 'q1', reason: 'other', createdAt: dayOf(29) },
      {
        questionId: 'q1',
        reason: 'incorrect',
        detail: 'Two answers are right.',
        createdAt: dayOf(12),
      },
      { questionId: 'q1', reason: 'incorrect', createdAt: dayOf(0) },
    ],
  );
});

test('finds the leaver’s reports by an equality on the reporter, a page at a time', async () => {
  const fake = fakeFirestore([report('leaver', 1)]);

  await sweepLeaverReports(fake.store, 'leaver');

  assert.deepEqual(fake.queries.map(shapeOf), [
    {
      filters: [{ field: 'reportedBy', op: '==', value: 'leaver' }],
      orders: [],
      limit: REPORT_SWEEP_PAGE_SIZE,
    },
  ]);
});

/** The leaver's `n` reports, ten to a five-minute window as the volume cap allows. */
const leaverReports = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    ...report('leaver', 1),
    id: reportId('leaver', i % 10, WINDOW + Math.floor(i / 10)),
  }));

/**
 * A heavy reporter can leave more than one batch's worth. Each page leaves the
 * result set, so the pass re-queries from the start — no cursor — until a
 * short page says there is nothing left.
 */
test('pages through more reports than one batch can hold, re-querying from the start', async () => {
  const fake = fakeFirestore([...leaverReports(600), report('bob', 1)]);

  const result = await sweepLeaverReports(fake.store, 'leaver');

  assert.deepEqual(result, { anonymised: 600 });
  assert.deepEqual(
    fake.commits.map(({ creates, deletes }) => creates.length + deletes.length),
    [500, 500, 200],
  );
  assert.equal(new Set(fake.queries.map((query) => JSON.stringify(shapeOf(query)))).size, 1);
  assert.deepEqual(
    fake.remaining().filter((doc) => 'reportedBy' in doc),
    [report('bob', 1)],
  );
});

test('a full last page reads once more and commits nothing further', async () => {
  const fake = fakeFirestore(leaverReports(REPORT_SWEEP_PAGE_SIZE));

  assert.deepEqual(await sweepLeaverReports(fake.store, 'leaver'), {
    anonymised: REPORT_SWEEP_PAGE_SIZE,
  });
  assert.equal(fake.queries.length, 2);
  assert.equal(fake.commits.length, 1);
});

/**
 * **Bounded, and failing rather than pausing at the bound**: `deleteAccount`
 * has no tomorrow, so the pass throws after committing what it did, the
 * account is not deleted, and a retry carries on where this stopped — and
 * finishes. A pass with no bound loops for ever on a page that never leaves
 * the set.
 */
test('throws at its ceiling after committing what it did, and a retry finishes the rest', async () => {
  const total = REPORT_SWEEP_PAGE_SIZE * REPORT_SWEEP_MAX_PAGES + 100;
  const fake = fakeFirestore(leaverReports(total));

  await assert.rejects(sweepLeaverReports(fake.store, 'leaver'), (error: unknown) => {
    assert.ok(error instanceof LeaverReportSweepIncompleteError);
    assert.equal(error.anonymised, REPORT_SWEEP_PAGE_SIZE * REPORT_SWEEP_MAX_PAGES);
    return true;
  });
  assert.equal(fake.queries.length, REPORT_SWEEP_MAX_PAGES);
  assert.equal(fake.remaining().filter((doc) => 'reportedBy' in doc).length, 100);

  assert.deepEqual(await sweepLeaverReports(fake.store, 'leaver'), { anonymised: 100 });
  assert.equal(fake.remaining().length, total, 'nothing deleted outright, across both calls');
  assert.ok(fake.remaining().every((doc) => !('reportedBy' in doc)));
});

test('an account that never reported anything costs one query and writes nothing', async () => {
  const fake = fakeFirestore([report('bob', 40)]);

  assert.deepEqual(await sweepLeaverReports(fake.store, 'leaver'), { anonymised: 0 });
  assert.deepEqual(fake.commits, []);
});

// ---------------------------------------------------------------------------
// The export.
// ---------------------------------------------------------------------------

/**
 * Every report that still names the account, whole: its last thirty days of
 * them, and one the daily pass has not reached yet. An anonymised one is
 * nobody's.
 */
test('export returns every report that still names the account, whole, and nothing else', async () => {
  const fake = fakeFirestore([
    report('alice', 3, 0, { detail: 'Wrong year.' }),
    report('alice', 31, 1),
    report('bob', 3),
    { id: 'Xq3vL9aT2bRk8mNc4PdE', questionId: 'q1', reason: 'spam', createdAt: dayOf(40) },
  ]);

  assert.deepEqual(await questionReportsFor(fake.store, 'alice'), [
    report('alice', 3, 0, { detail: 'Wrong year.' }),
    report('alice', 31, 1),
  ]);
  assert.deepEqual(fake.commits, [], 'an export writes nothing');
});

test('export of an account that never reported anything is an empty list', async () => {
  const fake = fakeFirestore([report('bob', 3)]);

  assert.deepEqual(await questionReportsFor(fake.store, 'alice'), []);
});
