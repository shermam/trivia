import { Injectable, inject } from '@angular/core';
import { Observable, defer, map } from 'rxjs';
import {
  CustomQuestionContent,
  CustomQuestionDoc,
  Difficulty,
  LeaderboardEntry,
  CustomQuestionWrite,
  NewCustomQuestionDoc,
  QuestionStatus,
  NewQuestionReportDoc,
  RegionalLeaderboardEntry,
} from '../models/question.model';
import {
  DOCUMENT_ID_FIELD,
  FirestoreRestClient,
  RestFieldFilter,
  RestQuery,
  isDocumentId,
  isFirestorePermissionDenied,
} from './firestore-rest/firestore-rest.client';

const CUSTOM_QUESTIONS_COLLECTION = 'custom_questions';
const USERS_COLLECTION = 'users';
/**
 * The per-timing-constraint boards (finding G7). Entries live at
 * `leaderboards/{board}/entries/{uid}` — a subcollection rather than a
 * `timeLimit` field on one flat collection, because the flat version needs a
 * composite index and index configuration is the one thing the emulator cannot
 * verify (`docs/data-model.md` §3).
 */
const LEADERBOARDS_COLLECTION = 'leaderboards';
const BOARD_ENTRIES_SUBCOLLECTION = 'entries';
/**
 * The per-country boards under each of those (`FEAT-028`):
 * `leaderboards/{board}/regions/{region}/entries/{uid}`. A second path segment
 * for the same reason the first one exists — filtering a `region` field would
 * need a composite index, and D3 is what that costs when it goes wrong.
 */
const BOARD_REGIONS_SUBCOLLECTION = 'regions';
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
 * The longest a reviewer's rejection note may be (`FEAT-007`). Must agree with
 * `maxRejectionReasonLength()` in `firestore.rules`; if they drift, the review
 * queue offers a box whose contents the write is refused for, with nothing on
 * screen naming the field.
 */
export const MAX_REJECTION_REASON_LENGTH = 500;

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
 * How many of an author's own questions one page of `/my-questions` holds
 * (`FEAT-007`).
 *
 * Unlike the review queue above this query **is** ordered, newest first, and so
 * it pages on a cursor rather than telling the reader to reload: a screen
 * showing somebody their own contributions has to be able to reach all of them,
 * and an author who has been contributing for a year has more than fit here.
 * The order is what makes the bound mean something — an unordered page of
 * twenty-five is twenty-five arbitrary questions (`CLAUDE.md` §4.1).
 */
export const MY_QUESTIONS_PAGE_SIZE = 25;

/**
 * Where the next page of an author's questions starts: the last row's
 * `createdAt` and its document ID, in the order the query sorts by.
 *
 * The document ID is in there for the same reason `ReportCursor` carries one —
 * two questions submitted in the same millisecond put one of them at a page
 * boundary and its twin immediately after the cursor value, where an exclusive
 * `startAfter` on `createdAt` alone steps straight over it. A contributor
 * submitting a batch is exactly the case that produces the tie.
 */
export type UserQuestionCursor = readonly [createdAt: unknown, id: string];

/** One page of an author's own questions, and where the next one begins. */
export interface UserQuestionsPage {
  questions: (CustomQuestionDoc & { id: string })[];
  next: UserQuestionCursor | null;
}

/**
 * How many document IDs one `IN` filter may carry. Firestore's own limit is 30
 * comparison values per `IN`; a query built with more is rejected outright, so
 * `getQuestionsByIds` batches rather than assuming its caller stayed under it.
 */
const QUESTION_ID_BATCH_SIZE = 30;

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

/**
 * One player's lifetime totals, as `recordGameResult` banks them into
 * `users/{uid}` (`docs/data-model.md`).
 *
 * Only the five fields `/profile` renders. The document carries four more —
 * `lastGameId`, `updatedAt` and the `rateWindowStart`/`gamesInWindow` pair —
 * which are bookkeeping for the callable rather than anything to show a
 * player, and naming them here would invite a screen to grow around them.
 *
 * `statsSince` is nullable because the reader has to survive a document
 * written before a field existed: the collection deliberately has no
 * `hasOnly()` allowlist and no rules-level schema, which is what lets a
 * server-written field be added without a migration — and the price of that
 * is that a reader may not assume every field is there.
 */
