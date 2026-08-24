import { Injectable, inject } from '@angular/core';
import { Observable, defer, map } from 'rxjs';
import {
  CustomQuestionDoc,
  Difficulty,
  LeaderboardEntry,
  CustomQuestionWrite,
  NewCustomQuestionDoc,
  QuestionStatus,
  NewQuestionReportDoc,
} from '../models/question.model';
import {
  DOCUMENT_ID_FIELD,
  FirestoreRestClient,
  RestFieldFilter,
  RestQuery,
  isFirestorePermissionDenied,
} from './firestore-rest/firestore-rest.client';

const CUSTOM_QUESTIONS_COLLECTION = 'custom_questions';
/**
 * The per-timing-constraint boards (finding G7). Entries live at
 * `leaderboards/{board}/entries/{uid}` — a subcollection rather than a
 * `timeLimit` field on one flat collection, because the flat version needs a
 * composite index and index configuration is the one thing the emulator cannot
 * verify (`docs/data-model.md` §3).
 */
const LEADERBOARDS_COLLECTION = 'leaderboards';
const BOARD_ENTRIES_SUBCOLLECTION = 'entries';
const QUESTION_REPORTS_COLLECTION = 'question_reports';
// Must agree with the {window}-{slot} arithmetic in firestore.rules'
// sessionWindow()/the question_reports ID pattern — same contract as
// SubscriptionService's session documents (finding A3): if the two disagree,
// every report is refused, and the rules tests fail loudly.
const REPORT_WINDOW_MS = 300_000;
const REPORT_SLOTS_PER_WINDOW = 10;
const FIRESTORE_TIMEOUT_MS = 10_000;

/**
 * The hourly cap on question submissions, and the collection holding the
 * counter (`BACKLOG.md` item 3). Both have to agree with
 * `questionQuotaWindow()`/`maxQuestionsPerWindow()` in `firestore.rules`; if
 * they disagree, every submission is refused and the rules tests say so.
 */
const QUESTION_QUOTA_COLLECTION = 'custom_question_quota';
const QUESTION_QUOTA_WINDOW_MS = 3_600_000;
export const MAX_QUESTIONS_PER_HOUR = 20;

/**
 * The only status a player is served. `getCustomQuestions` filters on it, and
 * since item 4c `firestore.rules` refuses a read of `custom_questions` that
 * does not — rules are not filters, so an unfiltered query is rejected rather
 * than quietly trimmed.
 */
const STATUS_APPROVED: QuestionStatus = 'approved';

/**
 * The moderation status a submission is written with. Must equal
 * `statusOnSubmission()` in `firestore.rules`, which accepts nothing else on
 * create — if the two drift, every submission is refused, and the rules tests
 * plus `firebase.service.spec.ts` both pin the value so they cannot.
 *
 * `'pending'` as of item 4c: a contribution is stored but not served until a
 * reviewer approves it. Deliberately no longer written as `STATUS_APPROVED` —
 * the two had the same value for exactly one release and now mean different
 * things, and aliasing them would make the next change to either one silently
 * change the other.
 */
export const STATUS_ON_SUBMISSION: QuestionStatus = 'pending';

/**
 * How many times to re-read the counter and try again when the batch is
 * refused. Two submissions racing each other both compute the same next value,
 * and Firestore serializes writes to a document, so the loser's
 * `count == resource.data.count + 1` no longer holds and its batch is refused.
 * That is correct behaviour, not an error worth showing anyone — it just needs
 * a fresh read. Three attempts is far more than a human can cause and still
 * bounded.
 */
const QUOTA_WRITE_ATTEMPTS = 3;

/**
 * How many questions one page of the review queue holds.
 *
 * A `where`-and-`limit` pair is mandatory, not a nicety (`CLAUDE.md` §4.1):
 * an unbounded read of this collection is billed per document and grows with
 * other people's contributions.
 *
 * Deliberately **no `orderBy`**, so the query rides the automatic single-field
 * index on `status` and needs no composite — the page is sorted by `createdAt`
 * in the browser instead. The consequence is honest and small: with more
 * pending questions than fit on a page, the *page boundary* is by document ID
 * rather than by age, so a page is not globally the oldest N. Every question
 * is still reachable and still gets reviewed, because reviewing one removes it
 * from the queue and the next arrives. Trading a composite index — and D3's
 * whole class of deploy risk — for that is the right way round.
 */
