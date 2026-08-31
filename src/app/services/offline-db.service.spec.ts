import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import {
  DAILY_LIMIT_STORE,
  GAME_STATE_STORE,
  OFFLINE_DB_NAME,
  OfflineDbService,
  QUESTIONS_STORE,
} from './offline-db.service';

/**
 * Finding B8 put a second object store into the database the offline question
 * pool already lived in, which turns the schema into something with a real
 * migration to get wrong.
 *
 * The failure worth guarding is silent: an upgrade that recreates every store
 * would wipe a player's cached questions as a side effect of adding an
 * unrelated one — taking the offline pool away at exactly the moment they may
 * have no network to refill it, and doing so without any error.
 *
 * **Every test here works on a database of its own** (`OFFLINE_DB_NAME`).
 * IndexedDB names are global to the origin and Vitest shares one environment
 * across spec files, so an earlier version of this suite tried to reach a known
 * starting state by deleting the shared database — which blocks for as long as
 * any other spec file holds a connection. That passed locally and hung on CI.
 * A unique name per test removes the shared state rather than sequencing access
 * to it, so nothing here can block on, or be blocked by, another file.
 */

let dbCounter = 0;

/**
 * Builds an older database by hand: `questions` keyed the way that version
 * keyed it, plus (from v3) a `game-state` row, so a migration can be observed
 * rather than inferred.
 */
function seedOldDatabase(name: string, version: 2 | 3 | 4): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, version);
    open.onupgradeneeded = () => {
      const db = open.result;
      // Pre-v4 stores were keyed on the question text (finding C4); v4 moved
      // to the source-aware `dedupeKey`.
      const store = db.createObjectStore(QUESTIONS_STORE, {
        keyPath: version >= 4 ? 'dedupeKey' : 'question',
      });
      store.createIndex('cachedAt', 'cachedAt');
      if (version >= 3) {
        db.createObjectStore(GAME_STATE_STORE, { keyPath: 'id' });
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      const stores = version >= 3 ? [QUESTIONS_STORE, GAME_STATE_STORE] : [QUESTIONS_STORE];
      const tx = db.transaction(stores, 'readwrite');
      // Keyed to match whichever schema is being seeded: v4 moved the store's
      // keyPath to `dedupeKey`, and a record missing its key aborts the write.
      tx.objectStore(QUESTIONS_STORE).put(
        version >= 4
          ? { dedupeKey: 'open_trivia:cached', question: 'Cached before the upgrade?', cachedAt: 1 }
          : { question: 'Cached before the upgrade?', cachedAt: 1 },
      );
      if (version >= 3) {
        tx.objectStore(GAME_STATE_STORE).put({ id: 'current', score: 7 });
      }
      tx.oncomplete = () => {
        // Must close, or this connection blocks the upgrade below.
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error as Error);
      };
    };
    open.onerror = () => reject(open.error as Error);
  });
}

function readGameState(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(GAME_STATE_STORE, 'readonly')
      .objectStore(GAME_STATE_STORE)
      .get('current');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
}

function countQuestions(db: IDBDatabase): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(QUESTIONS_STORE, 'readonly')
      .objectStore(QUESTIONS_STORE)
      .count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
}

describe('OfflineDbService schema (B8)', () => {
  /** Connections opened by a test, closed afterwards so none leak across the file. */
  let opened: IDBDatabase[] = [];
  let dbName = '';

  /** A service pointed at this test's own database. */
  async function openViaService(): Promise<IDBDatabase> {
    TestBed.configureTestingModule({
      providers: [{ provide: OFFLINE_DB_NAME, useValue: dbName }],
    });
    const db = await TestBed.inject(OfflineDbService).open();
    opened.push(db);
    return db;
  }

  beforeEach(() => {
    dbName = `trivia-offline-spec-${dbCounter++}`;
  });

  afterEach(() => {
    for (const db of opened) {
      db.close();
    }
    opened = [];
    TestBed.resetTestingModule();
  });

  // Finding C4 re-keyed `questions`, and a store's keyPath cannot be changed in
  // place — so unlike the v2→v3 upgrade, this one has to discard the pool. It
  // must still not touch the in-progress game, which is not refillable.
  it('upgrading v3 to v4 rebuilds the question store but keeps the saved game', async () => {
    await seedOldDatabase(dbName, 3);

    const db = await openViaService();

    expect(db.version).toBe(5);
    expect(await countQuestions(db)).toBe(0);
    expect(await readGameState(db)).toEqual({ id: 'current', score: 7 });
  });

  it('upgrading from v2 creates every store', async () => {
    await seedOldDatabase(dbName, 2);

    const db = await openViaService();

    expect(db.version).toBe(5);
    expect(db.objectStoreNames.contains(GAME_STATE_STORE)).toBe(true);
    expect(db.objectStoreNames.contains(DAILY_LIMIT_STORE)).toBe(true);
    expect(await countQuestions(db)).toBe(0);
  });

  it('creates every store from nothing', async () => {
    const db = await openViaService();

    expect(db.objectStoreNames.contains(QUESTIONS_STORE)).toBe(true);
    expect(db.objectStoreNames.contains(GAME_STATE_STORE)).toBe(true);
    expect(db.objectStoreNames.contains(DAILY_LIMIT_STORE)).toBe(true);
    expect(await countQuestions(db)).toBe(0);
  });

  /**
   * The v5 addition, from a database that predates it. A browser upgrading
   * in-place is the case a "create what is missing" upgrade path exists for,
   * and the one a fresh-install test cannot reach.
   */
  it('adds the daily-limit store to an existing v4 database, keeping the saved game', async () => {
    await seedOldDatabase(dbName, 4);

    const db = await openViaService();

    expect(db.version).toBe(5);
    expect(db.objectStoreNames.contains(DAILY_LIMIT_STORE)).toBe(true);
    expect(await readGameState(db)).toEqual({ id: 'current', score: 7 });
  });

  it('opens once and shares the connection', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: OFFLINE_DB_NAME, useValue: dbName }],
    });
    const service = TestBed.inject(OfflineDbService);

    const [first, second] = await Promise.all([service.open(), service.open()]);
    opened.push(first);

    expect(first).toBe(second);
  });

  it('defaults to the app database when nothing overrides the name', () => {
    TestBed.configureTestingModule({});
    expect(TestBed.inject(OFFLINE_DB_NAME)).toBe('trivia-offline');
  });
});
