import {
  EXPIRED_REPORTS_ORDER,
  QUESTION_REPORTS_COLLECTION,
  REPORT_FILED_AT_FIELD,
  REPORT_REPORTER_FIELD,
} from './report-query';
import { REPORTER_RETENTION_MS } from './report-retention';

export { QUESTION_REPORTS_COLLECTION } from './report-query';

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
 * Either way the report itself is kept: it is the record that something needed
 * looking at, and it must not vanish because the person who filed it left.
 *
 * **Anonymising is a copy and a delete, not a field edit.** A report's id is
 * `{window}-{slot}-{uid}` — the volume cap (finding A3) lives in the id — so
 * deleting `reportedBy` would leave the uid sitting in the document name,
 * readable by every reviewer and the console. The copy goes to a fresh
 * auto-id, which no client create can produce (`firestore.rules` demands both
 * the `{window}-{slot}-{uid}` id and `reportedBy`), and carries only the four
 * content keys below — `createdAt` cut to the day ({@link startOfUtcDay}).
 *
 * Structural over the Admin SDK rather than tied to it, so the queries and the
 * batching are unit-tested against a fake that applies the filters literally
 * (`report-anonymisation.test.ts`) — the reasoning `question-votes.ts` gives
 * for the same shape.
 */

/**
 * How many reports one page reads and one batch commits.
 *
 * An anonymisation is **two** writes — the copy and the delete of the
 * original — and a `WriteBatch` holds 500, so 250 reports fill one batch
 * exactly.
 */
export const REPORT_SWEEP_PAGE_SIZE = 250;

/**
 * A ceiling on pages per call, so one invocation cannot run until the platform
 * kills it: 5,000 reports.
 *
 * What reaching it means differs between the two passes. **The daily pass
 * pauses**: every page it anonymises leaves the set it reads, so tomorrow's
 * run starts where today's stopped, and nothing is lost — the anonymisation is
 * merely a day later, as with the play-history sweep. **The leaver's pass
 * fails** ({@link LeaverReportSweepIncompleteError}), because `deleteAccount`
 * has no tomorrow: it stops before the account is deleted, and the caller
 * retries, which continues where this stopped.
 */
export const REPORT_SWEEP_MAX_PAGES = 20;

/**
 * The keys an anonymised copy carries: what was complained about, why, in the
 * reporter's words, and the day it was filed. **An allowlist, so the copy is
 * rebuilt rather than passed through** — `reportedBy` stays behind with the
 * original, and so does any key a console edit added, since nothing says an
 * unknown key is not another way of naming somebody.
 */
