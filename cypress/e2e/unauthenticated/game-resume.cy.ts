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
 * the route guard: the bounded wait in `restoreSavedGame()` was expiring, and
 * its expiry was indistinguishable from "there is no saved game", so the guard
 * redirected while the game sat intact in IndexedDB. The guards now await the
 * restore rather than racing it.
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

    /*
     * Captures the post-fix state before the real assertion, because the
     * previous rounds showed how easily this fails ambiguously. Both are
     * unconditional and retrying — a `cy.location` branch is useless here,
     * since right after a reload the URL is still /play whatever happens next.
     *
     *   banner present → restored, but the guard let the redirect happen anyway
     *   banner absent  → still nothing restored, so `load()` is returning null
     *                    and the bounded wait was not the whole story
     */
    cy.get('body').then(($body) => {
      const banner = $body.text().includes('You have a game in progress');
      cy.log(`B11 post-fix: resume banner ${banner ? 'PRESENT' : 'ABSENT'}`);
    });
    cy.location('pathname').should('be.oneOf', ['/play', '/']);

    // Anchored on the quiz itself, not on the URL: after a reload the URL is
    // already /play, so a pathname assertion passes before Angular boots and
    // keeps passing if the guard then redirects to /.
    cy.get('[data-cy="question-text"]').should('be.visible');
    cy.contains('Question 1 / 5');
  });
});
