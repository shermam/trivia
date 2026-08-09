import { Injectable, inject, signal } from '@angular/core';
import { GameConfig, TriviaQuestion } from '../models/question.model';
import { shuffleArray } from '../utils/shuffle.util';
import { OfflineDbService, QUESTIONS_STORE as STORE_NAME } from './offline-db.service';

/** Oldest-first trim ceiling — bounds an IndexedDB pool that's topped up on every reconnect over a long-lived session. */
const MAX_POOL_SIZE = 200;

interface StoredQuestion extends TriviaQuestion {
  /** `Date.now()` at save time — the trim cursor's sort key (see `trimToMaxSize`). */
  cachedAt: number;
  /** The store's key. See `dedupeKeyFor`. */
  dedupeKey: string;
}

/**
 * Identity of a cached question, and the store's `keyPath`.
 *
 * The store used to be keyed on the question *text* alone, so two questions
 * that happened to share wording collided and one silently replaced the other
 * — **including across sources** (finding C4). That was worse than losing a
 * row: `getOfflineQuestions()` never crosses `source`, so a custom question
 * overwriting an Open Trivia one didn't just evict it, it moved the remaining
 * copy into the other source's pool, shrinking what an `open_trivia` request
 * could draw from while looking like the pool was full.
 *
 * The two sources need different identities, because only one of them has a
 * stable id:
 *
 * - **`custom`** questions carry their Firestore document id, which is stable
 *   across fetches and unique per document — so two contributors submitting the
 *   same wording are correctly kept as two questions.
 * - **`open_trivia`** questions get an id minted at fetch time
 *   (`open-${Date.now()}-${index}`), which is different on every fetch. Keying
 *   on it would defeat the point of upserting: the pool would fill with copies
 *   of the same question. Its text is the only stable identity it has.
 */
function dedupeKeyFor(question: TriviaQuestion): string {
  return question.source === 'custom'
    ? `custom:${question.id}`
    : `open_trivia:${question.question}`;
}

/**
 * Persists a rolling pool of trivia questions in IndexedDB, keyed per source
 * (`dedupeKeyFor`) so re-fetching the same question is a no-op rather than a
 * duplicate, while two questions that merely share wording stay distinct.
 * Storage only: fetching fresh questions and deciding when to refill is
 * TriviaService's job (`prefetchOfflinePool`/`getQuestions`'s fallback) — kept
 * separate so this stays a dependency-free leaf that's easy to unit test
 * without a live network or Firestore.
 */
@Injectable({ providedIn: 'root' })
export class OfflineQuestionsService {
  /** Best-effort UI signal (e.g. "N questions available offline") — refreshed after every save, not guaranteed to be live. */
  readonly cachedCount = signal(0);

  private readonly db = inject(OfflineDbService);

  constructor() {
    // Best-effort: IndexedDB can be unavailable (Safari private mode, older browsers, or a
    // plain jsdom unit test) — the cachedCount signal just stays at 0 in that case.
    void this.getCount()
      .then((count) => this.cachedCount.set(count))
      .catch(() => undefined);
  }

  async getCount(): Promise<number> {
    const db = await this.db.open();
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

    const db = await this.db.open();
    const cachedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const question of questions) {
        store.put({
          ...question,
          cachedAt,
          dedupeKey: dedupeKeyFor(question),
        } satisfies StoredQuestion);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
    });

    await this.trimToMaxSize();
    this.cachedCount.set(await this.getCount());
  }

  /**
   * Best-effort offline draw: never crosses `source` — a "Custom" request only ever draws from
   * cached `custom`-sourced questions (and vice versa for "Open Trivia"), never silently
   * substituting the other, since that's a stronger promise to the player than category/
   * difficulty ("community question bank" vs "random trivia" isn't a matter of degree). Within
   * that source-scoped pool, category/difficulty are only a *preference* — falls back to the
   * whole source-scoped pool if too few match, since a mismatched-topic offline game beats no
   * offline game at all.
   */
  async getOfflineQuestions(config: GameConfig): Promise<TriviaQuestion[]> {
    const { amount, category, difficulty, source } = config;
    const all = await this.getAllQuestions();

    const sourceScoped = source === 'mixed' ? all : all.filter((q) => q.source === source);

    const filtered = sourceScoped.filter(
      (q) => (!category || q.category === category) && (!difficulty || q.difficulty === difficulty),
    );
    const pool = filtered.length >= Math.min(amount, sourceScoped.length) ? filtered : sourceScoped;

    return shuffleArray(pool).slice(0, amount);
  }

  private async getAllQuestions(): Promise<TriviaQuestion[]> {
    const db = await this.db.open();
    const stored = await new Promise<StoredQuestion[]>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as StoredQuestion[]);
      request.onerror = () => reject(request.error as Error);
    });
    // Strip the storage-only fields so callers only ever see a plain TriviaQuestion.
    return stored.map(({ cachedAt: _cachedAt, dedupeKey: _dedupeKey, ...question }) => question);
  }

  private async trimToMaxSize(): Promise<void> {
    const db = await this.db.open();
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
}
