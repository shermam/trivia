import { FieldPath } from 'firebase-admin/firestore';
import { REPORTER_RETENTION_MS } from './report-retention';

/**
 * When a `question_reports` document stops naming the account that filed it,
 * and the three readers that act on that (`FEAT-042`): the daily pass
 * `sweepPlayHistory` runs, the leaver's pass in `deleteAccount`, and the
 * section `exportAccountData` returns.
 *
 * **A report keeps its reporter for thirty days from `createdAt`, then loses
 * it** (`REPORTER_RETENTION_DAYS`, administrator decision, 9 October 2026).
 * The window is for following a fresh report up; nothing about the reported
 * question decides it, because players are only served approved questions —
 * a rule keyed on the question's decision would strip nearly every report
 * within a day of filing, before anybody had read it. **An account that is
 * deleted loses its identity from every report at once**, however recent.
 * Either way the report itself stays: it is moderation evidence about a
 * question, and it must not vanish because the person who filed it left.
 *
 * **Anonymising is a copy and a delete, not a field edit.** A report's id is
 * `{window}-{slot}-{uid}` — the volume cap (finding A3) lives in the id — so
 * deleting `reportedBy` would leave the uid sitting in the document name,
 * readable by every reviewer and the console. The copy goes to a fresh
 * auto-id, which no client create can produce (`firestore.rules` demands both
 * the `{window}-{slot}-{uid}` id and `reportedBy`), and carries only the four
 * content keys below.
 *
 * Structural over the Admin SDK rather than tied to it, so the queries and the
 * batching are unit-tested against a fake that applies the filters literally
 * (`report-anonymisation.test.ts`) — the reasoning `question-votes.ts` gives
 * for the same shape.
 */

export const QUESTION_REPORTS_COLLECTION = 'question_reports';

/**
 * How many reports one page reads and one batch commits.
 *
 * An anonymisation is **two** writes — the copy and the delete of the
 * original — and a `WriteBatch` holds 500, so 250 reports fill one batch
 * exactly.
 */
export const REPORT_SWEEP_PAGE_SIZE = 250;

/**
 * A ceiling on pages per daily run, so one invocation cannot run until the
 * platform kills it: 5,000 reports read.
 *
 * **Reaching it is a failure, not a pause** — the difference from the
 * play-history pass, and the reason is the anonymised copies. A copy keeps its
 * original's `createdAt` (the reviewers' queue orders by it), so every copy
 * stays inside the expired range the pass reads, and the next run starts from
 * the oldest again: a run that stopped at the ceiling would stop at the same
 * place tomorrow. So the pass reports it ({@link ReportSweepIncompleteError})
 * rather than leaving the rest to a run that will never reach it.
 */
export const REPORT_SWEEP_MAX_PASSES = 20;

/**
 * The keys an anonymised copy carries: what was complained about, why, in the
 * reporter's words, and when. **An allowlist, so the copy is rebuilt rather
 * than passed through** — `reportedBy` stays behind with the original, and so
 * does any key a console edit added, since nothing says an unknown key is not
 * another way of naming somebody.
 */
export const ANONYMISED_REPORT_KEYS = ['questionId', 'reason', 'detail', 'createdAt'] as const;

/** The instant before which a report has outlived {@link REPORTER_RETENTION_MS}. */
export function reporterRetentionCutoff(nowMs: number): number {
  return nowMs - REPORTER_RETENTION_MS;
}

/**
 * **The decision this feature turns on**: given a report's `createdAt`, may it
 * still say who filed it?
 *
 * Yes until it is strictly older than the retention period — so a report
 * exactly thirty days old keeps its reporter for one more run — and yes for a
 * `createdAt` that is not a number at all. The second is the daily query's
 * reading, stated rather than left implicit: `createdAt < cutoff` matches
 * numbers only, and a predicate that disagreed with the query would describe a
 * rule the code does not have. The create rule requires a number near the time
 * of filing, so only a console edit can produce anything else.
 */
export function isStillAttributable(createdAt: unknown, nowMs: number): boolean {
  return !(typeof createdAt === 'number' && createdAt < reporterRetentionCutoff(nowMs));
}

/** The anonymised copy of a report: its content keys, and nothing else. */
export function anonymisedReport(data: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of ANONYMISED_REPORT_KEYS) {
    if (data[key] !== undefined) {
      copy[key] = data[key];
    }
  }
  return copy;
}

