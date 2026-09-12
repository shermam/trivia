import { Injectable, inject } from '@angular/core';
import { TriviaQuestion } from '../models/question.model';
import { seenKeyFor } from '../utils/seen-key.util';
import { OfflineDbService, SEEN_QUESTIONS_STORE as STORE_NAME } from './offline-db.service';

/**
 * How many answered questions this device remembers.
 *
 * Bounded for the same reason the offline pool is: an unbounded set on a heavy
 * player is a slow leak, and one that is read in full on every draw is a slow
 * leak with a cost attached. Two thousand is far more than the shared bank
 * holds and enough to cover months of Open Trivia DB play; past it the oldest
 * entries go, which is also the least useful half of the set — a question
 * answered a thousand questions ago is one a player would not mind meeting
 * again.
 */
export const MAX_SEEN_QUESTIONS = 2000;

/** One answered question, as the store holds it. */
interface StoredSeenQuestion {
  /** The store's key — see `seenKeyFor`. */
  key: string;
  /** Which source it came from. Not read by the draw; kept so a future eviction policy can be source-aware. */
  source: TriviaQuestion['source'];
  /** `Date.now()` when it was answered — the eviction cursor's sort key, and the draw's least-recently-seen order. */
  seenAt: number;
}

/**
 * Which questions this device has already answered, so the draw can stop
 * serving them (`FEAT-034`).
 *
 * **Per device, never per person.** Nothing here is keyed by uid, nothing
 * reaches `users/{uid}` and nothing leaves the browser. A server-side seen-set
 * would be a record of what each player has been shown, which is exactly the
 * profile this feature is built not to have — and it would pull `CLAUDE.md`
 * §4.0 in with it. The price is that two people sharing a browser share a
 * seen-set, and that clearing site data forgets everything, which is the same
 * trade the offline pool and the daily allowance already make.
 *
 * **Every access is wrapped, and the failure mode is "no deduplication".**
 * IndexedDB is unavailable outright in some private-browsing modes and can
 * refuse a write on quota; a seen-set that failed loudly would take the game
 * down with it over a feature whose worst case is the behaviour the app had
 * yesterday.
 */
@Injectable({ providedIn: 'root' })
export class SeenQuestionsService {
  private readonly db = inject(OfflineDbService);

  /**
   * Records that the player has met this question.
   *
   * Called once per resolved question from `GameControllerService` — a correct
   * answer, a wrong one, a timeout and a skip all count, because all four mean
   * the question was read. Never rejects: the caller is a signal update on the
   * critical path of a quiz.
   */
  async markSeen(question: TriviaQuestion): Promise<void> {
    const record: StoredSeenQuestion = {
      key: seenKeyFor(question),
      source: question.source,
      seenAt: Date.now(),
    };

    try {
      const db = await this.db.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as Error);
      });
      await this.evictOldest();
    } catch {
      // See the class comment: losing the seen-set costs deduplication, never
      // the game in progress.
    }
  }

  /**
   * Every key this device has answered, mapped to when it last answered it —
   * or **`null` when there is nothing to deduplicate against**.
   *
   * The null is load-bearing rather than a tidier empty map: it is the single
   * signal the draw branches on, and it collapses three cases that all have
   * the same right answer — a brand-new device, a cleared browser, and storage
   * that cannot be opened at all — into "behave exactly as this app did before
   * the feature existed". A caller that treated an empty map as a set would
   * pay the draw's extra read on a device that can never benefit from it.
   */
  async readSeenSet(): Promise<ReadonlyMap<string, number> | null> {
    let rows: StoredSeenQuestion[];
    try {
      const db = await this.db.open();
      rows = await new Promise<StoredSeenQuestion[]>((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result as StoredSeenQuestion[]);
        request.onerror = () => reject(request.error as Error);
      });
    } catch {
      return null;
    }

    if (rows.length === 0) {
      return null;
    }
    return new Map(rows.map((row) => [row.key, row.seenAt]));
  }

  /** Oldest-first trim back to {@link MAX_SEEN_QUESTIONS}, walking the `seenAt` index. */
  private async evictOldest(): Promise<void> {
    const db = await this.db.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const countRequest = store.count();
      countRequest.onsuccess = () => {
        const overflow = countRequest.result - MAX_SEEN_QUESTIONS;
        if (overflow <= 0) {
          resolve();
          return;
        }
        let deleted = 0;
        const cursorRequest = store.index('seenAt').openCursor();
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
