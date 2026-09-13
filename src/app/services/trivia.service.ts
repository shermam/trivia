import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom, map } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  Answer,
  CustomQuestionDoc,
  DEFAULT_TIME_LIMIT,
  Difficulty,
  GameConfig,
  OpenTriviaApiQuestion,
  OpenTriviaApiResponse,
  TriviaQuestion,
} from '../models/question.model';
import { decodeHtmlEntities } from '../utils/html-entities.util';
import { seenKeyFor } from '../utils/seen-key.util';
import { shuffleArray } from '../utils/shuffle.util';
import { FirebaseService } from './firebase.service';
import { OfflineQuestionsService } from './offline-questions.service';
import { SeenQuestionsService } from './seen-questions.service';

export interface TriviaCategory {
  id: number;
  name: string;
}

const OPEN_TRIVIA_QUESTIONS_URL = 'https://opentdb.com/api.php';
const OPEN_TRIVIA_CATEGORIES_URL = 'https://opentdb.com/api_category.php';

/** Size the background prefetch (see `initOfflinePrefetch`) tries to keep the offline pool topped up to. */
const OFFLINE_POOL_TARGET = 100;
/** Open Trivia DB rejects `amount` values much above this, so a single refill run never asks for more. */
const MAX_PREFETCH_BATCH = 50;

/**
 * How much wider than the game itself a **deduplicating** draw reads from the
 * shared question bank, and the hard ceiling on that (`FEAT-034`).
 *
 * **Why the query has to read more than it serves.** The custom draw's `limit`
 * is the game's own question count, so a filter applied strictly inside that
 * page has nothing to substitute *with*: dropping a question the player has
 * already answered would shorten the game rather than replace it. Reading a
 * bounded multiple is what turns the filter into a choice. It leaves every
 * property finding C1 was about intact — there is still a `where`, still a
 * `limit`, still one query with a random cursor (`CLAUDE.md` §4.1) — and the
 * ceiling is a constant rather than a share of the collection, so the read
 * does not grow as the bank does. At most fifty documents, which is the same
 * bound the background prefetch already reads under.
 *
 * **It is only paid by a device that can use it.** A browser with an empty
 * seen-set draws exactly the game's count, as it always has.
 *
 * Open Trivia DB deliberately gets no equivalent, and not for want of a
 * reservoir: its `amount` is a *requirement*, not a ceiling, so asking for
 * fifty questions in a category holding eight returns `response_code: 1` and
 * no questions at all — turning a playable narrow game into "no questions were
 * found". Its substitutions come from the offline pool instead, which is what
 * the background prefetch fills.
 */
const DEDUPE_DRAW_MULTIPLIER = 2;
const MAX_DEDUPE_DRAW = 50;

/** What this device has answered: seen key → when it last answered it. */
type SeenSet = ReadonlyMap<string, number>;

/**
 * Chooses the questions a game is actually played with, preferring ones this
 * device has never answered (`FEAT-034`).
 *
 * Candidates are collapsed by seen key first, so a question reaching the draw
 * twice — from the fetched page and from the offline pool, or twice from the
 * same Open Trivia DB page under two spellings that normalise alike — is one
 * candidate rather than two and can never be served twice in one round. That
 * has a cost worth knowing: collapsing a genuine duplicate inside a page of
 * exactly `amount` questions leaves the game one question short, because there
 * is nothing behind it to promote. It is the right trade — a repeat inside a
 * single round is more noticeable than a four-question five — and it is the
 * one path here that can shorten a game.
 *
 * **`amount` is the caller's cap, and the caller sets it to what the network
 * actually returned.** Where a reserve is supplied at all it substitutes; it
 * never supplies. Letting it lengthen a draw would turn a legitimate "no
 * questions match this filter" into a game served silently from cache with no
 * offline banner to say so (`getQuestions`).
 *
 * **A short game is never the answer.** Unseen questions come first, shuffled;
 * if there are not enough of them the remainder is topped up with the
 * *least-recently* seen, oldest first. With a small bank every question is
 * eventually seen, and a draw that failed or shrank at that point would make
 * the feature worse than not having it — so the fallback is "the ones you are
 * least likely to remember", which is the only honest ordering available
 * without asking the player anything.
 *
 * **The result is deliberately not shuffled a second time.** Doing so would
 * hide where a round stops being fresh, which is a small gain, and it costs
 * something real: it makes the order of a returning player's game unstable
 * against a source order that is already arbitrary — Open Trivia DB randomises
 * its own page, `fetchCustomQuestions` shuffles the bank's, and a mixed game
 * shuffles the merge. Leaving it alone means new material comes first, which
 * is the right way round for a player who abandons a round halfway, and it
 * keeps a second game reproducible enough to be asserted on.
 */
