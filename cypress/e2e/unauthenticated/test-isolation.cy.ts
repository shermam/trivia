/**
 * The suite's own test isolation, for the one kind of state Cypress does not
 * clear: IndexedDB.
 *
 * `testIsolation` clears cookies, `localStorage` and `sessionStorage`. There is
 * no `cy.clearAllIndexedDb()`, and `cy.resetBackend()` resets the Firebase
 * emulators — a different machine entirely. So `OfflineDbService`'s database
 * survived from one test into the next, and the saved in-progress game with
 * it. `cypress/support/offline-storage.ts` is the fix and carries the
 * reasoning; this is the test that it works.
 *
 * **These two tests are ordered, and deliberately so.** That is normally the
 * thing to avoid in a suite, which is the point: the first leaves state behind
 * on purpose so the second has something to be clean *of*. A hook that
 * isolates nothing passes every other spec in this suite exactly as it does
 * today — leaked state has never yet been what made one of them fail — so the
 * only way to know the hook works is to hand it a mess and check.
 *
 * Mutation-verified: delete the `cy.clearOfflineStorage()` line from
 * `cypress/support/e2e.ts` and the second test fails on the resume banner,
 * which is the failure a real order-dependent bug would eventually produce
 * somewhere far less obvious.
 */

/** Reads the saved game out of the app's own IndexedDB, without opening at a version. */
function readSavedGame(win: Window): Promise<unknown> {
  return new Cypress.Promise((resolve) => {
    const open = win.indexedDB.open('trivia-offline');
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('game-state')) {
        db.close();
        resolve(null);
        return;
      }
      const request = db
        .transaction('game-state', 'readonly')
        .objectStore('game-state')
        .get('current');
      request.onsuccess = () => {
        db.close();
        resolve(request.result ?? null);
      };
      request.onerror = () => {
        db.close();
        resolve(null);
      };
    };
  });
}

describe('IndexedDB does not leak between tests', () => {
  it('leaves a saved game behind on purpose', () => {
    cy.startGame(5);
    cy.contains('Question 1 / 5');

    // The persisting effect queues an async write with no observable "landed"
    // signal, so asserting the record exists is what makes this test's whole
    // premise honest — otherwise the next test could pass against a game that
    // was never saved in the first place.
    cy.window()
      .then((win) => readSavedGame(win))
      .should((saved) => {
        expect(saved, 'a game is in IndexedDB when this test ends').to.not.equal(null);
      });
  });

  it('starts clean, with no trace of the game the previous test left', () => {
    // Before any `cy.visit()` — the same point the hook runs at, and the state
    // the app would restore from on its next load.
    cy.window({ log: false })
      .then((win) => readSavedGame(win))
      .should((saved) => {
        expect(saved, 'the previous test’s saved game was cleared').to.equal(null);
      });

    cy.stubOpenTrivia();
    cy.visit('/');

    // A positive anchor before the negative assertion: `should('not.exist')` is
    // satisfied by a page that has not rendered yet, and Cypress never retries
    // a satisfied assertion into failure (`docs/ci-cd.md` §4.3).
    cy.get('#amount').should('be.visible');
    cy.get('[data-cy="resume-banner"]').should('not.exist');
  });
});
