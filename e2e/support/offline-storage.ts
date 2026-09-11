import { Page } from '@playwright/test';

/**
 * Reading the app's own IndexedDB from a test.
 *
 * **There is nothing here that clears it, and that is the point.** Cypress
 * needed a whole module for the clearing half (`cypress/support/offline-
 * storage.ts`): `testIsolation` clears cookies, `localStorage` and
 * `sessionStorage` and there is no `cy.clearAllIndexedDb()`, so
 * `OfflineDbService`'s database — the saved in-progress game, the offline
 * question pool, the daily-allowance counter — survived from one test into the
 * next and had to be deleted by hand from a `beforeEach` timed against the
 * app's own open connection, which blocks `deleteDatabase()` for the life of
 * the tab. Playwright gives every test a fresh `BrowserContext`, which is a
 * fresh IndexedDB, so the isolation is a property of the runner and there is no
 * hook to place and no connection to race. `test-isolation.spec.ts` is where
 * that claim is checked rather than assumed.
 */

/** The app's database, as `OfflineDbService` names it. */
const DB_NAME = 'trivia-offline';
const GAME_STATE_STORE = 'game-state';
const CURRENT_GAME_KEY = 'current';

/**
 * The persisted in-progress game, or `null` when there is none.
 *
 * Opened **without a version** on purpose: naming one risks triggering an
 * upgrade from the test, and this only ever reads. A database that does not
 * exist yet is created empty by `open`, which is why the store's existence is
 * checked before the transaction rather than assumed.
 */
export function readSavedGame(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(
    ({ dbName, store, key }) =>
      new Promise<Record<string, unknown> | null>((resolve, reject) => {
        const open = window.indexedDB.open(dbName);
        open.onerror = () => reject(open.error as Error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            resolve(null);
            return;
          }
          const request = db.transaction(store, 'readonly').objectStore(store).get(key);
          request.onsuccess = () => {
            db.close();
            resolve((request.result as Record<string, unknown>) ?? null);
          };
          request.onerror = () => {
            db.close();
            reject(request.error as Error);
          };
        };
      }),
    { dbName: DB_NAME, store: GAME_STATE_STORE, key: CURRENT_GAME_KEY },
  );
}
