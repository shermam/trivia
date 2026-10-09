import { FieldPath } from 'firebase-admin/firestore';
import { isSafeDocumentId } from './play-history';

/**
 * When a `question_reports` document stops naming the account that filed it,
 * and the three readers that act on that (`FEAT-042`): the daily pass
 * `sweepPlayHistory` runs, the leaver's pass in `deleteAccount`, and the
 * section `exportAccountData` returns.
 *
 * **"Decided" is the reported question's own status, never the report's.** A
 * report carries no status and nothing gives it one — there is deliberately
 * no "handled" flag (`data-model.md` § `question_reports`). What finishes a
 * report is that the question it names has reached a reviewer's terminal
 * decision, `approved` or `rejected`, or no longer exists at all. Until then
 * the report keeps its reporter, because that is the window in which knowing
 * one account from many still matters to a reviewer.
 *
 * **Anonymising is a copy and a delete, not a field edit.** A report's id is
 * `{window}-{slot}-{uid}` — the volume cap (finding A3) lives in the id — so
 * deleting `reportedBy` would leave the uid sitting in the document name,
 * readable by every reviewer and the console. The copy goes to a fresh
 * auto-id, which no client create can produce (`firestore.rules` demands both
 * the `{window}-{slot}-{uid}` id and `reportedBy`), and carries only the four
 * content keys below.
 *
 * Structural over the Admin SDK rather than tied to it, so the queries, the
 * decisions and the batching are all unit-tested against a fake that applies
 * the filters literally (`report-anonymisation.test.ts`) — the reasoning
 * `question-votes.ts` gives for the same shape.
 */

export const QUESTION_REPORTS_COLLECTION = 'question_reports';

const CUSTOM_QUESTIONS_COLLECTION = 'custom_questions';

/**
 * How many reports one page reads and one batch commits.
 *
 * An anonymisation is **two** writes — the copy and the delete of the
 * original — and a `WriteBatch` holds 500, so 250 reports fill one batch
 * exactly. The leaver's pass reads the same page, where a report costs one
 * write or two.
 */
export const REPORT_SWEEP_PAGE_SIZE = 250;

/**
 * A ceiling on pages per daily run, so one invocation cannot run until the
 * platform kills it: 5,000 reports, far more than are filed between two runs.
 * Anything left over is the next run's, which is why stopping early is safe —
 * a report that is not anonymised today is anonymised tomorrow.
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

/**
 * What a sweep knows about the question a report names: its stored status,
 * or `null` when there is no such question — deleted since the report was
 * filed, or named by an id no document can have.
 */
export type ReportedQuestion = { status?: unknown } | null;

/**
 * Whether a reviewer has decided the question, so that nothing about it is
 * still waiting on anybody.
 *
 * A question that is gone counts as decided: there is no review left for it,
 * so there is nothing the reporter's identity could still be needed for. Any
 * status other than the two terminal ones — `pending`, or a value this code
 * does not know — counts as undecided, which is the cautious reading of a
 * status nobody has defined yet.
 */
export function isDecidedQuestion(question: ReportedQuestion): boolean {
  return question === null || question.status === 'approved' || question.status === 'rejected';
}

/**
 * **The decision this feature turns on**: given the question a report names,
 * may the report still say who filed it?
 *
 * Only while the question is undecided. Note what that means in practice:
 * players are only ever served approved questions, so most reports name a
 * question that is decided already and lose their reporter at the first daily
 * run after they are filed. The ones that wait are about a question back under
 * review — an approved question its author has since edited returns to
 * `pending` — and they wait only until a reviewer decides it.
 */
export function isStillAttributable(question: ReportedQuestion): boolean {
  return !isDecidedQuestion(question);
}

/** What `deleteAccount` does with one of the leaver's reports. */
export type LeaverReportFate = 'delete' | 'anonymise';

