import { Injectable, inject } from '@angular/core';
import { Observable, defer, map } from 'rxjs';
import {
  CustomQuestionDoc,
  Difficulty,
  LeaderboardEntry,
  NewCustomQuestionDoc,
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
    await this.rest.createDocument(
      CUSTOM_QUESTIONS_COLLECTION,
      { ...question },
      { timeoutMs: FIRESTORE_TIMEOUT_MS },
    );
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
