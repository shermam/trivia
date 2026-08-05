import { Injectable, signal } from '@angular/core';
import { GameConfig, TriviaQuestion } from '../models/question.model';
import { shuffleArray } from '../utils/shuffle.util';

const DB_NAME = 'trivia-offline';
const DB_VERSION = 1;
const STORE_NAME = 'questions';
/** Oldest-first trim ceiling — bounds an IndexedDB pool that's topped up on every reconnect over a long-lived session. */
const MAX_POOL_SIZE = 200;

interface StoredQuestion extends TriviaQuestion {
  /** `Date.now()` at save time — the trim cursor's sort key (see `trimToMaxSize`). */
  cachedAt: number;
}

/**
 * Persists a rolling pool of trivia questions in IndexedDB, keyed by question
 * text so re-fetching the same question is a no-op rather than a duplicate.
 * Storage only: fetching fresh questions and deciding when to refill is
 * TriviaService's job (`prefetchOfflinePool`/`getQuestions`'s fallback) — kept
 * separate so this stays a dependency-free leaf that's easy to unit test
 * without a live network or Firestore.
 */
@Injectable({ providedIn: 'root' })
export class OfflineQuestionsService {
  /** Best-effort UI signal (e.g. "N questions available offline") — refreshed after every save, not guaranteed to be live. */
  readonly cachedCount = signal(0);

  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor() {
    // Best-effort: IndexedDB can be unavailable (Safari private mode, older browsers, or a
    // plain jsdom unit test) — the cachedCount signal just stays at 0 in that case.
    void this.getCount()
      .then((count) => this.cachedCount.set(count))
      .catch(() => undefined);
  }

  async getCount(): Promise<number> {
    const db = await this.openDb();
    return new Promise<number>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error as Error);
    });
  }

  /** Upserts questions (by question text) and trims the pool back down to `MAX_POOL_SIZE` if needed. */
  async saveQuestions(questions: readonly TriviaQuestion[]): Promise<void> {
    if (questions.length === 0) {
      return;
    }

    const db = await this.openDb();
    const cachedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const question of questions) {
        store.put({ ...question, cachedAt } satisfies StoredQuestion);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
    });

    await this.trimToMaxSize();
    this.cachedCount.set(await this.getCount());
  }

  /**
   * Best-effort offline draw: prefers questions matching category/difficulty, but
   * falls back to the whole pool if too few match — a mismatched offline game beats
   * no offline game at all.
   */
  async getOfflineQuestions(config: GameConfig): Promise<TriviaQuestion[]> {
    const { amount, category, difficulty } = config;
    const all = await this.getAllQuestions();

    const filtered = all.filter(
      (q) => (!category || q.category === category) && (!difficulty || q.difficulty === difficulty),
    );
    const pool = filtered.length >= Math.min(amount, all.length) ? filtered : all;

    return shuffleArray(pool).slice(0, amount);
  }

  private async getAllQuestions(): Promise<TriviaQuestion[]> {
    const db = await this.openDb();
    const stored = await new Promise<StoredQuestion[]>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as StoredQuestion[]);
      request.onerror = () => reject(request.error as Error);
    });
    // Strip the storage-only `cachedAt` field so callers only ever see a plain TriviaQuestion.
    return stored.map(({ cachedAt: _cachedAt, ...question }) => question);
  }

  private async trimToMaxSize(): Promise<void> {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const countRequest = store.count();
      countRequest.onsuccess = () => {
        const overflow = countRequest.result - MAX_POOL_SIZE;
        if (overflow <= 0) {
          resolve();
          return;
        }
        let deleted = 0;
        const cursorRequest = store.index('cachedAt').openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || deleted >= overflow) {
            resolve();
            return;
          }
          cursor.delete();
          deleted++;
          cursor.continue();
        };
        cursorRequest.onerror = () => reject(cursorRequest.error as Error);
      };
      countRequest.onerror = () => reject(countRequest.error as Error);
    });
  }

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'question' });
            store.createIndex('cachedAt', 'cachedAt');
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error as Error);
      });
    }
    return this.dbPromise;
  }
}
