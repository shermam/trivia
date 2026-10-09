import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FieldPath } from 'firebase-admin/firestore';
import {
  ANONYMISED_REPORT_KEYS,
  QUESTION_REPORTS_COLLECTION,
  REPORT_SWEEP_MAX_PASSES,
  REPORT_SWEEP_PAGE_SIZE,
  ReportSweepIncompleteError,
  anonymiseExpiredReports,
  anonymisedReport,
  isStillAttributable,
  questionReportsFor,
  reporterRetentionCutoff,
  sweepLeaverReports,
  type ReportQuery,
  type ReportSnapshot,
  type ReportStore,
} from './report-anonymisation';
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
 * the filters, the orderings and the cursor literally — numbers as numbers, a
 * range matching numbers only, as Firestore's does — refuses an oversized
 * batch and an empty one, and honours a delete's precondition the way a real
 * batch does, atomically for every write in it. The e2e suite runs the
 * leaver's pass and the export against the emulator
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
  op: '==' | '<';
  value: string | number;
}

type Order = string | FieldPath;

const isDocumentId = (order: Order): boolean =>
  order instanceof FieldPath && order.isEqual(FieldPath.documentId());

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
  cursor: boolean;
  limit?: number;
}

/**
 * A `question_reports` collection, faked to the depth the sweeps use it.
 *
 * `autoIdPrefix` decides where a copy's fresh id sorts against the `{window}-…`
 * ids reports are filed under: before them by default, which keeps the page
 * arithmetic below readable, or after them, which is the case where a copy can
 * come back on the page after the one that wrote it. Real auto-ids land on
 * either side.
 */