export const REVIEW_PAGE_SIZE = 50;

/**
 * Every `{window}-{slot}` document ID was refused. Usually that means the
 * volume cap — ten reports per five-minute window per user — but an invalid
 * payload is refused with the same `permission-denied` on every slot, and
 * clients can't read reports back to tell the two apart. The message
 * therefore advises without diagnosing (`CLAUDE.md` §4.4): "try again in a
 * few minutes" is the right move for the cap, and harmless for the rest.
 */
export class QuestionReportRejectedError extends Error {
  constructor() {
    super('Could not send the report just now. Please try again in a few minutes.');
  }
}

/**
 * The submitter has published the hour's allowance. Thrown only after reading
 * the counter back and finding it genuinely full — a refusal alone does not
 * justify the claim, since the rules refuse a stale counter identically
 * (`CLAUDE.md` §4.4).
 */
export class QuestionQuotaExceededError extends Error {
  constructor() {
    super(
      `You have added ${MAX_QUESTIONS_PER_HOUR} questions in the past hour, which is the limit. ` +
        'Please try again later.',
    );
  }
}

/** What to draw from the shared question bank. `limit` is mandatory on purpose — see `getCustomQuestions`. */
export interface CustomQuestionsQuery {
  /** Exact category match; empty/omitted means any. */
  category?: string;
  /** Exact difficulty match; empty/omitted means any. */
  difficulty?: Difficulty | '';
  /** Hard ceiling on documents read. */
  limit: number;
}

/**
 * The alphabet Firestore draws auto-IDs from, and the length it uses.
 *
 * Reproduced rather than imported because the SDK is gone and never exported
 * its ID generator anyway. It only has to describe the same *space* the real IDs occupy —
 * a cursor is a position to start reading from, never a document that has to
 * exist.
 */
const AUTO_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const AUTO_ID_LENGTH = 20;

/**
 * A random point in the document-ID space, used as a sampling cursor.
 *
 * Uses `crypto.getRandomValues` for a uniform draw over the alphabet;
 * `Math.random() * 62` truncated is also uniform enough here, but the crypto
 * API is available everywhere this app runs and costs nothing.
 */
function randomDocumentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(AUTO_ID_LENGTH));
  let id = '';
  for (const byte of bytes) {
    id += AUTO_ID_ALPHABET[byte % AUTO_ID_ALPHABET.length];
  }
  return id;
}

/**
 * Asserts an expected document shape onto data Firestore returned untyped.
 *
 * The SDK's `DocumentData` has `any`-valued fields, so `doc.data() as X` was a
 * direct assertion. `RestDocument.data` is honestly typed as
 * `Record<string, unknown>`, which does not overlap with a concrete interface,
 * so the same assertion now has to go through `unknown`. That is the identical
 * amount of checking — none — just said out loud, and it lives here rather
 * than at three call sites so the fact that it is unchecked is stated once.
 */
function asDocumentData<T>(data: Record<string, unknown>): T {
  return data as unknown as T;
}

/** `leaderboards/{board}/entries/{uid}` — one place the path is spelled. */
function boardEntryPath(board: string, uid: string): string {
  return `${LEADERBOARDS_COLLECTION}/${board}/${BOARD_ENTRIES_SUBCOLLECTION}/${uid}`;
}

/**
 * The quota document for a uid in the current hour. Must render the same string
 * as `questionQuotaWindow()` in `firestore.rules`, which uses integer division
 * on `request.time` — deliberately not `math.floor()`, which returns a float
 * and renders as "5954006.0".
 */
function questionQuotaId(uid: string): string {
  return `${Math.floor(Date.now() / QUESTION_QUOTA_WINDOW_MS)}-${uid}`;
}

@Injectable({ providedIn: 'root' })
export class FirebaseService {
  private readonly rest = inject(FirestoreRestClient);