/**
 * The subset of the Admin SDK's `Firestore` the report sweeps use.
 *
 * Structural rather than the real type so it can be faked — the decisions
 * worth pinning are *which documents are read and what is written*, and an
 * emulator is the reason nobody would check them. Same reasoning as
 * `question-votes.ts` and `leaderboards.ts`.
 */
export interface ReportStore {
  collection(path: string): ReportCollection;
  batch(): ReportBatch;
}

export interface ReportQuery {
  where(field: string, op: '==' | '<', value: string | number): ReportQuery;
  orderBy(field: string | FieldPath): ReportQuery;
  startAfter(snapshot: ReportSnapshot): ReportQuery;
  limit(count: number): ReportQuery;
  get(): Promise<{ docs: ReportSnapshot[] }>;
}

export interface ReportCollection extends ReportQuery {
  /** With no argument, a fresh auto-id — which is what an anonymised copy gets. */
  doc(id?: string): ReportRef;
}

/** Opaque here: whatever the store's references are. */
export type ReportRef = object;

export interface ReportSnapshot {
  id: string;
  ref: ReportRef;
  data(): Record<string, unknown>;
}

export interface ReportBatch {
  create(ref: ReportRef, data: Record<string, unknown>): unknown;
  delete(ref: ReportRef, precondition?: { exists: boolean }): unknown;
  commit(): Promise<unknown>;
}

/** Whether a report still names somebody — an anonymised copy never does. */
const namesReporter = (report: ReportSnapshot): boolean =>
  report.data()['reportedBy'] !== undefined;

/**
 * Adds one anonymisation to a batch: the copy at a fresh auto-id, and the
 * delete of the original.
 *
 * **The delete demands that the original still exists**, and that is what
 * makes a re-run harmless rather than merely unlikely to repeat itself. The
 * daily pass and a leaver's `deleteAccount` can read the same report at the
 * same moment; whichever commits second finds the original gone, and because a
 * batch is atomic its copy is refused along with its delete. Without the
 * precondition both would commit, and the report would exist twice.
 */
function anonymiseInto(batch: ReportBatch, store: ReportStore, report: ReportSnapshot): void {
  batch.create(
    store.collection(QUESTION_REPORTS_COLLECTION).doc(),
    anonymisedReport(report.data()),
  );
  batch.delete(report.ref, { exists: true });
}

/** What one daily run did. */
export interface ReportSweepResult {
  /** Reports read, all of them filed before the cutoff. */
  examined: number;
  /** Of those, how many still named their reporter and were copied without it. */
  anonymised: number;
  /** Of those, how many were anonymised copies already, and were left alone. */
  alreadyAnonymous: number;
}

/**
 * The daily pass ran out of pages with reports past the cutoff still unread,
 * so some report older than the retention period may still name its reporter.
 * Thrown after everything the run could do has been committed.
 */
export class ReportSweepIncompleteError extends Error {
  constructor(readonly result: ReportSweepResult) {
    super(
      `report anonymisation read ${result.examined} report(s) — its ceiling — and stopped with ` +
        `older ones still unread (${result.anonymised} anonymised this run). Every run starts ` +
        `from the oldest, so it will stop at the same place tomorrow: the reports past the ` +
        `cutoff have outgrown one run.`,
    );
    this.name = 'ReportSweepIncompleteError';
  }
}

/**
 * The daily pass: copies every report filed more than thirty days ago that
 * still names its reporter, without the reporter, and deletes the original.
 *
 * **One range, on `createdAt`**: `where('createdAt', '<', cutoff)`, ordered by
 * `createdAt` and then the document id, `REPORT_SWEEP_PAGE_SIZE` to a page,
 * paged on a cursor within the run. That rides the automatic single-field
 * index on `createdAt` — the one the reviewers' queue already orders by — and
 * `firestore-tests/indexes.spec.ts` pins that nothing takes it away.
 *
 * **The anonymised copies are read and skipped.** A copy keeps `createdAt`, so
 * it stays in the range; it names nobody, so there is nothing to do with it.
 * That is also what makes the pass idempotent: a re-run finds only copies
 * where it anonymised, and a page whose commit failed changed nothing and is
 * read again. The cost is that a run reads every report older than the
 * cutoff, copies included — see {@link REPORT_SWEEP_MAX_PASSES} for where that
 * stops scaling and what happens when it does.
 */
