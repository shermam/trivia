import { InjectionToken, Injectable, inject } from '@angular/core';

/**
 * The database's name, injectable so a test can point a service at a database
 * of its own.
 *
 * That matters specifically for the schema tests: IndexedDB names are global to
 * the origin, Vitest shares one environment across spec files, and a
 * `deleteDatabase` blocks for as long as *any* connection is open. A test that
 * needs to start from a known version therefore ends up racing every other spec
 * file's connections — which passed locally and hung on CI, where the run is
 * slower. Giving those tests a unique name removes the shared state instead of
 * trying to sequence access to it.
 */
export const OFFLINE_DB_NAME = new InjectionToken<string>('OFFLINE_DB_NAME', {
  providedIn: 'root',
  factory: () => 'trivia-offline',
});

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
 * - **4** — `questions` re-keyed from the question text to a source-aware
 *   `dedupeKey` (finding C4). A store's `keyPath` cannot be changed in place,
 *   so this one does have to recreate it; `game-state` is still preserved.
 * - **5** — adds `daily-limit`, the free tier's per-device game counter
 *   (`FEAT-014`). Purely additive: nothing existing is touched, and a browser
 *   arriving from any earlier version keeps its questions and its saved game.
 */
const DB_VERSION = 5;

/** Rolling pool of prefetched questions (`OfflineQuestionsService`). Keyed by question text. */
export const QUESTIONS_STORE = 'questions';

/** The single in-progress game (`GamePersistenceService`). Keyed by `id`, only ever `CURRENT_GAME_KEY`. */
export const GAME_STATE_STORE = 'game-state';

/** There is only ever one game in flight, so it always occupies the same key. */
export const CURRENT_GAME_KEY = 'current';

/**
 * The free tier's daily game counter (`DailyGameLimitService`). One record.
 *
 * Here rather than in its own database for the reason this file exists: a
 * database has one version shared by every connection, and two services
 * opening the same name at different versions is how a store gets silently
 * dropped. One database, one version, one schema.
 */
export const DAILY_LIMIT_STORE = 'daily-limit';

/** There is only ever one counter, so it always occupies the same key. */
export const DAILY_LIMIT_KEY = 'today';

/**
 * Opens the app's IndexedDB database, shared by every store in it.
 *
 * Injectable rather than a module-level singleton so a test gets a fresh
 * instance per `TestBed`, and so both consumers resolve to the *same* root
 * instance — one connection, opened once, rather than one per service.
 */
@Injectable({ providedIn: 'root' })
export class OfflineDbService {
  private readonly dbName = inject(OFFLINE_DB_NAME);
  private dbPromise: Promise<IDBDatabase> | null = null;

  open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.dbName, DB_VERSION);
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
  // Anything written before v4 is keyed by question text and cannot be
  // rewritten in place — a store's `keyPath` is fixed at creation — and
  // anything before v2 also holds the old `all_answers` shape, which the quiz
  // would render as `undefined`. Both are discarded rather than migrated: this
  // store is a cache by definition, so one refill is cheaper than a migration
  // that would never be exercised again.
  if (oldVersion > 0 && oldVersion < 4 && db.objectStoreNames.contains(QUESTIONS_STORE)) {
    db.deleteObjectStore(QUESTIONS_STORE);
  }

  if (!db.objectStoreNames.contains(QUESTIONS_STORE)) {
    const questions = db.createObjectStore(QUESTIONS_STORE, { keyPath: 'dedupeKey' });
    questions.createIndex('cachedAt', 'cachedAt');
  }

  // Never recreated: it holds an in-progress game, which is not refillable.
  if (!db.objectStoreNames.contains(GAME_STATE_STORE)) {
    db.createObjectStore(GAME_STATE_STORE, { keyPath: 'id' });
  }

  // Added in v5. A record for a day that is not today reads as a fresh
  // allowance anyway, so there is nothing to migrate into it.
  if (!db.objectStoreNames.contains(DAILY_LIMIT_STORE)) {
    db.createObjectStore(DAILY_LIMIT_STORE, { keyPath: 'id' });
  }
}