export interface GameplayStats {
  gamesPlayed: number;
  questionsAnswered: number;
  correctAnswers: number;
  bestStreak: number;
  /** Epoch ms the first game was banked, or `null` on a document without one. */
  statsSince: number | null;
}

/** A count Firestore returned untyped, or 0 when the field is absent or not a number. */
function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * The most tags one draw may filter on (`FEAT-021`).
 *
 * **Firestore's own ceiling for `array-contains-any` is 30**, and exceeding it
 * is not a narrower result — the query is refused outright. Ten is well inside
 * that, and it is a product bound rather than a technical one: a request for
 * eleven topics at once is not a narrowing, and every value added widens the
 * index scan. The filter UI stops offering more at the same number, so the
 * clamp below should be unreachable from the app — which is exactly why it is
 * here as well, since a caller is not the place a bound lives.
 */
export const MAX_TAG_FILTER_VALUES = 10;

/** What to draw from the shared question bank. `limit` is mandatory on purpose — see `getCustomQuestions`. */
export interface CustomQuestionsQuery {
  /** Exact category match; empty/omitted means any. */
  category?: string;
  /** Exact difficulty match; empty/omitted means any. */
  difficulty?: Difficulty | '';
  /**
   * Topic tags to narrow the draw to (`FEAT-021`). A question carrying **any**
   * of them matches; an empty or omitted list adds no clause at all, which is
   * what makes the filter strictly additive. Clamped to
   * {@link MAX_TAG_FILTER_VALUES}.
   */
  tags?: readonly string[];
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

/** The collection a country's board ranks: `leaderboards/{board}/regions/{region}/entries`. */
function regionEntriesPath(board: string, region: string): string {
  return (
    `${LEADERBOARDS_COLLECTION}/${board}/${BOARD_REGIONS_SUBCOLLECTION}/` +
    `${region}/${BOARD_ENTRIES_SUBCOLLECTION}`
  );
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

    // The player's topic selection, clamped (`FEAT-021`). Empty is the case
    // that matters: it has to produce **no clause**, so an unfiltered game
    // sends the query it sent before tags existed and needs no index that did
    // not already exist. That is the whole of "the filter is additive", and
    // `firebase.service.spec.ts` pins it on the wire rather than by reading
    // this line — it decodes the request the fake transport received and
    // asserts both that no `array-contains-any` is in it and that the `where`
    // list is exactly the one equality an unfiltered draw has always sent.
    const tags = (options.tags ?? []).slice(0, MAX_TAG_FILTER_VALUES);

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
      // A question carrying **any** of the selected tags. `ANY` rather than
      // `ALL` because that is what a player picking two topics means, and
      // because `ALL` would need either a second query intersected in the
      // browser or a composite-key field — for a request nobody has made.
      //
      // A question with no `tags` array matches no such clause, so a tag
      // filter reaches only what somebody has tagged. That is correct rather
      // than a gap: a tag filter is a request for questions *about* a topic,
      // and an untagged question is not known to be about it.
      ...(tags.length > 0
        ? [{ field: 'tags', op: 'ARRAY_CONTAINS_ANY' as const, value: tags }]
        : []),
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
   * The questions a page of reports is about, by document ID (`FEAT-026`).
   *
   * **One query per 30 ids rather than one read per report.** Firestore accepts
   * up to 30 comparison values in an `IN`, and `__name__` is a filterable field
   * like any other, so a page of reports costs a bounded handful of queries
   * instead of a round trip each. Ids are deduplicated first: several reports
   * about the same question are the expected case, and are the reason a queue
   * exists at all.
   *
   * A reviewer may read a question in any status (`firestore.rules` —
   * `status == 'approved' || isReviewer()`), which is what makes this usable
   * for reports about questions that are pending or already rejected.
   *
   * **A missing id is simply absent from the result**, never an error: a report
   * can outlive the question it names, because `custom_questions` is deletable
   * from the console and `question_reports` has no cascade. The caller renders
   * the report and says the question is gone.
   *
   * **An id that cannot address a document is dropped rather than sent**, and
   * that is the same promise rather than a second one. These ids are read out
   * of documents this app did not necessarily write — `question_reports` is
   * also writable from the console, where nothing validates `questionId` — so
   * an empty string or one carrying a `/` can reach here. A `__name__` filter
   * refuses both (`isDocumentId`), and the throw would propagate out of the
   * whole batched read: one malformed document would take every report on the
   * page down with it and leave a "could not load" that retrying can never
   * clear. Dropped, it falls through to the absent case above and the row that
   * names it says the question is gone, which is what the reviewer needs to
   * know about it anyway.
   */
  getQuestionsByIds(ids: string[]): Observable<(CustomQuestionDoc & { id: string })[]> {
    return defer(async () => {
      const unique = [...new Set(ids.filter(isDocumentId))];
      const batches: string[][] = [];
      for (let start = 0; start < unique.length; start += QUESTION_ID_BATCH_SIZE) {
        batches.push(unique.slice(start, start + QUESTION_ID_BATCH_SIZE));
      }

      const pages = await Promise.all(
        batches.map((batch) =>
          this.rest.runQuery(
            {
              collectionPath: CUSTOM_QUESTIONS_COLLECTION,
              where: [{ field: DOCUMENT_ID_FIELD, op: 'IN', value: batch }],
              limit: batch.length,
            },
            { timeoutMs: FIRESTORE_TIMEOUT_MS },
          ),
        ),
      );

      return pages
        .flat()
        .map((doc) => ({ id: doc.id, ...asDocumentData<CustomQuestionDoc>(doc.data) }));
    });
  }

  /**
   * The caller's own contributions, newest first, starting after `after`
   * (`FEAT-007`).
   *
   * **The `where` is not optional and neither is the `limit`.** Rules are not
   * filters, so the `createdBy` clause is what lets Firestore *prove* the
   * ownership branch of the read rule for every document the query could
   * return — without it the query is refused outright rather than narrowed
   * (`docs/data-model.md` §3) — and the limit is `CLAUDE.md` §4.1.
   *
   * Ordered `createdAt` descending with the document ID as a tiebreaker, which
   * needs the `(createdBy ASC, createdAt DESC)` composite index declared in
   * `firestore.indexes.json`. The emulator answers this query whether or not
   * that index exists, so it is declared rather than discovered (D3).
   *
   * Questions predating attribution are absent by construction: they carry no
   * `createdBy` to match, and nobody can claim them.
   */
  async getUserQuestions(uid: string, after?: UserQuestionCursor): Promise<UserQuestionsPage> {
    const documents = await this.rest.runQuery(
      {
        collectionPath: CUSTOM_QUESTIONS_COLLECTION,
        where: [{ field: 'createdBy', op: 'EQUAL', value: uid }],
        orderBy: [
          { field: 'createdAt', direction: 'DESCENDING' },
          { field: DOCUMENT_ID_FIELD, direction: 'DESCENDING' },
        ],
        limit: MY_QUESTIONS_PAGE_SIZE,
        ...(after === undefined ? {} : { startAfterValues: after }),
      },
      { timeoutMs: FIRESTORE_TIMEOUT_MS },
    );

    const last = documents[documents.length - 1];
    return {
      questions: documents.map((doc) => ({
        id: doc.id,
        ...asDocumentData<CustomQuestionDoc>(doc.data),
      })),
      // A short page is the end. A full one might also be, which costs one
      // empty read to find out — the trade every cursor-paged list makes.
      next:
        last === undefined || documents.length < MY_QUESTIONS_PAGE_SIZE
          ? null
          : [last.data['createdAt'], last.id],
    };
  }

  /**
   * Rewrites the author's own question and sends it back for review
   * (`FEAT-007`).
   *
   * **The status is set here rather than taken from the caller**, exactly as it
   * is on submission: an author has no more say in whether their edit is
   * approved than in whether their submission was. `firestore.rules` requires
   * `'pending'` on an owner update, so a caller offering anything else would be
   * offering a decision the rules exist to refuse.
   *
   * **`createdBy` and `createdAt` are deliberately absent from the mask.** They
   * are the document's history rather than its content, and leaving them out of
   * the write is what makes "unchanged" true by construction rather than by the
   * client remembering to resend the same values — which the rules then check
   * anyway.
   *
   * **Every optional field is in the mask whether or not it has a value**, so
   * clearing a source link removes the key rather than leaving the old one in
   * place. `rejectionReason` is in the delete list unconditionally: the note was
   * about text that no longer exists, and the rules refuse an owner update that
   * leaves it standing.
   */
  async updateUserQuestion(questionId: string, content: CustomQuestionContent): Promise<void> {
    const optional = ['sourceUrl', 'sourceTitle', 'explanation', 'format', 'tags'] as const;
    // `hasValue`, not truthiness: `tags` is an array, and `[]` is truthy while
    // meaning exactly what an empty string means for the four fields beside it
    // — nothing given. Written as `[]` it would put an empty array on every
    // untagged question, which the rules accept and which says nothing an
    // absent key does not.
    const hasValue = (key: (typeof optional)[number]): boolean => {
      const value = content[key];
      return Array.isArray(value) ? value.length > 0 : Boolean(value);
    };
    const present = Object.fromEntries(optional.filter(hasValue).map((key) => [key, content[key]]));
    const cleared = optional.filter((key) => !hasValue(key));

    await this.rest.setDocument(
      `${CUSTOM_QUESTIONS_COLLECTION}/${questionId}`,
      {
        category: content.category,
        type: content.type,
        difficulty: content.difficulty,
        question: content.question,
        correct_answer: content.correct_answer,
        incorrect_answers: content.incorrect_answers,
        status: STATUS_ON_SUBMISSION,
        ...present,
      },
      { timeoutMs: FIRESTORE_TIMEOUT_MS, deleteFields: [...cleared, 'rejectionReason'] },
    );
  }

  /**
   * Withdraws the author's own question from the app (`FEAT-007`).
   *
   * "From the app" is the honest verb and the UI says so too: the licence the
   * Terms grant is irrevocable, and this reaches neither copies already served
   * nor a player's offline pool. What it does do is stop the question being
   * drawn again.
   */
  async deleteUserQuestion(questionId: string): Promise<void> {
    await this.rest.deleteDocument(`${CUSTOM_QUESTIONS_COLLECTION}/${questionId}`, {
      timeoutMs: FIRESTORE_TIMEOUT_MS,
    });
  }

  /**
   * Moves a question between moderation statuses, and records why when the
   * decision is a rejection.
   *
   * **This is the app's first genuinely partial write**, and the note on
   * `FirestoreRestClient.setDocument` said the day one arrived it would have to
   * decide on purpose. It has: the `updateMask` covers the two keys the
   * moderation rule permits and nothing else, so every field the author wrote
   * is left exactly as they wrote it. A full-document replace would be wrong
   * twice over — it would drop whatever the reviewer's client did not happen to
   * know about, and `firestore.rules` refuses it anyway.
   *
   * **The reason is cleared on any decision that is not a rejection**, and that
   * is not tidiness: the rules refuse a `rejectionReason` on a question that is
   * not `rejected`, so approving one that carries a stale note would be refused
   * outright. Clearing it is also the honest write — a rejection note on an
   * approved question is a false statement shown to its author.
   */
  async setQuestionStatus(
    questionId: string,
    status: QuestionStatus,
    rejectionReason?: string,
  ): Promise<void> {
    const reason = status === 'rejected' ? (rejectionReason ?? '').trim() : '';
    await this.rest.setDocument(
      `${CUSTOM_QUESTIONS_COLLECTION}/${questionId}`,
      { status, ...(reason ? { rejectionReason: reason } : {}) },
      {
        timeoutMs: FIRESTORE_TIMEOUT_MS,
        ...(reason ? {} : { deleteFields: ['rejectionReason'] }),
      },
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
   * The same write on the player's own country board (`FEAT-028`).
   *
   * A separate document under separate rules, not a variant of the one above:
   * the global entry's exact-key allowlist refuses a `region` key and the
   * regional entry's requires one, so a save publishes two documents and each
   * is validated on its own terms. Both path segments come off the entry for
   * the same reason `saveHighScore` takes the board off `timeLimit` — the
   * fields the rules compare against the path cannot be passed inconsistently
   * from here.
   *
   * Rejected independently of the global write, too. The improving-score check
   * reads `resource.data` at this path, so a player whose global best already
   * stands can still be first in their own country, and a player who has moved
   * country starts from nothing on the new board — which is why the caller
   * attempts both rather than gating one on the other.
   */
  async saveRegionalHighScore(entry: RegionalLeaderboardEntry): Promise<void> {
    await this.rest.setDocument(
      `${regionEntriesPath(entry.timeLimit, entry.region)}/${entry.uid}`,
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
   * The caller's own lifetime totals, or `null` when they have never finished
   * a game while signed in.
   *
   * A single-document `get` on a known path — `CLAUDE.md` §4.1's bounded read
   * in its cheapest form, and the only shape `firestore.rules` permits here:
   * `users` allows `get` for the owner and refuses `list` to everybody, so
   * there is no query over this collection to write by accident.
   *
   * **`null` means "no games banked yet", and nothing else.** `getDocument`
   * turns a 404 into `null` and lets a 403 or a transport failure throw, which
   * is what keeps `/profile`'s empty state from standing in for a refused
   * read (`CLAUDE.md` §4.4 — an error message must not narrate a cause nobody
   * verified).
   *
   * Every count is coerced rather than asserted. The document is written only
   * by the Admin SDK, so the types are not in doubt today; `asCount` is here
   * because the screen divides one of these by another, and an accuracy of
   * `NaN%` shown to a real person is a worse outcome than a zero.
   */
  async getGameplayStats(uid: string): Promise<GameplayStats | null> {
    const document = await this.rest.getDocument(`${USERS_COLLECTION}/${uid}`, {
      timeoutMs: FIRESTORE_TIMEOUT_MS,
    });
    if (!document) {
      return null;
    }
    const statsSince = document.data['statsSince'];
    return {
      gamesPlayed: asCount(document.data['gamesPlayed']),
      questionsAnswered: asCount(document.data['questionsAnswered']),
      correctAnswers: asCount(document.data['correctAnswers']),
      bestStreak: asCount(document.data['bestStreak']),
      statsSince: typeof statsSince === 'number' && Number.isFinite(statsSince) ? statsSince : null,
    };
  }

  /**
   * The top `topN` of one board. Needs only Firestore's automatic
   * single-field index on `score`, which is the reason the boards are
   * subcollections — see `LEADERBOARDS_COLLECTION` above.
   */
  getTopScores(board: string, topN = 10): Observable<LeaderboardEntry[]> {
    return this.topScoresAt(
      `${LEADERBOARDS_COLLECTION}/${board}/${BOARD_ENTRIES_SUBCOLLECTION}`,
      topN,
    );
  }

  /**
   * The top `topN` of one country's board (`FEAT-028`).
   *
   * The same query one path segment deeper, and deliberately the same shape:
   * `orderBy('score','desc').limit(n)` is served by Firestore's automatic
   * single-field index on any collection, so a board per country adds no index
   * and cannot repeat D3.
   */
  getRegionalTopScores(board: string, region: string, topN = 10): Observable<LeaderboardEntry[]> {
    return this.topScoresAt(regionEntriesPath(board, region), topN);
  }

  /**
   * The shared shape of both board reads.
   *
   * A bounded read with no `where`, which is the one place `CLAUDE.md` §4.1
   * sanctions that: "the top ten of this collection" has no subset to name, so
   * the `orderBy` is what makes the `limit` mean something rather than
   * returning ten arbitrary rows.
   */
  private topScoresAt(collectionPath: string, topN: number): Observable<LeaderboardEntry[]> {
    return defer(() =>
      this.rest.runQuery(
        {
          collectionPath,
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