function preferUnseen(
  candidates: readonly TriviaQuestion[],
  amount: number,
  seen: SeenSet,
): TriviaQuestion[] {
  const byKey = new Map<string, TriviaQuestion>();
  for (const question of candidates) {
    const key = seenKeyFor(question);
    if (!byKey.has(key)) {
      byKey.set(key, question);
    }
  }

  const unseen: TriviaQuestion[] = [];
  const alreadySeen: { question: TriviaQuestion; seenAt: number }[] = [];
  for (const [key, question] of byKey) {
    const seenAt = seen.get(key);
    if (seenAt === undefined) {
      unseen.push(question);
    } else {
      alreadySeen.push({ question, seenAt });
    }
  }

  const drawn = shuffleArray(unseen).slice(0, amount);
  if (drawn.length < amount) {
    alreadySeen.sort((a, b) => a.seenAt - b.seenAt);
    drawn.push(...alreadySeen.slice(0, amount - drawn.length).map((entry) => entry.question));
  }
  return drawn;
}

/**
 * Decodes the HTML entities Open Trivia DB encodes its text with (`&quot;`,
 * `&#039;`, `&amp;`).
 *
 * Applied here, at that one source's adapter, rather than in the shared
 * mapper. Running it over everything also rewrote Firestore-authored
 * questions, which are stored exactly as a contributor typed them — so a
 * question about HTML that deliberately reads `&amp;lt;div&amp;gt;`, or an
 * answer of `Tom &amp; Jerry` written out longhand, silently became something
 * the author did not write, with no way to express the original. The
 * transformation is a property of where the text came from, not of text in
 * general.
 */
function decodeOpenTriviaText(raw: OpenTriviaApiQuestion): OpenTriviaApiQuestion {
  return {
    ...raw,
    category: decodeHtmlEntities(raw.category),
    question: decodeHtmlEntities(raw.question),
    correct_answer: decodeHtmlEntities(raw.correct_answer),
    incorrect_answers: raw.incorrect_answers.map(decodeHtmlEntities),
  };
}

@Injectable({ providedIn: 'root' })
export class TriviaService {
  private readonly http = inject(HttpClient);
  private readonly firebaseService = inject(FirebaseService);
  private readonly offlineQuestionsService = inject(OfflineQuestionsService);
  private readonly seenQuestionsService = inject(SeenQuestionsService);

  private categoriesPromise: Promise<TriviaCategory[]> | null = null;
  private offlinePrefetchScheduled = false;

  /** True when the most recent `getQuestions()` call was served from the offline IndexedDB pool instead of the network. */
  readonly playingOffline = signal(false);

  /**
   * Categories are fetched once and memoized for the session — they change
   * about never, and both the game-setup form and `resolveCategoryId()` ask
   * for them.
   *
   * The memo is dropped if the fetch fails. Caching a *rejected* promise turns
   * one bad moment — a flaky connection, Open Trivia DB briefly down — into a
   * permanently degraded session: every later call returns the same rejection,
   * so the category picker stays stuck on "Any Category" until a full page
   * reload, long after the network recovered. Same pattern as
   * `SubscriptionService.getProPrices()`.
   *
   * Clearing unconditionally is safe here: the field is only reassigned when
   * it is null, and it is still this promise for as long as this promise is
   * the rejected one, so there is no newer memo to clobber. Attaching
   * `.catch()` also means the rejection is handled even if no caller is
   * listening, while callers that are still get their own rejection.
   */
  getCategories(): Promise<TriviaCategory[]> {
    if (!this.categoriesPromise) {
      this.categoriesPromise = firstValueFrom(
        this.http
          .get<{ trivia_categories: TriviaCategory[] }>(OPEN_TRIVIA_CATEGORIES_URL)
          .pipe(map((res) => res.trivia_categories)),
      );
      this.categoriesPromise.catch(() => {
        this.categoriesPromise = null;
      });
    }
    return this.categoriesPromise;
  }