/**
 * A report whose question is decided has done its job, so it goes with its
 * author. One whose question is still under review is evidence a reviewer has
 * yet to act on, so it stays — without the author — rather than letting an
 * account erase a pending complaint by leaving (administrator decision, 9
 * October 2026).
 */
export function leaverReportFate(question: ReportedQuestion): LeaverReportFate {
  return isDecidedQuestion(question) ? 'delete' : 'anonymise';
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
  getAll(...refsOrOptions: (ReportRef | { fieldMask: string[] })[]): Promise<QuestionSnapshot[]>;
  batch(): ReportBatch;
}

export interface ReportQuery {
  where(field: string, op: '==' | '>', value: string): ReportQuery;
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

export interface QuestionSnapshot {
  id: string;
  exists: boolean;
  get(field: string): unknown;
}

export interface ReportBatch {
  create(ref: ReportRef, data: Record<string, unknown>): unknown;
  delete(ref: ReportRef, precondition?: { exists: boolean }): unknown;
  commit(): Promise<unknown>;
}

/** The id of the question a report names, when it is one a document could have. */
function questionIdOf(report: ReportSnapshot): string | null {
  const id = report.data()['questionId'];
  // Bounded the way Firestore bounds a document id — 1,500 bytes — rather than
  // by the 128 characters `firestore.rules` allows on create: a console edit is
  // not held to the rule, and a report naming an id no document can have names
  // a question that is not there, rather than one this code may not ask about.
  return typeof id === 'string' &&
    id.length > 0 &&
    Buffer.byteLength(id, 'utf8') <= 1500 &&
    isSafeDocumentId(id)
    ? id
    : null;
}

/**
 * The status of every question a page of reports names, read once per
 * question however many reports name it — several complaints about one
 * question is the normal case — and only the one field the decision needs.
 *
 * A report whose question id is unusable is absent from the map, which reads
 * as `null`: a question that is not there.
 */
async function questionsNamedBy(
  store: ReportStore,
  reports: ReportSnapshot[],
): Promise<Map<string, ReportedQuestion>> {
  const ids = [...new Set(reports.map(questionIdOf).filter((id): id is string => id !== null))];
  const questions = new Map<string, ReportedQuestion>();
  if (ids.length === 0) {
    // `getAll` refuses to be called with no references at all.
    return questions;
  }
  const collection = store.collection(CUSTOM_QUESTIONS_COLLECTION);
  const snapshots = await store.getAll(...ids.map((id) => collection.doc(id)), {
    fieldMask: ['status'],
  });
  for (const snapshot of snapshots) {
    questions.set(snapshot.id, snapshot.exists ? { status: snapshot.get('status') } : null);
  }
  return questions;
}

function questionFor(
  questions: Map<string, ReportedQuestion>,
  report: ReportSnapshot,
): ReportedQuestion {
  const id = questionIdOf(report);
  return id === null ? null : (questions.get(id) ?? null);
}

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
  /** Reports read that still named their reporter. */
  examined: number;
  /** Of those, how many were copied without it and their original deleted. */
  anonymised: number;
  /** Of those, how many name an undecided question and keep their reporter. */
  kept: number;
}

/**
 * The daily pass: copies every report whose question is decided without its
 * reporter, and deletes the original.
 *
 * **It reads from the reports' side.** The work is the set of reports that
 * still name somebody — `reportedBy` present, which an anonymised copy never
 * has — and that set is bounded by what has been filed or decided since the
 * last run plus the few about questions under review. Walking the decided
 * *questions* instead would read the whole approved bank every day to find
 * the handful of reports that changed.
 *
 * **It pages on a cursor**, `(reportedBy, document id)`, because the reports
 * it keeps stay in the set: a page made entirely of reports about undecided
 * questions would otherwise come back first on every pass, and the decided
 * ones behind it would never be reached. The order rides the automatic
 * single-field index on `reportedBy` — no composite, and
 * `firestore-tests/indexes.spec.ts` pins that nothing exempts the field.
 *
 * Idempotent: an anonymised copy has no `reportedBy`, so the query never
 * returns it, and a page whose commit failed changed nothing and is simply
 * read again by the next run.
 */