  /**
   * Draws up to `limit` questions from the shared bank, filtered server-side.
   *
   * This used to be `getDocs(collection(...))` with no `where` and no `limit`:
   * every custom or mixed game downloaded the **entire** public collection and
   * filtered it in the browser (finding C1). That is billed per document, grows
   * with other people's contributions rather than with anything this player
   * asked for, and — on a publicly readable collection — is trivially
   * scriptable into a bill. `CLAUDE.md` §4.1 states the rule it broke.
   *
   * **Randomness is the reason this isn't just `limit(n)`.** Ordering is by
   * document ID, so a plain limit would hand every player the same first N
   * questions forever. Instead the query starts at a randomly generated
   * document ID and reads forward, wrapping around to the start of the
   * collection if that lands too near the end. Firestore's auto-IDs are drawn
   * uniformly from a 62-character alphabet, so a random ID is a uniform
   * position in the collection — which makes the ID space usable as a sampling
   * cursor with **no schema change, no new field and no backfill**.
   *
   * That last part is what makes this affordable: the obvious alternative is a
   * `random` field on every document, which `custom_questions`' exact-key
   * `hasOnly()` allowlist would have to be widened for, which existing
   * documents would not have, and which no client can backfill because the
   * collection is create-only (the same wall A10 hit).
   *
   * Costs at most two reads of `limit` documents each, and usually one — the
   * wrap only runs when the first pass came up short.
   */
  getCustomQuestions(
    options: CustomQuestionsQuery,
  ): Observable<(CustomQuestionDoc & { id: string })[]> {
    return defer(() => this.fetchCustomQuestions(options));
  }

  private async fetchCustomQuestions(
    options: CustomQuestionsQuery,
  ): Promise<(CustomQuestionDoc & { id: string })[]> {
    const { category, difficulty, limit } = options;
    if (limit <= 0) {
      return [];
    }

    const filters: RestFieldFilter[] = [
      // Players are served approved questions and nothing else. This is the
      // client half of review-before-publish; the *rule* stays open for one
      // more release so a browser cached from before this change is not
      // refused outright (see the `custom_questions` read rule). Until 4c
      // every question is approved anyway, so this filter changes no result
      // today — what it does is get the query shape, and the three composite
      // indexes it needs, into production ahead of the rule that requires it.
      { field: 'status', op: 'EQUAL' as const, value: STATUS_APPROVED },
      ...(category ? [{ field: 'category', op: 'EQUAL' as const, value: category }] : []),
      ...(difficulty ? [{ field: 'difficulty', op: 'EQUAL' as const, value: difficulty }] : []),
    ];
    const cursor = randomDocumentId();

    const runQuery = (
      bounds: Pick<RestQuery, 'limit' | 'startAtDocumentId' | 'endBeforeDocumentId'>,
    ) =>
      this.rest.runQuery(
        {
          collectionPath: CUSTOM_QUESTIONS_COLLECTION,
          where: filters,
          orderBy: [{ field: DOCUMENT_ID_FIELD }],
          ...bounds,
        },
        { timeoutMs: FIRESTORE_TIMEOUT_MS },
      );

    const docs = await runQuery({ startAtDocumentId: cursor, limit });

    // The cursor landed near the end of the collection (or the bank simply
    // holds fewer than `limit` matches), so take the remainder from the start.
    // Without this, a high cursor would systematically return short and the
    // questions sorting earliest would be served far less often than the rest.
    if (docs.length < limit) {
      docs.push(...(await runQuery({ endBeforeDocumentId: cursor, limit: limit - docs.length })));
    }

    return docs.map((doc) => ({
      id: doc.id,
      ...asDocumentData<CustomQuestionDoc>(doc.data),
    }));
  }

  /**
   * One page of the review queue: questions in a given moderation status.
   *
   * Reviewer-only in practice — `firestore.rules` will not let anyone else act
   * on the result — but deliberately *not* gated here. A client-side check is
   * UX, never authority (`CLAUDE.md` §4.2), and adding one would only mean a
   * non-reviewer sees an empty page instead of a page they cannot act on.
   *
   * Sorted newest-last by `createdAt` in the browser rather than by the query,
   * so no composite index is needed — see {@link REVIEW_PAGE_SIZE}. Documents
   * predating attribution have no `createdAt` and sort last, which is the
   * honest place for "we do not know when this arrived".
   */
  getQuestionsByStatus(
    status: QuestionStatus,
    limit = REVIEW_PAGE_SIZE,
  ): Observable<(CustomQuestionDoc & { id: string })[]> {
    return defer(async () => {
      const docs = await this.rest.runQuery(
        {
          collectionPath: CUSTOM_QUESTIONS_COLLECTION,
          where: [{ field: 'status', op: 'EQUAL', value: status }],
          limit,
        },
        { timeoutMs: FIRESTORE_TIMEOUT_MS },
      );

      return docs
        .map((doc) => ({ id: doc.id, ...asDocumentData<CustomQuestionDoc>(doc.data) }))
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    });
  }

