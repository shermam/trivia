import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { GAME_STATE_STORE, OfflineDbService, QUESTIONS_STORE } from './offline-db.service';

/**
 * Finding B8 put a second object store into the database the offline question
 * pool already lived in, which turns the schema into something with a real
 * migration to get wrong.
 *
 * The failure worth guarding is silent: an upgrade that recreates every store
 * would wipe a player's cached questions as a side effect of adding an
 * unrelated one — taking the offline pool away at exactly the moment they may
 * have no network to refill it, and doing so without any error.
 */

const DB_NAME = 'trivia-offline';

/**
 * Removes the database outright. Vitest shares one environment (and so one
 * `fake-indexeddb`) across spec files, so another file may already have created
 * this database at the current version — and opening it at v2 afterwards is a
 * `VersionError`, not a downgrade. Starting from nothing is the only way to
 * model a browser arriving at v2.
 */
function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    // Another spec file's connection is still open; it holds no data this test
    // cares about, and the delete completes once it closes.
    request.onblocked = () => resolve();
    request.onerror = () => reject(request.error as Error);
  });
}

/** Builds the pre-B8 (v2) database by hand: `questions` only, holding one row. */
function seedV2Database(): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 2);
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
        // Must close, or the v3 upgrade blocks on this connection.
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
  /**
   * Connections opened by a test, closed before the next one deletes the
   * database — an open connection blocks a delete indefinitely, and the
   * service holds its connection for the lifetime of the injector.
   */
  let opened: IDBDatabase[] = [];

  async function openViaService(): Promise<IDBDatabase> {
    TestBed.configureTestingModule({});
    const db = await TestBed.inject(OfflineDbService).open();
    opened.push(db);
    return db;
  }

  // Other spec files share this environment's `fake-indexeddb` and may already
  // have created the database at the current version, so start from nothing
  // rather than from whatever they left behind.
  beforeEach(() => deleteDatabase());

  afterEach(async () => {
    for (const db of opened) {
      db.close();
    }
    opened = [];
    TestBed.resetTestingModule();
    await deleteDatabase();
  });

  it('upgrading v2 to v3 adds the game store and keeps the cached questions', async () => {
    await seedV2Database();

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
    TestBed.configureTestingModule({});
    const service = TestBed.inject(OfflineDbService);

    const [first, second] = await Promise.all([service.open(), service.open()]);
    opened.push(first);

    expect(first).toBe(second);
  });
});