export async function anonymiseDecidedReports(store: ReportStore): Promise<ReportSweepResult> {
  const result: ReportSweepResult = { examined: 0, anonymised: 0, kept: 0 };
  let after: ReportSnapshot | undefined;

  for (let pass = 0; pass < REPORT_SWEEP_MAX_PASSES; pass += 1) {
    let query = store
      .collection(QUESTION_REPORTS_COLLECTION)
      .where('reportedBy', '>', '')
      .orderBy('reportedBy')
      .orderBy(FieldPath.documentId());
    if (after !== undefined) {
      query = query.startAfter(after);
    }
    const page = await query.limit(REPORT_SWEEP_PAGE_SIZE).get();
    if (page.docs.length === 0) {
      break;
    }

    const questions = await questionsNamedBy(store, page.docs);
    const batch = store.batch();
    let anonymised = 0;
    for (const report of page.docs) {
      if (isStillAttributable(questionFor(questions, report))) {
        result.kept += 1;
      } else {
        anonymiseInto(batch, store, report);
        anonymised += 1;
      }
    }
    if (anonymised > 0) {
      await batch.commit();
    }

    result.examined += page.docs.length;
    result.anonymised += anonymised;
    after = page.docs[page.docs.length - 1];
    if (page.docs.length < REPORT_SWEEP_PAGE_SIZE) {
      break;
    }
  }

  return result;
}

/** What `deleteAccount` did with the leaver's reports. */
export interface LeaverReportResult {
  deleted: number;
  anonymised: number;
}

/** The reports that still name `uid`: the one equality the automatic index on `reportedBy` serves. */
function reportsBy(store: ReportStore, uid: string): ReportQuery {
  return store.collection(QUESTION_REPORTS_COLLECTION).where('reportedBy', '==', uid);
}

/**
 * The leaver's pass, for `deleteAccount`: every report that still names the
 * account either goes ({@link leaverReportFate}: its question is decided) or
 * stays without the account's identity (its question is still under review).
 * Afterwards no report names the uid — in a field or in an id.
 *
 * **Found by `reportedBy`, not by id.** The uid is the id's *suffix*, and
 * nothing can query a document id by its suffix; the field is on every report,
 * because the create rule requires it. Paged and batched, and re-queried from
 * the start each time, because every report a page reads leaves the result
 * set — deleted or copied without the field — so there is no cursor to carry,
 * and a short page is the end.
 */
export async function sweepLeaverReports(
  store: ReportStore,
  uid: string,
): Promise<LeaverReportResult> {
  const result: LeaverReportResult = { deleted: 0, anonymised: 0 };

  for (;;) {
    const page = await reportsBy(store, uid).limit(REPORT_SWEEP_PAGE_SIZE).get();
    if (page.docs.length === 0) {
      return result;
    }

    const questions = await questionsNamedBy(store, page.docs);
    const batch = store.batch();
    for (const report of page.docs) {
      if (leaverReportFate(questionFor(questions, report)) === 'delete') {
        batch.delete(report.ref);
        result.deleted += 1;
      } else {
        anonymiseInto(batch, store, report);
        result.anonymised += 1;
      }
    }
    await batch.commit();

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
 * **Every one that still names it, whatever its question's status.** A report
 * about a decided question keeps the uid until the next daily run, and an
 * export that left it out would answer a data-access request with less than
 * is held. Once anonymised a report is nobody's, and is not here.
 *
 * One query rather than pages: the reports that still name an account are the
 * ones about a question under review, and those filed or decided since the
 * last daily run — filing is capped at ten per five minutes by the id.
 */
export async function questionReportsFor(
  store: ReportStore,
  uid: string,
): Promise<Record<string, unknown>[]> {
  const snapshot = await reportsBy(store, uid).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