  /**
   * Moves a question between moderation statuses.
   *
   * **This is the app's first genuinely partial write**, and the note on
   * `FirestoreRestClient.setDocument` said the day one arrived it would have to
   * decide on purpose. It has: the `updateMask` covers `status` alone, so this
   * is a patch and every other field is left exactly as the author wrote it.
   * A full-document replace would be wrong twice over — it would drop whatever
   * the reviewer's client did not happen to know about, and `firestore.rules`
   * refuses it anyway, because the moderation rule allows a write that affects
   * no key but `status`.
   */
  async setQuestionStatus(questionId: string, status: QuestionStatus): Promise<void> {
    await this.rest.setDocument(
      `${CUSTOM_QUESTIONS_COLLECTION}/${questionId}`,
      { status },
      { timeoutMs: FIRESTORE_TIMEOUT_MS },
    );
  }

  /**
   * Adds a player-submitted question to the shared bank via an auto-id
   * `addDoc` (unlike the leaderboard, there's no per-user document to
   * upsert). Rejected outright by `firestore.rules` for anonymous/unverified
   * callers or a malformed payload — see `isValidCustomQuestion` there.
   *
   * The caller supplies `createdBy`/`createdAt` (same convention as
   * `saveHighScore` taking `uid`). The rules reject a `createdBy` that isn't
   * the caller's own uid, so passing the wrong one fails the write rather
   * than mis-attributing the question.
   */
  async addCustomQuestion(question: NewCustomQuestionDoc): Promise<void> {
    const quotaPath = `${QUESTION_QUOTA_COLLECTION}/${questionQuotaId(question.createdBy)}`;

    for (let attempt = 0; attempt < QUOTA_WRITE_ATTEMPTS; attempt++) {
      const used = await this.readQuestionsUsedThisHour(quotaPath);
      if (used >= MAX_QUESTIONS_PER_HOUR) {
        throw new QuestionQuotaExceededError();
      }

      try {
        // One commit, because `firestore.rules` reads the counter's
        // post-commit state with `getAfter()`. Two sequential writes would let
        // a client send the question and never send the increment.
        //
        // The question's ID is minted here rather than by the server, since a
        // batch has to name what it writes. `randomDocumentId()` draws from
        // Firestore's own auto-ID alphabet, which keeps IDs uniformly
        // distributed across the keyspace — load-bearing for
        // `getCustomQuestions()`, which samples the bank by picking a random
        // point in exactly that space.
        await this.rest.commit(
          [
            { path: quotaPath, data: { count: used + 1 } },
            {
              path: `${CUSTOM_QUESTIONS_COLLECTION}/${randomDocumentId()}`,
              // `status` is set here rather than taken from the caller: a
              // submitter has no legitimate say in whether their own
              // submission is approved, and keeping it in one place means 4c's
              // flip to 'pending' is a one-line change with one test to update.
              data: { ...question, status: STATUS_ON_SUBMISSION } satisfies CustomQuestionWrite,
              mustNotExist: true,
            },
          ],
          { timeoutMs: FIRESTORE_TIMEOUT_MS },
        );
        return;
      } catch (error) {
        // A refusal here has two plausible causes and they need different
        // answers: the counter moved under us (another submission landed
        // first), or something about the payload is wrong. Re-reading
        // distinguishes them on the next pass; anything that is not a refusal
        // is a real failure and is not retried.
        if (!isFirestorePermissionDenied(error) || attempt === QUOTA_WRITE_ATTEMPTS - 1) {
          throw error;
        }
      }
    }
  }

  /**
   * How many questions this account has published in the current hour.
   *
   * Read before the write so the counter can be incremented to a known value,
   * and read *again* on the failure path so a refusal can be explained
   * honestly rather than guessed at — the difference between "you have reached
   * the limit" and "please try again", which B4 is the standing lesson about.
   */
  private async readQuestionsUsedThisHour(quotaPath: string): Promise<number> {
    const document = await this.rest.getDocument(quotaPath, {
      timeoutMs: FIRESTORE_TIMEOUT_MS,
    });
    const count = document?.data['count'];
    return typeof count === 'number' ? count : 0;
  }

