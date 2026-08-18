/**
 * Clears the app's IndexedDB database between tests.
 *
 * Cypress's `testIsolation` clears cookies, `localStorage` and
 * `sessionStorage` between tests. **It has no IndexedDB equivalent** — there
 * is no `cy.clearAllIndexedDb()` — and `cy.resetBackend()` resets the Firebase
 * emulators, which is a different machine entirely. So everything
 * `OfflineDbService` owns (`src/app/services/offline-db.service.ts`) survives
 * from one test into the next: the saved in-progress game in `game-state`, and
 * the offline question pool in `questions`.
 *
 * **The leak is real, and it is visible.** Measured before writing this: a
 * test that starts a game leaves its record in `game-state`, and the *next*
 * test's setup screen renders the resume banner for a game that test never
 * started. Nothing in the suite has failed because of it yet — which is
 * exactly the state in which to fix it, because the failure it eventually
 * produces is order-dependent and would be blamed on anything but the real
 * cause.
 *
 * **What actually leaks today is `game-state` only.** `questions` is written
 * solely by `TriviaService.refillOfflinePool()`, reachable only through
 * `initOfflinePrefetch()`, which returns early under `navigator.webdriver` —
 * true for every Cypress run, in the emulator suite and the preview suite
 * alike. The pool measured empty after a full game. The whole database is
 * deleted anyway rather than just the one store: it costs nothing, and the day
 * that gate moves or a third store appears, this keeps working instead of
 * quietly covering less than it claims to.
 *
 * ## Why this runs from `beforeEach`, before the first `cy.visit()`
 *
 * `indexedDB.deleteDatabase()` **blocks** for as long as any connection to the
 * database is open, and the app holds one for the lifetime of the tab through
 * `OfflineDbService`. So *when* the deletion runs is the whole design, and the
 * three plausible places are not equivalent. All three were run and observed
 * rather than reasoned about:
 *
 * - **`beforeEach`, before any `cy.visit()`** — what this file does. Under
 *   `testIsolation` the previous test's AUT window is already gone, so no
 *   connection is open and the deletion completes immediately. Two things had
 *   to be checked rather than assumed, and both hold: `cy.window()` *does*
 *   resolve before the first visit (it yields the `about:blank` AUT window),
 *   and that window shares its storage with the app's, despite serializing its
 *   origin as `"null"` — verified by writing a sentinel database from the
 *   pre-visit window and reading it back from the app's. Had that not held,
 *   this hook would have deleted a database nobody uses and looked perfectly
 *   healthy doing it.
 * - **`Cypress.on('window:before:load')` — rejected, and not merely as a
 *   race.** It fires on *every* page load inside a test, `cy.reload()`
 *   included, and the deletion resolves in 16–45 ms, comfortably ahead of the
 *   app's restore. So it reliably destroys the saved game *in the middle of*
 *   the tests that exist to prove the game survives a reload: run against
 *   `game-resume.cy.ts`, the quiz does not come back and the player is bounced
 *   to the setup screen. A hook that deletes the thing under test is not a
 *   subtle timing hazard, it is the wrong hook.
 * - **`afterEach`, fire-and-forget — rejected as actively misleading.** The
 *   app's own connection is still open at that point, so the deletion
 *   `onblocked`s and simply never completes: measured still blocked after a
 *   full 5 s, on every test. It then lands at some uncontrolled later moment
 *   when the window is torn down — and the next test came out *clean*, which
 *   is the trap. It looks like it works while the deletion is happening at a
 *   time nobody chose, free to land after the following test has started
 *   writing. It also costs the stall on every test.
 *
 * `onblocked` is therefore treated as a hard failure rather than something to
 * wait out. If the assumption above ever stops holding — a spec opting out of
 * `testIsolation`, say — the suite should say so loudly at the point of
 * breakage, because the alternative is approach three's behaviour: a deletion
 * still pending, landing on whatever test is running when it finally lands.
 */
const OFFLINE_DB_NAME = 'trivia-offline';

/**
 * Deletes the whole database in `win`'s origin.
 *
 * Takes the window rather than using the spec's own `indexedDB`, because the
 * spec runs in the Cypress runner's frame and the app runs in the AUT frame;
 * only the latter's storage is the one the app reads.
 */
export function deleteOfflineDatabase(win: Window): Promise<void> {
  return new Cypress.Promise<void>((resolve, reject) => {
    const request = win.indexedDB.deleteDatabase(OFFLINE_DB_NAME);

    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error(`Could not delete IndexedDB "${OFFLINE_DB_NAME}"`));
    request.onblocked = () =>
      reject(
        new Error(
          `Deleting IndexedDB "${OFFLINE_DB_NAME}" is blocked by an open connection. ` +
            'This hook runs before the first cy.visit() precisely so that no connection ' +
            'exists yet — if it is blocked, something is holding the database open across ' +
            'tests (a spec opting out of testIsolation would do it). Do not wait it out: a ' +
            'blocked deletion completes later, at a moment no test controls. See ' +
            'cypress/support/offline-storage.ts.',
        ),
      );
  });
}
