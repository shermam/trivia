import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom, map } from 'rxjs';
import { environment } from '../../environments/environment';
import {
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

@Injectable({ providedIn: 'root' })
export class TriviaService {
  private readonly http = inject(HttpClient);
  private readonly firebaseService = inject(FirebaseService);
  private readonly offlineQuestionsService = inject(OfflineQuestionsService);

  private categoriesPromise: Promise<TriviaCategory[]> | null = null;
  private offlinePrefetchScheduled = false;

  /** True when the most recent `getQuestions()` call was served from the offline IndexedDB pool instead of the network. */
  readonly playingOffline = signal(false);

  getCategories(): Promise<TriviaCategory[]> {
    if (!this.categoriesPromise) {
      this.categoriesPromise = firstValueFrom(
        this.http
          .get<{ trivia_categories: TriviaCategory[] }>(OPEN_TRIVIA_CATEGORIES_URL)
          .pipe(map((res) => res.trivia_categories)),
      );
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
   * every underlying network call here already has its own timeout (`withTimeout` in
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
   * under `environment.enableOfflinePrefetch === false` (the e2e/lighthouse builds — see the
   * comment on that flag for why).
   */
  initOfflinePrefetch(): void {
    if (this.offlinePrefetchScheduled || !environment.enableOfflinePrefetch) {
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
      this.mapToTriviaQuestion(raw, 'open_trivia', `open-${Date.now()}-${index}`),
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

    const docs = await firstValueFrom(this.firebaseService.getCustomQuestions());

    const filtered = docs.filter((doc) => {
      const matchesCategory = !category || doc.category === category;
      const matchesDifficulty = !difficulty || doc.difficulty === difficulty;
      return matchesCategory && matchesDifficulty;
    });

    return shuffleArray(filtered)
      .slice(0, amount)
      .map((doc) => this.mapToTriviaQuestion(doc, 'custom', doc.id));
  }

  private async resolveCategoryId(categoryName: string): Promise<number | undefined> {
    const categories = await this.getCategories();
    return categories.find((c) => c.name === categoryName)?.id;
  }

  private mapToTriviaQuestion(
    raw: OpenTriviaApiQuestion | (CustomQuestionDoc & { id: string }),
    source: 'open_trivia' | 'custom',
    id: string,
  ): TriviaQuestion {
    const question = decodeHtmlEntities(raw.question);
    const correct_answer = decodeHtmlEntities(raw.correct_answer);
    const incorrect_answers = raw.incorrect_answers.map(decodeHtmlEntities);

    return {
      id,
      category: decodeHtmlEntities(raw.category),
      type: raw.type,
      difficulty: raw.difficulty,
      question,
      correct_answer,
      incorrect_answers,
      all_answers: shuffleArray([correct_answer, ...incorrect_answers]),
      source,
    };
  }
}
