/**
 * `FEAT-014`. Five free games a day, counted on this device.
 *
 * The counter is not a security boundary — `FEAT-014` §0 says so, and these
 * tests do not pretend otherwise. What they hold down is that it counts, that
 * it stops the sixth game, that Pro is unaffected, and that **the row it
 * renders does not move the page**, which is the failure `CLAUDE.md` §4.4
 * exists for and the one nothing else here would catch.
 */

/** Writes the counter straight into IndexedDB, so a test does not have to play five games. */
function seedGamesPlayed(count: number): void {
  cy.window().then(
    (win) =>
      new Promise<void>((resolve, reject) => {
        const open = win.indexedDB.open('trivia-offline');
        open.onsuccess = () => {
          const db = open.result;
          const now = new Date();
          const date = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}-${`${now.getDate()}`.padStart(2, '0')}`;
          const tx = db.transaction('daily-limit', 'readwrite');
          tx.objectStore('daily-limit').put({ id: 'today', date, count });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error as Error);
          };
        };
        open.onerror = () => reject(open.error as Error);
      }),
  );
}

describe('daily free game limit', () => {
  beforeEach(() => {
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.wait('@categories');
  });

  it('shows the allowance before the first game', () => {
    cy.get('[data-cy=daily-allowance]').should('contain.text', '5 of 5 free games left today');
  });

  it('counts a played game against the allowance', () => {
    cy.get('#amount').select('5');
    cy.get('[data-cy="time-limit-unlimited"]').click({ force: true }).should('be.checked');
    cy.contains('button', 'Start Game').click();
    cy.wait('@questions');
    cy.location('pathname').should('eq', '/play');

    // Back to the setup screen without playing it out — the game was served,
    // which is the moment the allowance is spent.
    cy.visit('/');
    cy.wait('@categories');
    cy.get('[data-cy=daily-allowance]').should('contain.text', '4 of 5 free games left today');
  });

  it('offers Pro instead of a sixth game', () => {
    seedGamesPlayed(5);
    cy.visit('/');
    cy.wait('@categories');

    cy.get('[data-cy=daily-allowance]').should('contain.text', 'No free games left today');
    cy.get('[data-cy=daily-limit-reached]').should('be.visible');
    cy.contains('button', 'Start Game').should('not.exist');

    cy.get('[data-cy=daily-limit-upgrade]').click();
    cy.location('pathname').should('eq', '/pricing');
  });

  it('starts again the next day', () => {
    // A record from another day is not today's count, so it reads as unspent.
    cy.window().then(
      (win) =>
        new Promise<void>((resolve, reject) => {
          const open = win.indexedDB.open('trivia-offline');
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('daily-limit', 'readwrite');
            tx.objectStore('daily-limit').put({ id: 'today', date: '2020-01-01', count: 5 });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error as Error);
            };
          };
          open.onerror = () => reject(open.error as Error);
        }),
    );
    cy.visit('/');
    cy.wait('@categories');

    cy.get('[data-cy=daily-allowance]').should('contain.text', '5 of 5 free games left today');
    cy.contains('button', 'Start Game').should('be.visible');
  });

  /**
   * `CLAUDE.md` §4.4. The allowance row renders for everyone from first paint
   * precisely so it cannot push the Start button down the screen when the count
   * resolves — a shift at the exact moment the reader is looking at the control
   * they are reaching for.
   *
   * Measured on the button's own position rather than on the row's presence,
   * because the row existing is not the property that matters; the page not
   * moving is. At a viewport tall enough to leave the card some slack, per the
   * §4.4 note that the same class of shift measures 0px at one height and 43px
   * at another.
   */
  it('does not move the Start button when the allowance resolves', () => {
    cy.viewport(390, 1000);
    cy.visit('/');

    // Before the count has been read back from IndexedDB.
    cy.contains('button', 'Start Game')
      .then(($el) => $el[0].getBoundingClientRect().top)
      .as('startTop');

    cy.get('[data-cy=daily-allowance]').should('contain.text', 'free games left today');

    cy.get('@startTop').then((before) => {
      cy.contains('button', 'Start Game').then(($el) => {
        expect($el[0].getBoundingClientRect().top, 'Start button top').to.be.closeTo(
          before as unknown as number,
          1,
        );
      });
    });
  });
});