function fakeFirestore(seed: ({ id: string } & Doc)[], { autoIdPrefix = '0' } = {}) {
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
      const range = filters.find((filter) => filter.op === '<');
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
        .filter(([, data]) => filters.every((filter) => matches(data, filter)))
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
            const auto = `${autoIdPrefix}auto${String(nextAutoId).padStart(15, '0')}`;
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

/** The four content keys of a report, which is what an anonymised copy must still carry. */
const contentOf = ({ id: _id, reportedBy: _by, ...content }: { id: string } & Doc) => content;

const byCreatedAt = (a: Doc, b: Doc) => compareValues(a['createdAt'], b['createdAt']);

// ---------------------------------------------------------------------------
// The decision. Both sides of the boundary, because a predicate that answered
// "expired" to everything would satisfy a suite of nothing but expired cases.
// ---------------------------------------------------------------------------

test('a report keeps its reporter for thirty days', () => {
  assert.equal(REPORTER_RETENTION_DAYS, 30);
  assert.equal(REPORTER_RETENTION_MS, 30 * DAY);
  assert.equal(reporterRetentionCutoff(NOW), NOW - 30 * DAY);
});

test('a report filed a moment ago, or a day inside the period, still names its reporter', () => {
  assert.equal(isStillAttributable(NOW, NOW), true);
  assert.equal(isStillAttributable(NOW - DAY, NOW), true);
  assert.equal(isStillAttributable(reporterRetentionCutoff(NOW) + DAY, NOW), true);
});

/**
 * Exactly thirty days old is **not** expired, and the direction is pinned
 * rather than left to whichever comparison somebody writes next: the daily
 * query is `where('createdAt', '<', cutoff)`, and a predicate disagreeing with
 * it would describe a boundary the code does not have.
 */
test('a report exactly thirty days old keeps its reporter for one more run', () => {
  assert.equal(isStillAttributable(reporterRetentionCutoff(NOW), NOW), true);
});

test('a millisecond older than that, it does not', () => {
  assert.equal(isStillAttributable(reporterRetentionCutoff(NOW) - 1, NOW), false);
  assert.equal(isStillAttributable(NOW - 60 * DAY, NOW), false);
});

/**
 * The query's reading of a `createdAt` that is not a number: `<` against a
 * number matches numbers only, so such a report is never read and keeps its
 * reporter. Only a console edit can write one — the create rule requires a
 * number near the time of filing — and the predicate says what the code does.
 */
test('a createdAt that is not a number is never expired', () => {
  for (const createdAt of [undefined, null, '1700000000000', { seconds: 1 }]) {
    assert.equal(isStillAttributable(createdAt, NOW), true, `createdAt ${String(createdAt)}`);
  }
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

test('anonymises every report older than thirty days and leaves the younger ones alone', async () => {
  const fake = fakeFirestore([
    report('alice', 40, 0, { detail: 'The answer is misspelled.' }),
    report('bob', 31, 0, { reason: 'inappropriate', questionId: 'q2' }),
    report('carol', 5),
    report('dave', 30),
  ]);

  const result = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(result, { examined: 2, anonymised: 2, alreadyAnonymous: 0 });
  const left = fake.remaining();
  // The young one, and the one exactly thirty days old, are exactly where they were.
  assert.deepEqual(
    left.filter((doc) => 'reportedBy' in doc),
    [report('carol', 5), report('dave', 30)].sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
  // The other two are copies carrying their content and nothing else.
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
        createdAt: NOW - 40 * DAY,
      },
      { questionId: 'q2', reason: 'inappropriate', createdAt: NOW - 31 * DAY },
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

test('is idempotent: a second run reads the copies and writes nothing', async () => {
  const fake = fakeFirestore([report('alice', 40), report('bob', 3)]);

  await anonymiseExpiredReports(fake.store, NOW);
  const afterFirst = fake.remaining();
  const second = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(second, { examined: 1, anonymised: 0, alreadyAnonymous: 1 });
  assert.deepEqual(fake.remaining(), afterFirst);
  assert.equal(fake.commits.length, 1, 'only the first run committed anything');
});

/**
 * A copy keeps its original's `createdAt`, so it stays in the range the pass
 * reads — and it names nobody, so there is nothing to do with it. Leaving it
 * alone is the whole of the work.
 */
test('reads an anonymised copy and leaves it alone', async () => {
  const anonymised = {
    id: 'Xq3vL9aT2bRk8mNc4PdE',
    questionId: 'q1',
    reason: 'other',
    createdAt: NOW - 90 * DAY,
  };
  const fake = fakeFirestore([anonymised]);

  const result = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(result, { examined: 1, anonymised: 0, alreadyAnonymous: 1 });
  assert.deepEqual(fake.remaining(), [anonymised]);
  assert.deepEqual(fake.commits, []);
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

test('every read is bounded: a range on createdAt, ordered for its cursor, limited', async () => {
  const fake = fakeFirestore([report('alice', 40), report('bob', 2)]);

  await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(fake.queries, [
    {
      filters: [{ field: 'createdAt', op: '<', value: reporterRetentionCutoff(NOW) }],
      orders: ['createdAt', '__name__'],
      cursor: false,
      limit: REPORT_SWEEP_PAGE_SIZE,
    },
  ]);
});

test('an empty collection costs one query and writes nothing', async () => {
  const fake = fakeFirestore([]);

  assert.deepEqual(await anonymiseExpiredReports(fake.store, NOW), {
    examined: 0,
    anonymised: 0,
    alreadyAnonymous: 0,
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

/** `n` anonymised copies filed `daysAgo` days back. */
const copiesFiled = (daysAgo: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `copy${String(i).padStart(16, '0')}`,
    questionId: 'q1',
    reason: 'other',
    createdAt: NOW - daysAgo * DAY + i,
  }));

/**
 * **The batching.** 600 anonymisations are 1,200 writes, which cannot go in one
 * `WriteBatch`: the pass has to page, 250 reports — 500 writes — at a time,
 * and a full page has to be followed by another query rather than taken as the
 * end of the run.
 */
test('pages a backlog larger than one batch, 250 reports and 500 writes at a time', async () => {
  const fake = fakeFirestore(reportsFiled(40, 600, 'u'));

  const result = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(result, { examined: 600, anonymised: 600, alreadyAnonymous: 0 });
  assert.deepEqual(
    fake.commits.map(({ creates, deletes }) => creates.length + deletes.length),
    [500, 500, 200],
  );
  assert.ok(fake.remaining().every((doc) => !('reportedBy' in doc)));
});

/**
 * **The cursor.** The copies older reports left behind stay in the range and
 * sort first, so a pass that re-read from the top would read the same page of
 * them on every query and never reach the expired reports behind it.
 */
test('pages past a full page of copies to the expired reports behind them', async () => {
  const fake = fakeFirestore([...copiesFiled(90, 300), ...reportsFiled(40, 5, 'z')]);

  const result = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(result, { examined: 305, anonymised: 5, alreadyAnonymous: 300 });
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
  const fake = fakeFirestore(reportsFiled(40, REPORT_SWEEP_PAGE_SIZE, 'u'));

  await anonymiseExpiredReports(fake.store, NOW);

  assert.equal(fake.queries.length, 2);
  assert.equal(fake.commits.length, 1);
});

/**
 * **The ceiling is a failure, not a pause.** Every run starts from the oldest
 * report, and the copies keep their place in the range, so a run that stopped
 * at the ceiling would stop at the same place the next day, with the reports
 * behind it still naming their reporters — a published thirty days quietly not
 * kept. So it says so, after committing what it could: the first run here
 * anonymises 5,000 and fails, and the second reads those 5,000 copies, reaches
 * nothing new and fails again.
 */
test('fails loudly at the ceiling, and again the next day, rather than stopping quietly', async () => {
  const backlog = REPORT_SWEEP_PAGE_SIZE * (REPORT_SWEEP_MAX_PASSES + 2);
  const fake = fakeFirestore(reportsFiled(40, backlog, 'u'));

  await assert.rejects(anonymiseExpiredReports(fake.store, NOW), (error: unknown) => {
    assert.ok(error instanceof ReportSweepIncompleteError);
    assert.deepEqual(error.result, {
      examined: REPORT_SWEEP_PAGE_SIZE * REPORT_SWEEP_MAX_PASSES,
      anonymised: REPORT_SWEEP_PAGE_SIZE * REPORT_SWEEP_MAX_PASSES,
      alreadyAnonymous: 0,
    });
    assert.match(error.message, /outgrown one run/);
    return true;
  });
  assert.equal(
    fake.remaining().filter((doc) => 'reportedBy' in doc).length,
    REPORT_SWEEP_PAGE_SIZE * 2,
  );

  await assert.rejects(anonymiseExpiredReports(fake.store, NOW), (error: unknown) => {
    assert.ok(error instanceof ReportSweepIncompleteError);
    assert.equal(error.result.anonymised, 0);
    return true;
  });
});

test('a range of exactly the ceiling’s size is finished, not failed', async () => {
  const fake = fakeFirestore(
    reportsFiled(40, REPORT_SWEEP_PAGE_SIZE * REPORT_SWEEP_MAX_PASSES, 'u'),
  );

  const result = await anonymiseExpiredReports(fake.store, NOW);

  assert.equal(result.anonymised, REPORT_SWEEP_PAGE_SIZE * REPORT_SWEEP_MAX_PASSES);
  assert.equal(fake.queries.length, REPORT_SWEEP_MAX_PASSES + 1, 'one read past the ceiling');
  assert.equal(fake.commits.length, REPORT_SWEEP_MAX_PASSES, 'and nothing written by it');
});

/**
 * …even when the last original's copy sorts after the cursor and is the one
 * document that read finds: it names nobody, and nothing is behind it. With
 * copies sorting after their originals, every page after the first spends one
 * slot re-reading the previous page's last copy, so twenty full pages finish
 * 250 + 19 × 249 reports exactly.
 */
test('the read past the ceiling is not fooled by the copy of the last original', async () => {
  const exactly =
    REPORT_SWEEP_PAGE_SIZE + (REPORT_SWEEP_MAX_PASSES - 1) * (REPORT_SWEEP_PAGE_SIZE - 1);
  const fake = fakeFirestore(reportsFiled(40, exactly, 'u'), { autoIdPrefix: 'z' });

  const result = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(result, {
    examined: REPORT_SWEEP_PAGE_SIZE * REPORT_SWEEP_MAX_PASSES,
    anonymised: exactly,
    alreadyAnonymous: REPORT_SWEEP_MAX_PASSES - 1,
  });
  assert.ok(fake.remaining().every((doc) => !('reportedBy' in doc)));
});

/**
 * A copy shares its original's `createdAt`, and a fresh auto-id can sort after
 * the original's id — so the copy of a page's last report can turn up first on
 * the next page. It names nobody, so it is counted and left alone: read twice,
 * copied once.
 */
test('a copy that turns up again on the next page is left alone, not copied twice', async () => {
  const fake = fakeFirestore(reportsFiled(40, 300, 'u'), { autoIdPrefix: 'z' });

  const result = await anonymiseExpiredReports(fake.store, NOW);

  assert.deepEqual(result, { examined: 301, anonymised: 300, alreadyAnonymous: 1 });
  assert.equal(fake.remaining().length, 300, 'one copy per report, and no original left');
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
  // The leaver's three survive as complaints, content intact.
  assert.deepEqual(
    left
      .filter((doc) => !('reportedBy' in doc))
      .map(contentOf)
      .sort(byCreatedAt),
    [
      { questionId: 'q1', reason: 'other', createdAt: NOW - 29 * DAY },
      {
        questionId: 'q1',
        reason: 'incorrect',
        detail: 'Two answers are right.',
        createdAt: NOW - 12 * DAY,
      },
      { questionId: 'q1', reason: 'incorrect', createdAt: NOW },
    ],
  );
});

test('finds the leaver’s reports by an equality on the reporter, a page at a time', async () => {
  const fake = fakeFirestore([report('leaver', 1)]);

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
  assert.ok(fake.queries.every((query) => !query.cursor));
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
    { id: 'Xq3vL9aT2bRk8mNc4PdE', questionId: 'q1', reason: 'spam', createdAt: NOW - 40 * DAY },
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
