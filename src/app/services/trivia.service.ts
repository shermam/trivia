import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom, map } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  Answer,
  CustomQuestionDoc,
  Difficulty,
  GameConfig,
  OpenTriviaApiQuestion,
  OpenTriviaApiResponse,
  TriviaQuestion,
} from '../models/question.model';
import { decodeHtmlEntities } from '../utils/html-entities.util';
import { shuffleArray } from '../utils/shuffle.util';
import { FirebaseService } from './firebase.service';
import { OfflineQuestionsService } from './offline-questions.service';

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
   * `SubscriptionService.getProPriceId()`.
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
   * every underlying network call here already has its own deadline (`giveUpAfter` in
   * `FirebaseService`, the `HttpClient` call failing fast on a real connection error).
   */
  async getQuestions(config: GameConfig): Promise<TriviaQuestion[]> {
    try {
      const questions = await this.fetchQuestions(config);
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
   * `navigator.webdriver` (true for every browser-automation framework — Cypress, Selenium,
   * Playwright — by spec). The second check is what actually matters for the *preview* e2e job:
   * that one deploys the plain production build (`environment.ts`, prefetch enabled), so the
   * environment flag alone doesn't catch it — confirmed live: this task's own opentdb.com/
   * Firestore requests, firing on every one of Cypress's ~13 page visits against a real,
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

      const questions = await this.fetchQuestions({
        amount: Math.min(deficit, MAX_PREFETCH_BATCH),
        category: '',
        difficulty: '',
        source: 'mixed',
      });
      await this.offlineQuestionsService.saveQuestions(questions);
    } catch {
      // Best-effort background task — a failed refill just leaves the existing pool as-is;
      // it'll retry on the next idle window or reconnect.
    }
  }

  private async fetchQuestions(config: GameConfig): Promise<TriviaQuestion[]> {
    const { amount, category, difficulty, source } = config;

    if (source === 'open_trivia') {
      return this.fetchOpenTriviaQuestions(amount, category, difficulty);
    }

    if (source === 'custom') {
      return this.fetchCustomQuestions(amount, category, difficulty);
    }

    const openTriviaAmount = Math.ceil(amount / 2);
    const customAmount = amount - openTriviaAmount;

    const [openTriviaQuestions, customQuestions] = await Promise.all([
      this.fetchOpenTriviaQuestions(openTriviaAmount, category, difficulty).catch(() => []),
      this.fetchCustomQuestions(customAmount, category, difficulty),
    ]);

    return shuffleArray([...openTriviaQuestions, ...customQuestions]).slice(0, amount);
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

  private async fetchCustomQuestions(
    amount: number,
    category: string,
    difficulty: Difficulty | '',
  ): Promise<TriviaQuestion[]> {
    if (amount <= 0) {
      return [];
    }

    // Filtering and the ceiling are both the query's job now. This used to pull
    // the whole collection and filter here, which billed for every document
    // anyone had ever contributed on every custom or mixed game (finding C1).
    const docs = await firstValueFrom(
      this.firebaseService.getCustomQuestions({ category, difficulty, limit: amount }),
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
    };
  }
}