export const ANONYMISED_REPORT_KEYS = ['questionId', 'reason', 'detail', 'createdAt'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant before which a report has outlived {@link REPORTER_RETENTION_MS}. */
export function reporterRetentionCutoff(nowMs: number): number {
  return nowMs - REPORTER_RETENTION_MS;
}

/**
 * The start of the UTC day `ms` falls in, which is all an anonymised copy keeps
 * of when its report was filed (administrator decision, 9 October 2026).
 *
 * **The millisecond is itself a way of naming somebody.** The game-over screen
 * files a report and saves the player's score in the same session, and the
 * score's public leaderboard entry carries the uid and its own `createdAt` —
 * so a copy stamped to the millisecond could be matched to its reporter by
 * time by anybody able to read both, which every reviewer is. The day is what
 * the reviewers' queue needs to order by, and it is shared by every report
 * filed that day; reports from one day tie, and the queue's document-id
 * tiebreaker orders them.
 */
export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * The anonymised copy of a report: its content keys and nothing else, with
 * `createdAt` cut to the start of its UTC day.
 *
 * A `createdAt` that is not a number is copied as it is: the create rule
 * requires a number, so only a console edit can store anything else, and there
 * is no day to cut it to.
 */
export function anonymisedReport(data: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of ANONYMISED_REPORT_KEYS) {
    const value = data[key];
    if (value !== undefined) {
      copy[key] =
        key === REPORT_FILED_AT_FIELD && typeof value === 'number' ? startOfUtcDay(value) : value;
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
  orderBy(field: string): ReportQuery;
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

/**
 * Anonymises one page of reports in one batch: each copied to a fresh auto-id,
 * each original deleted.
 *
 * **The delete demands that the original still exists**, and that is what
 * makes a re-run harmless rather than merely unlikely to repeat itself. The
 * daily pass and a leaver's `deleteAccount` can read the same report at the
 * same moment; whichever commits second finds the original gone, and because a
 * batch is atomic its copy is refused along with its delete. Without the
 * precondition both would commit, and the report would exist twice.
 */
async function anonymisePage(store: ReportStore, page: ReportSnapshot[]): Promise<void> {
  const batch = store.batch();
  for (const report of page) {
    batch.create(
      store.collection(QUESTION_REPORTS_COLLECTION).doc(),
      anonymisedReport(report.data()),
    );
    batch.delete(report.ref, { exists: true });
  }
  await batch.commit();
}

/** What one daily run did. */
export interface ReportSweepResult {
  /** Reports copied without their reporter, their originals deleted. */
  anonymised: number;
  /**
   * Whether the run used every page it may and its last one was full. Not an
   * error: whatever is left is the next run's.
   */
  stoppedAtCeiling: boolean;
}

/**
 * Firestore refused the daily pass's query because its composite index is not
 * serving yet — the `(createdAt ASC, reportedBy ASC)` index on
 * `question_reports` that `firestore.indexes.json` declares.
 *
 * Expected exactly once: the merge deploy ships the index and the function
 * together, an index takes a while to build, and a run that lands in between is
 * refused with `FAILED_PRECONDITION`. Named so the log says which of the two it
 * is — the next run succeeding, or a deploy that never shipped the index.
 */
export class ReportSweepIndexNotReadyError extends Error {
  constructor(cause: unknown) {
    super(
      'report anonymisation was refused its query with FAILED_PRECONDITION: the ' +
        '(createdAt ASC, reportedBy ASC) index on question_reports is not serving. A run ' +
        'before the index has finished building fails this way and the next run succeeds; ' +
        'if it persists, firestore.indexes.json was not deployed.',
      { cause },
    );
    this.name = 'ReportSweepIndexNotReadyError';
  }
}

/**
 * Whether a query was refused for want of an index. The Admin SDK reports it
 * as gRPC status 9, `FAILED_PRECONDITION`, with a message that begins with the
 * status's name.
 */
export function isIndexNotReady(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === 9 ||
    code === 'failed-precondition' ||
    (typeof message === 'string' && message.includes('FAILED_PRECONDITION'))
  );
}

/**
 * The daily pass: copies every report filed more than thirty days ago without
 * its reporter, and deletes the original.
 *
 * **One query, re-sent from the start for every page**:
 * `where('createdAt', '<', cutoff)`, ordered by `createdAt` and then
 * `reportedBy` (`report-query.ts`), `REPORT_SWEEP_PAGE_SIZE` at a time. The
 * ordering on `reportedBy` leaves out every anonymised copy, because an
 * ordering filters for its field's existence and a copy has none — so a copy
 * is never read, however many accumulate, and every page anonymised leaves the
 * set. That is what makes re-querying from the start correct, makes the pass
 * idempotent (a re-run finds nothing it already did), and makes stopping at
 * the ceiling a pause rather than a failure: tomorrow's run starts where
 * today's stopped. A page whose commit failed changed nothing and is read
 * again next time.
 *
 * It needs the `(createdAt ASC, reportedBy ASC)` composite index, which
 * `firestore-tests/indexes.spec.ts` derives from the same constants and
 * requires `firestore.indexes.json` to declare. Until it serves, the query is
 * refused, and the run fails as {@link ReportSweepIndexNotReadyError}.
 */
export async function anonymiseExpiredReports(
  store: ReportStore,
  nowMs: number,
): Promise<ReportSweepResult> {
  const cutoff = reporterRetentionCutoff(nowMs);
  let anonymised = 0;

  for (let page = 0; page < REPORT_SWEEP_MAX_PAGES; page += 1) {
    const { docs } = await expiredReports(store, cutoff);
    if (docs.length > 0) {
      await anonymisePage(store, docs);
      anonymised += docs.length;
    }
    // A short page is the end of the range: the query asked for a full one.
    if (docs.length < REPORT_SWEEP_PAGE_SIZE) {
      return { anonymised, stoppedAtCeiling: false };
    }
  }
  return { anonymised, stoppedAtCeiling: true };
}

/** One page of reports filed before `cutoff` that still name their reporter. */
async function expiredReports(
  store: ReportStore,
  cutoff: number,
): Promise<{ docs: ReportSnapshot[] }> {
  let query = store
    .collection(QUESTION_REPORTS_COLLECTION)
    .where(REPORT_FILED_AT_FIELD, '<', cutoff);
  for (const field of EXPIRED_REPORTS_ORDER) {
    query = query.orderBy(field);
  }
  try {
    return await query.limit(REPORT_SWEEP_PAGE_SIZE).get();
  } catch (error) {
    throw isIndexNotReady(error) ? new ReportSweepIndexNotReadyError(error) : error;
  }
}

/** What `deleteAccount` did with the leaver's reports. */
export interface LeaverReportResult {
  anonymised: number;
}

/**
 * The leaver's pass used every page it may, the last of them full, so reports
 * may still name the account. Thrown after everything it did was committed, so
 * `deleteAccount` stops before the account is deleted and the caller can retry
 * — which carries on where this stopped, because every report anonymised has
 * left the set. (A leaver with exactly the ceiling's worth is told to retry
 * once, and the retry finds nothing left.)
 */
export class LeaverReportSweepIncompleteError extends Error {
  constructor(readonly anonymised: number) {
    super(
      `the leaver's report pass anonymised ${anonymised} report(s) and stopped at its ` +
        `ceiling of ${REPORT_SWEEP_MAX_PAGES} pages, so more may still name the account; ` +
        `deleteAccount stops here, and a retry continues where this stopped.`,
    );
    this.name = 'LeaverReportSweepIncompleteError';
  }
}

/** The reports that still name `uid`: the one equality the automatic index on `reportedBy` serves. */
function reportsBy(store: ReportStore, uid: string): ReportQuery {
  return store.collection(QUESTION_REPORTS_COLLECTION).where(REPORT_REPORTER_FIELD, '==', uid);
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
 * the end. **Bounded by {@link REPORT_SWEEP_MAX_PAGES}**, past which it throws
 * rather than loop: a page that failed to leave the set would otherwise be
 * read for ever.
 */
export async function sweepLeaverReports(
  store: ReportStore,
  uid: string,
): Promise<LeaverReportResult> {
  let anonymised = 0;

  for (let page = 0; page < REPORT_SWEEP_MAX_PAGES; page += 1) {
    const { docs } = await reportsBy(store, uid).limit(REPORT_SWEEP_PAGE_SIZE).get();
    if (docs.length > 0) {
      await anonymisePage(store, docs);
      anonymised += docs.length;
    }
    if (docs.length < REPORT_SWEEP_PAGE_SIZE) {
      return { anonymised };
    }
  }
  throw new LeaverReportSweepIncompleteError(anonymised);
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