  /**
   * Unified entry point: fetches questions from Open Trivia DB, Firestore, or both — falling
   * back to the offline IndexedDB pool (`OfflineQuestionsService`) if the network fetch itself
   * fails. A legitimate "no questions for this filter" result (empty array, no error) is left
   * alone — only a failed network attempt falls back.
   *
   * Deliberately does NOT pre-check `navigator.onLine` to skip straight to the offline pool:
   * that property is well-known to misreport `false` in some headless/CI/sandboxed browser
   * environments even when the network is fine (confirmed the hard way — it made this method
   * skip a working Firestore fetch during a real CI run, silently substituting cached offline
   * content for the live one). Always attempting the real fetch first and only falling back on
   * an actual thrown failure is both more robust and no slower in the genuinely-offline case —
   * every underlying network call here already has its own deadline (`AbortSignal.timeout`
   * inside `FirestoreRestClient`, the `HttpClient` call failing fast on a real connection
   * error).
   */
  async getQuestions(config: GameConfig): Promise<TriviaQuestion[]> {
    try {
      // One read of the device's seen-set per draw, shared by both halves of a
      // mixed game (`FEAT-034`). Started here and passed down **unawaited**,
      // so the network request goes out first and a local IndexedDB read never
      // sits in front of it. `null` means there is nothing to deduplicate
      // against — an untouched device, a cleared browser, or storage that will
      // not open — and every branch below then behaves exactly as it did
      // before the feature existed.
      const questions = await this.fetchQuestions(config, this.seenQuestionsService.readSeenSet());
      this.playingOffline.set(false);
      return questions;
    } catch (error) {
      const offlineQuestions = await this.offlineQuestionsService.getOfflineQuestions(config);
      if (offlineQuestions.length > 0) {
        this.playingOffline.set(true);
        return offlineQuestions;
      }
      throw error;
    }
  }

