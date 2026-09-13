import { Page } from '@playwright/test';

/**
 * Reading the app's own IndexedDB from a test.
 *
 * **There is nothing here that clears it, and that is the point.** The runner
 * this suite replaced needed a whole module for the clearing half: its own
 * isolation cleared cookies, `localStorage` and `sessionStorage` but had no
 * command for IndexedDB at all, so
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

/** `OfflineQuestionsService`'s pool, and the key it dedupes on. */
const QUESTIONS_STORE = 'questions';

/**
 * Puts questions straight into the offline pool, so a spec can play a round
 * with the network gone without waiting on the background prefetch.
 *
 * **Seeded rather than prefetched, deliberately.** The pool is normally filled
 * from Open Trivia DB on an idle callback, which would make the test depend on
 * a third-party service, on how long idle takes to arrive, and on how many
 * questions came back. None of that is what the test is about.
 *
 * Opened **without a version**, like `readSavedGame` above and for the same
 * reason: the app has already created the database by the time this runs, and
 * naming a version from a test risks triggering an upgrade the app is not
 * expecting. The records match what `OfflineQuestionsService.saveQuestions`
 * writes, `dedupeKey` and `cachedAt` included — a row missing either is a row
 * the store cannot key or the trim cannot sort.
 */
export function seedOfflineQuestions(page: Page, count: number): Promise<void> {
  return page.evaluate(
    ({ dbName, store, total }) =>
      new Promise<void>((resolve, reject) => {
        const open = window.indexedDB.open(dbName);
        open.onerror = () => reject(open.error as Error);
        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction(store, 'readwrite');
          const questions = transaction.objectStore(store);
          for (let i = 1; i <= total; i++) {
            const text = `Offline question ${i}?`;
            questions.put({
              id: `offline-${i}`,
              category: 'General Knowledge',
              type: 'multiple',
              difficulty: 'easy',
              question: text,
              correct_answer: 'Right',
              incorrect_answers: [`Wrong ${i}a`, `Wrong ${i}b`, `Wrong ${i}c`],
              // The correct option carries the same label on every seeded
              // question, so a caller can answer a whole round with one
              // locator without knowing the order the pool is shuffled into.
              // The ids stay per-question, which is what identity is (§4.4);
              // only the display text repeats.
              all_answers: [
                { id: `${i}-0`, text: 'Right', isCorrect: true },
                { id: `${i}-1`, text: `Wrong ${i}a`, isCorrect: false },
                { id: `${i}-2`, text: `Wrong ${i}b`, isCorrect: false },
                { id: `${i}-3`, text: `Wrong ${i}c`, isCorrect: false },
              ],
              source: 'open_trivia',
              cachedAt: Date.now(),
              dedupeKey: `open_trivia:${text}`,
            });
          }
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error as Error);
          };
        };
      }),
    { dbName: DB_NAME, store: QUESTIONS_STORE, total: count },
  );
}
