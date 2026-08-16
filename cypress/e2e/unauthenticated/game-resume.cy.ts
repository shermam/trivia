/**
 * Finding B8's resume path, in a browser — which, until finding B11, nothing
 * covered. The unit suites verify that `GamePersistenceService` round-trips a
 * game and that `GameControllerService` reads it back, but neither can show
 * that a real page load restores one, and that is the entire promise B8 makes:
 * a refresh, a tab crash or a PWA relaunch does not cost you the game.
 *
 * This spec is what found **B11**, and the staging is why it could: a failure
 * says *where* the game was lost rather than only that it was.
 *
 *   1. persisted before the reload  → the write landed at all
 *   2. still persisted after it     → the record survived the page load
 *   3. quiz rendered                → bootstrap actually restored it
 *
 * (1) and (2) passed and (3) failed, which located the bug between storage and
 * the signals: the record was there and the app would not take it. It was
 * being *rejected* on read — `GameConfig.amount` is declared `number`, the
 * setup form's `<select>` was writing the string `"5"` into it, and
 * `parseSavedGame` type-checks that field. The reader was right; the writer
 * was wrong. See `game-setup.component.spec.ts`.
 *
 * **`cy.startGame(5)` is load-bearing, not incidental.** It picks a question
 * count through the real `<select>`, which is what produced the bad value; the
 * form's *default* stayed a genuine number, so a version of this test that
 * never touched that control would have passed against the bug. Whatever else
 * changes here, keep something that chooses a non-default amount.
 *
 * Kept staged rather than collapsed into one assertion, because the next
 * regression here will not necessarily be the same one.
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
    // The count as well as the screen. It is the field that was corrupted, so
    // a restore that came back with the wrong one would still be a failure.
    cy.contains('Question 1 / 5');
  });
});
