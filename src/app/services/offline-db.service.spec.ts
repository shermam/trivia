import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import {
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

/** Builds the pre-B8 (v2) database by hand: `questions` only, holding one row. */
function seedV2Database(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 2);
    open.onupgradeneeded = () => {
      const db = open.result;
      const store = db.createObjectStore(QUESTIONS_STORE, { keyPath: 'question' });
      store.createIndex('cachedAt', 'cachedAt');
    };
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(QUESTIONS_STORE, 'readwrite');
      tx.objectStore(QUESTIONS_STORE).put({ question: 'Cached before the upgrade?', cachedAt: 1 });
      tx.oncomplete = () => {
        // Must close, or this connection blocks the v3 upgrade below.
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

  it('upgrading v2 to v3 adds the game store and keeps the cached questions', async () => {
    await seedV2Database(dbName);

    const db = await openViaService();

    expect(db.version).toBe(3);
    expect(db.objectStoreNames.contains(GAME_STATE_STORE)).toBe(true);
    // The whole point: adding a store must not cost the player their pool.
    expect(await countQuestions(db)).toBe(1);
  });

  it('creates both stores from nothing', async () => {
    const db = await openViaService();

    expect(db.objectStoreNames.contains(QUESTIONS_STORE)).toBe(true);
    expect(db.objectStoreNames.contains(GAME_STATE_STORE)).toBe(true);
    expect(await countQuestions(db)).toBe(0);
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
