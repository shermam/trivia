/**
 * Finding B8's resume path, in a browser — which, until finding B11, nothing
 * covered. The unit suites verify that `GamePersistenceService` round-trips a
 * game and that `GameControllerService` reads it back, but neither can show
 * that a real page load restores one, and that is the entire promise B8 makes:
 * a refresh, a tab crash or a PWA relaunch does not cost you the game.
 *
 * The three assertions are deliberately staged so a failure says *where* the
 * game was lost rather than just that it was:
 *
 *   1. persisted before the reload  → the write landed at all
 *   2. still persisted after it     → the record survived the page load
 *   3. quiz rendered                → bootstrap actually restored it
 *
 * Each rules out a different cause: an unflushed write, storage cleared by the
 * reload, or a restore that ran too late for the route guard.
 */

const DB_NAME = 'trivia-offline';
const STORE = 'game-state';
const KEY = 'current';

/**
 * Reads the persisted game straight out of IndexedDB in the app's own window.
 *
 * Opened without a version on purpose: naming one risks triggering an upgrade
 * from the test, and this only ever reads. A database that does not exist yet
 * is created empty by `open`, which is why the store is checked before the
 * transaction rather than assumed.
 */
function readSavedGame(win: Window): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const open = win.indexedDB.open(DB_NAME);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.close();
        resolve(null);
        return;
      }
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      request.onsuccess = () => {
        db.close();
        resolve((request.result as Record<string, unknown>) ?? null);
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    };
  });
}

describe('resuming a game after a reload (B8)', () => {
  it('restores the in-progress game when the page is reloaded', () => {
    cy.startGame(5);

    // The persisting effect queues an async write with no observable "landed"
    // signal, so reloading immediately would be racing it rather than testing
    // the feature. Asserting the record exists is what makes the wait honest.
    cy.window()
      .then((win) => readSavedGame(win))
      .should((saved) => {
        expect(saved, 'a game is persisted before the reload').to.not.equal(null);
      });

    cy.reload();

    cy.window()
      .then((win) => readSavedGame(win))
      .should((saved) => {
        expect(saved, 'the persisted game survives the page load').to.not.equal(null);
      });

    // Anchored on the quiz itself, not on the URL: after a reload the URL is
    // already /play, so a pathname assertion passes before Angular boots and
    // keeps passing if the guard then redirects to /.
    cy.get('[data-cy="question-text"]').should('be.visible');
    cy.contains('Question 1 / 5');
  });
});
