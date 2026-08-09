import { Injectable } from '@angular/core';

const DB_NAME = 'trivia-offline';

/**
 * One database, one version, one schema — so the version and every object store
 * live here rather than in the services that use them.
 *
 * IndexedDB gives a database a single version shared by every connection to it.
 * Two services opening the same database at different versions is not a
 * "mostly fine" arrangement that happens to work: the higher one triggers an
 * upgrade, the lower one blocks it while its connection stays open, and each
 * one's `onupgradeneeded` only knows about its own stores — so whichever runs
 * would drop the other's. Centralising the schema is what makes a second store
 * safe to add at all.
 *
 * Version history:
 * - **1** — `questions` only.
 * - **2** — `questions` recreated: `all_answers` changed from `string[]` to
 *   `Answer[]` (finding B1), so v1 rows would render `undefined` for every
 *   option and cannot be migrated.
 * - **3** — added `game-state` (finding B8). `questions` is deliberately
 *   *preserved* across this one: nothing about its shape changed, and wiping a
 *   player's offline pool because an unrelated store was added would take away
 *   the questions exactly when they may have no network to refill them.
 */
const DB_VERSION = 3;

/** Rolling pool of prefetched questions (`OfflineQuestionsService`). Keyed by question text. */
export const QUESTIONS_STORE = 'questions';

/** The single in-progress game (`GamePersistenceService`). Keyed by `id`, only ever `CURRENT_GAME_KEY`. */
export const GAME_STATE_STORE = 'game-state';

/** There is only ever one game in flight, so it always occupies the same key. */
export const CURRENT_GAME_KEY = 'current';

/**
 * Opens the app's IndexedDB database, shared by every store in it.
 *
 * Injectable rather than a module-level singleton so a test gets a fresh
 * instance per `TestBed`, and so both consumers resolve to the *same* root
 * instance — one connection, opened once, rather than one per service.
 */
@Injectable({ providedIn: 'root' })
export class OfflineDbService {
  private dbPromise: Promise<IDBDatabase> | null = null;

  open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => upgrade(request.result, event.oldVersion);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error as Error);
      });
      // A failed open must not be memoized as a permanent failure — same
      // reasoning as TriviaService.getCategories (finding B3).
      this.dbPromise.catch(() => {
        this.dbPromise = null;
      });
    }
    return this.dbPromise;
  }

  /**
   * Closes the connection and forgets it, so the next `open()` reconnects.
   *
   * Nothing in the app calls this — the connection is meant to live as long as
   * the tab. It exists because an open connection *blocks* a version upgrade or
   * a `deleteDatabase`, so a test that exercises either has no way to reach a
   * clean starting state while a previous injector's connection is still
   * holding the database open.
   */
  async close(): Promise<void> {
    const pending = this.dbPromise;
    this.dbPromise = null;
    if (!pending) {
      return;
    }
    await pending.then((db) => db.close()).catch(() => undefined);
  }
}

/**
 * Creates whatever the running version needs, given where this browser is
 * upgrading *from* — `oldVersion` is 0 for a database that has never existed.
 *
 * Written additively (create what is missing) rather than as "drop and
 * recreate everything", so a schema bump only costs the data whose shape
 * actually changed.
 */
function upgrade(db: IDBDatabase, oldVersion: number): void {
  // v1's `all_answers` shape is unreadable to the current code and there is
  // nothing to migrate it from, so those rows go. Only ever applies to a
  // browser that last ran the app before B1 shipped.
  if (oldVersion > 0 && oldVersion < 2 && db.objectStoreNames.contains(QUESTIONS_STORE)) {
    db.deleteObjectStore(QUESTIONS_STORE);
  }

  if (!db.objectStoreNames.contains(QUESTIONS_STORE)) {
    const questions = db.createObjectStore(QUESTIONS_STORE, { keyPath: 'question' });
    questions.createIndex('cachedAt', 'cachedAt');
  }

  if (!db.objectStoreNames.contains(GAME_STATE_STORE)) {
    db.createObjectStore(GAME_STATE_STORE, { keyPath: 'id' });
  }
}