export async function anonymiseExpiredReports(
  store: ReportStore,
  nowMs: number,
): Promise<ReportSweepResult> {
  const cutoff = reporterRetentionCutoff(nowMs);
  const result: ReportSweepResult = { examined: 0, anonymised: 0, alreadyAnonymous: 0 };
  let after: ReportSnapshot | undefined;

  const expired = (limit: number) => {
    const query = store
      .collection(QUESTION_REPORTS_COLLECTION)
      .where('createdAt', '<', cutoff)
      .orderBy('createdAt')
      .orderBy(FieldPath.documentId());
    return (after === undefined ? query : query.startAfter(after)).limit(limit).get();
  };

  for (let pass = 0; pass < REPORT_SWEEP_MAX_PASSES; pass += 1) {
    const page = await expired(REPORT_SWEEP_PAGE_SIZE);

    const batch = store.batch();
    let anonymised = 0;
    for (const report of page.docs) {
      if (namesReporter(report)) {
        anonymiseInto(batch, store, report);
        anonymised += 1;
      } else {
        result.alreadyAnonymous += 1;
      }
    }
    if (anonymised > 0) {
      await batch.commit();
    }
    result.examined += page.docs.length;
    result.anonymised += anonymised;

    // A short page is the end of the range: the query asked for a full one.
    if (page.docs.length < REPORT_SWEEP_PAGE_SIZE) {
      return result;
    }
    after = page.docs[page.docs.length - 1];
  }

  // At the ceiling with a full last page, one more read says whether anything
  // is left, so a range of exactly the ceiling's size is not reported as a
  // failure. It reads a page rather than one document because the copies this
  // run wrote keep their originals' `createdAt`, and an auto-id can sort after
  // the cursor: the last original's copy may be the next document, naming
  // nobody, with nothing behind it.
  const rest = await expired(REPORT_SWEEP_PAGE_SIZE);
  if (rest.docs.length < REPORT_SWEEP_PAGE_SIZE && !rest.docs.some(namesReporter)) {
    return result;
  }
  throw new ReportSweepIncompleteError(result);
}

/** What `deleteAccount` did with the leaver's reports. */
export interface LeaverReportResult {
  anonymised: number;
}

/** The reports that still name `uid`: the one equality the automatic index on `reportedBy` serves. */
function reportsBy(store: ReportStore, uid: string): ReportQuery {
  return store.collection(QUESTION_REPORTS_COLLECTION).where('reportedBy', '==', uid);
}

/**
 * The leaver's pass, for `deleteAccount`: every report that still names the
 * account is copied without it and its original deleted — however recent,
 * and whatever became of the question it is about. **Never a delete**: a
 * report is evidence about somebody else's content, and it must not vanish
 * because the person who filed it left (administrator decision, 9 October
 * 2026). Afterwards no report names the uid — in a field or in an id.
 *
 * **Found by `reportedBy`, not by id.** The uid is the id's *suffix*, and
 * nothing can query a document id by its suffix; the field is on every report
 * filed, because the create rule requires it. Paged and batched, and
 * re-queried from the start each time, because every report a page reads
 * leaves the result set — so there is no cursor to carry, and a short page is
 * the end.
 */
export async function sweepLeaverReports(
  store: ReportStore,
  uid: string,
): Promise<LeaverReportResult> {
  const result: LeaverReportResult = { anonymised: 0 };

  for (;;) {
    const page = await reportsBy(store, uid).limit(REPORT_SWEEP_PAGE_SIZE).get();
    if (page.docs.length === 0) {
      return result;
    }

    const batch = store.batch();
    for (const report of page.docs) {
      anonymiseInto(batch, store, report);
    }
    await batch.commit();
    result.anonymised += page.docs.length;

    if (page.docs.length < REPORT_SWEEP_PAGE_SIZE) {
      return result;
    }
  }
}

/**
 * Every report that still names the account, whole, for `exportAccountData` —
 * found the way {@link sweepLeaverReports} finds them, so export and deletion
 * cannot disagree about which reports are the account's.
 *
 * One query rather than pages: a report names its reporter for thirty days,
 * and filing is capped at ten per five minutes by the id, so the set is the
 * account's last month of reports and no more. Once anonymised a report is
 * nobody's, and is not here.
 */
export async function questionReportsFor(
  store: ReportStore,
  uid: string,
): Promise<Record<string, unknown>[]> {
  const snapshot = await reportsBy(store, uid).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