  /**
   * Schedules a best-effort background refill of the offline question pool — once when the
   * browser is idle (or after a short timeout, whichever comes first) and again on every
   * reconnect. Call once from the app root (mirrors `AuthService.ensureSignedIn()`). No-ops
   * under `environment.enableOfflinePrefetch === false` (the e2e/lighthouse *build*, i.e. the
   * local emulator-backed suite — see the comment on that flag for why), and also under
   * `navigator.webdriver` (true for every browser-automation framework — Playwright, Selenium —
   * by spec). The second check is what actually matters for the *preview* e2e job:
   * that one deploys the plain production build (`environment.ts`, prefetch enabled), so the
   * environment flag alone doesn't catch it — confirmed live: this task's own opentdb.com/
   * Firestore requests, firing on every page visit the preview suite makes against a real,
   * shared, rate-limited backend, was the likely cause of a real CI run timing out on multiple
   * unrelated specs. A real user's browser never sets `navigator.webdriver`, so this doesn't
   * affect anyone actually playing the game.
   */
  initOfflinePrefetch(): void {
    if (
      this.offlinePrefetchScheduled ||
      !environment.enableOfflinePrefetch ||
      navigator.webdriver
    ) {
      return;
    }
    this.offlinePrefetchScheduled = true;

    const run = () => void this.refillOfflinePool();
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 10_000 });
    } else {
      setTimeout(run, 2_000);
    }
    window.addEventListener('online', run);
  }

  private async refillOfflinePool(targetCount = OFFLINE_POOL_TARGET): Promise<void> {
    if (!navigator.onLine) {
      return;
    }

    try {
      const cached = await this.offlineQuestionsService.getCount();
      const deficit = targetCount - cached;
      if (deficit <= 0) {
        return;
      }

      const questions = await this.fetchQuestions(
        {
          amount: Math.min(deficit, MAX_PREFETCH_BATCH),
          category: '',
          difficulty: '',
          source: 'mixed',
          // Irrelevant here — this is the background prefetch topping up the
          // offline pool, not a game. Fetching does not read the limit; the
          // player picks one when they actually start playing.
          timeLimit: DEFAULT_TIME_LIMIT,
        },
        // Deliberately not deduplicated. This is filling the pool the
        // deduplicating draw *substitutes from*, and a refill that skipped
        // everything the player had answered would still be caching questions
        // for offline play — but it would also read wider and trim its own
        // batch for no benefit, since nothing here is being served to anybody.
        Promise.resolve(null),
      );
      await this.offlineQuestionsService.saveQuestions(questions);
    } catch {
      // Best-effort background task — a failed refill just leaves the existing pool as-is;
      // it'll retry on the next idle window or reconnect.
    }
  }

  /**
   * The draw. `seen` resolves to the device's seen-set, or to `null` for a
   * draw that does not deduplicate at all — the background prefetch, and any
   * device with nothing in the set.
   *
   * Each source deduplicates over its own half of a mixed game rather than
   * over the merged result, because the reservoir each substitutes from is
   * source-scoped: `getMatchingQuestions` never crosses `source`, for the same
   * reason the offline draw never does.
   */
  private async fetchQuestions(
    config: GameConfig,
    seen: Promise<SeenSet | null>,
  ): Promise<TriviaQuestion[]> {
    const { amount, category, difficulty, source } = config;

    if (source === 'open_trivia') {
      return this.drawOpenTriviaQuestions(amount, category, difficulty, seen);
    }

    if (source === 'custom') {
      return this.drawCustomQuestions(amount, category, difficulty, seen);
    }

    const openTriviaAmount = Math.ceil(amount / 2);
    const customAmount = amount - openTriviaAmount;

    const [openTriviaQuestions, customQuestions] = await Promise.all([
      this.drawOpenTriviaQuestions(openTriviaAmount, category, difficulty, seen).catch(() => []),
      this.drawCustomQuestions(customAmount, category, difficulty, seen),
    ]);

    return shuffleArray([...openTriviaQuestions, ...customQuestions]).slice(0, amount);
  }

  /**
   * Open Trivia DB, deduplicated against the offline pool.
   *
   * **The request is exactly the one this always made** — one call, asking for
   * the game's own question count, issued before anything is awaited. Open
   * Trivia DB rate-limits a client to one request every five seconds, so a
   * second call to widen the candidate list would be refused outright rather
   * than merely cost something, and raising `amount` is not a substitute (see
   * {@link DEDUPE_DRAW_MULTIPLIER}). What makes substitution possible here is
   * the offline pool, which the background prefetch keeps topped up to a
   * hundred questions for exactly the reason it is useful here too: they are
   * already paid for. Unlike the bank, nothing about a pooled Open Trivia DB
   * question can go stale — there is no moderation state to have changed.
   *
   * **How much it can do varies with the filters, and can be nothing.** The
   * reserve is the pool narrowed to this game's own category and difficulty,
   * and the prefetch fills the pool with unfiltered batches — so a game with
   * no filters draws on most of it and a narrow one on little. A category
   * invented by a contributor is the extreme: no Open Trivia DB question
   * carries it, so the reserve is empty and this half of a mixed game simply
   * does not deduplicate.
   */
  private async drawOpenTriviaQuestions(
    amount: number,
    category: string,
    difficulty: Difficulty | '',
    seen: Promise<SeenSet | null>,
  ): Promise<TriviaQuestion[]> {
    const [fetched, seenSet] = await Promise.all([
      this.fetchOpenTriviaQuestions(amount, category, difficulty),
      seen,
    ]);
    if (!seenSet || fetched.length === 0) {
      return fetched;
    }
    const reserve = await this.offlineQuestionsService.getMatchingQuestions(
      'open_trivia',
      category,
      difficulty,
    );
    return preferUnseen([...fetched, ...reserve], Math.min(amount, fetched.length), seenSet);
  }

  /**
   * The shared bank, drawn wider than the game when there is a seen-set to
   * filter against.
   *
   * **The offline pool is deliberately not a reserve here**, unlike the Open
   * Trivia draw above, and the reason is moderation rather than cost. A pooled
   * question was approved when it was fetched and may have been rejected
   * since; the pool stores no `status` and no client may re-check one, so
   * substituting from it would put a withdrawn question back into an online
   * game — the exact outcome review-before-publish exists to prevent. The
   * widened read is this source's substitute supply and it needs no second
   * source: every candidate it produces came from a query that filtered on
   * `status == 'approved'` moments ago. The pool keeps its other job, which is
   * the fallback when the network fails outright.
   *
   * This one has to know the seen-set *before* it queries, because the
   * seen-set is what decides how wide to read — so unlike the Open Trivia
   * draw, the local read genuinely precedes the network one here. It is an
   * IndexedDB `getAll` of at most two thousand small records against a
   * Firestore round trip, and it happens while the other half of a mixed game
   * is already in flight.
   */
  private async drawCustomQuestions(
    amount: number,
    category: string,
    difficulty: Difficulty | '',
    seen: Promise<SeenSet | null>,
  ): Promise<TriviaQuestion[]> {
    if (amount <= 0) {
      return [];
    }
    const seenSet = await seen;
    if (!seenSet) {
      return this.fetchCustomQuestions(amount, category, difficulty);
    }

    const fetched = await this.fetchCustomQuestions(
      Math.min(amount * DEDUPE_DRAW_MULTIPLIER, MAX_DEDUPE_DRAW),
      category,
      difficulty,
    );
    return preferUnseen(fetched, Math.min(amount, fetched.length), seenSet);
  }

  private async fetchOpenTriviaQuestions(
    amount: number,
    category: string,
    difficulty: Difficulty | '',
  ): Promise<TriviaQuestion[]> {
    if (amount <= 0) {
      return [];
    }

    let params = new HttpParams().set('amount', amount);

    if (category) {
      const categoryId = await this.resolveCategoryId(category);
      if (categoryId !== undefined) {
        params = params.set('category', categoryId);
      }
    }
    if (difficulty) {
      params = params.set('difficulty', difficulty);
    }

    const response = await firstValueFrom(
      this.http.get<OpenTriviaApiResponse>(OPEN_TRIVIA_QUESTIONS_URL, { params }),
    );

    if (response.response_code !== 0) {
      return [];
    }

    return response.results.map((raw, index) =>
      this.mapToTriviaQuestion(
        decodeOpenTriviaText(raw),
        'open_trivia',
        `open-${Date.now()}-${index}`,
      ),
    );
  }

  /**
   * One page of the shared bank. `limit` is how many documents to *read*,
   * which is the game's own question count except on a deduplicating draw —
   * see {@link DEDUPE_DRAW_MULTIPLIER} for why those differ and by how much.
   */
  private async fetchCustomQuestions(
    limit: number,
    category: string,
    difficulty: Difficulty | '',
  ): Promise<TriviaQuestion[]> {
    if (limit <= 0) {
      return [];
    }

    // Filtering and the ceiling are both the query's job now. This used to pull
    // the whole collection and filter here, which billed for every document
    // anyone had ever contributed on every custom or mixed game (finding C1).
    const docs = await firstValueFrom(
      this.firebaseService.getCustomQuestions({ category, difficulty, limit }),
    );

    // Still shuffled: the query returns document-ID order, which is stable
    // within a batch, and the correct answer's position shouldn't be
    // predictable from the order questions arrive in.
    return shuffleArray(docs).map((doc) => this.mapToTriviaQuestion(doc, 'custom', doc.id));
  }

  private async resolveCategoryId(categoryName: string): Promise<number | undefined> {
    const categories = await this.getCategories();
    return categories.find((c) => c.name === categoryName)?.id;
  }

  /**
   * Shapes an already-normalized question. Deliberately performs no text
   * transformation of its own — see `decodeOpenTriviaText`, and `CLAUDE.md`
   * §4.4 on normalizing per source rather than in shared code.
   */
  private mapToTriviaQuestion(
    raw: OpenTriviaApiQuestion | (CustomQuestionDoc & { id: string }),
    source: 'open_trivia' | 'custom',
    id: string,
  ): TriviaQuestion {
    const { question, correct_answer, incorrect_answers } = raw;

    return {
      id,
      category: raw.category,
      type: raw.type,
      difficulty: raw.difficulty,
      question,
      correct_answer,
      incorrect_answers,
      // Ids come from each answer's position in the source arrays, never from
      // its text — that is the whole point. Two answers with identical text
      // still get distinct ids, so `@for` tracks them apart and a click
      // identifies exactly the option that was clicked.
      all_answers: shuffleArray<Answer>([
        { id: `${id}:correct`, text: correct_answer, isCorrect: true },
        ...incorrect_answers.map((text, index) => ({
          id: `${id}:incorrect-${index}`,
          text,
          isCorrect: false,
        })),
      ]),
      source,
      // The three optional fields a contributor may attach (`FEAT-022`), all
      // of which only a `custom` question can carry — Open Trivia DB exposes
      // neither a citation nor a justification. Spread rather than assigned so
      // each key is absent rather than `undefined`, which keeps a question
      // that has none from serialising them into the saved-game snapshot and
      // the offline pool.
      ...('sourceUrl' in raw && raw.sourceUrl ? { sourceUrl: raw.sourceUrl } : {}),
      ...('sourceTitle' in raw && raw.sourceTitle ? { sourceTitle: raw.sourceTitle } : {}),
      ...('explanation' in raw && raw.explanation ? { explanation: raw.explanation } : {}),
      // How the text is meant to be read (`FEAT-019`), and the fourth field
      // only a `custom` question can carry. An Open Trivia question is
      // `plain` by construction: its entity decoding happens in
      // `decodeOpenTriviaText` above, which is where a per-source
      // transformation belongs, and nothing stores it for a field to describe.
      ...('format' in raw && raw.format ? { format: raw.format } : {}),
    };
  }
}