  /**
   * Files a player's report about a community question (finding H4).
   *
   * The document ID is `{window}-{slot}-{uid}` — the same document-ID volume
   * cap as the checkout/portal session documents (`CLAUDE.md` §4.1, finding
   * A3): `create` refuses an ID that already exists, so ten slots per
   * five-minute window per uid *is* the rate limit, with no counter document
   * for a client to decline to update. A `permission-denied` therefore means
   * "this slot is taken" as often as it means anything else, so the loop
   * moves to the next slot rather than giving up; only running out of all
   * ten is worth surfacing, and the thrown message says what to do about it.
   */
  async reportQuestion(report: NewQuestionReportDoc): Promise<void> {
    const currentWindow = Math.floor(Date.now() / REPORT_WINDOW_MS);
    const firstSlot = Math.floor(Math.random() * REPORT_SLOTS_PER_WINDOW);

    for (let attempt = 0; attempt < REPORT_SLOTS_PER_WINDOW; attempt++) {
      const slot = (firstSlot + attempt) % REPORT_SLOTS_PER_WINDOW;
      try {
        await this.rest.setDocument(
          `${QUESTION_REPORTS_COLLECTION}/${currentWindow}-${slot}-${report.reportedBy}`,
          { ...report },
          { timeoutMs: FIRESTORE_TIMEOUT_MS },
        );
        return;
      } catch (error) {
        if (!isFirestorePermissionDenied(error)) {
          throw error;
        }
      }
    }

    throw new QuestionReportRejectedError();
  }

  /**
   * Leaderboard entries are keyed by uid *within a board* (one entry per user
   * per timing constraint, best score wins) — the write is a `setDoc` on
   * `leaderboards/{board}/entries/{uid}`, not an auto-id `addDoc`. Firestore
   * rules reject the write outright if `entry.score` isn't higher than that
   * user's existing best **on that board**, so a rejection here doesn't
   * necessarily mean an error, just "not a new PB".
   *
   * The board comes from `entry.timeLimit` rather than a separate argument, so
   * the path and the field the rules compare it against cannot be passed
   * inconsistently from here.
   */
  async saveHighScore(entry: LeaderboardEntry): Promise<void> {
    await this.rest.setDocument(
      boardEntryPath(entry.timeLimit, entry.uid),
      { ...entry },
      { timeoutMs: FIRESTORE_TIMEOUT_MS },
    );
  }

  /**
   * The caller's own leaderboard row, or null if they have never saved one.
   *
   * Exists so a rejected save can be *explained* rather than guessed at: the
   * rules refuse a write for several reasons (a score that doesn't improve, a
   * clock too far off, a name too long, an account that isn't verified), and
   * only one of them is the friendly "your best is already higher". Reading
   * the existing row is what tells those apart. A document `get` on a known
   * path, not a collection scan — see `CLAUDE.md` §4.1.
   */
  async getLeaderboardEntry(uid: string, board: string): Promise<LeaderboardEntry | null> {
    const document = await this.rest.getDocument(boardEntryPath(board, uid), {
      timeoutMs: FIRESTORE_TIMEOUT_MS,
    });
    return document
      ? { id: document.id, ...asDocumentData<Omit<LeaderboardEntry, 'id'>>(document.data) }
      : null;
  }

  /**
   * The top `topN` of one board. Needs only Firestore's automatic
   * single-field index on `score`, which is the reason the boards are
   * subcollections — see `LEADERBOARDS_COLLECTION` above.
   */
  getTopScores(board: string, topN = 10): Observable<LeaderboardEntry[]> {
    return defer(() =>
      this.rest.runQuery(
        {
          collectionPath: `${LEADERBOARDS_COLLECTION}/${board}/${BOARD_ENTRIES_SUBCOLLECTION}`,
          orderBy: [{ field: 'score', direction: 'DESCENDING' }],
          limit: topN,
        },
        { timeoutMs: FIRESTORE_TIMEOUT_MS },
      ),
    ).pipe(
      map((documents) =>
        documents.map((document) => ({
          id: document.id,
          ...asDocumentData<Omit<LeaderboardEntry, 'id'>>(document.data),
        })),
      ),
    );
  }
}
