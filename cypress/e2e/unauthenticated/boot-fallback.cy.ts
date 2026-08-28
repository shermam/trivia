/**
 * The recovery notice that lives inside `<app-root>` in `src/index.html`.
 *
 * It exists for the one failure where no application code runs: a stale
 * service worker serves a cached `index.html` naming a hashed entry script
 * that is neither in its cache nor on the origin any more. The page is blank,
 * and nothing in `src/app/` can react to that, because the bundle that would
 * have reacted is the one that did not arrive. `SwUpdate.unrecoverable` cannot
 * help either — `firebase.json` rewrites every unmatched path to
 * `/index.html`, so a stale asset returns `200` and the worker only raises
 * that event on a `404`.
 *
 * So the notice is markup that is already on the page, revealed by a CSS
 * delay. Both halves of that need holding down, and they pull in opposite
 * directions: it has to appear when the bundle never arrives, and it has to be
 * invisible on every load where it does.
 *
 * A `404` rather than a wedged worker because the worker is not the point —
 * the fallback answers "no entry script" whatever the cause, and the dev
 * server this suite runs against emits no worker at all (`cypress.config.ts`).
 */
describe('pre-boot recovery notice', () => {
  /** Matches the dev server's unhashed `main.js` and a production `main-HASH.js` alike. */
  const ENTRY_SCRIPT = '**/main*.js';

  it('is gone from the page once the app boots', () => {
    cy.visit('/');

    // A positive anchor first: `should('not.exist')` is satisfied by a page
    // that has not rendered yet, which would pass against the very regression
    // this guards (`ci-cd.md` §4.3).
    cy.contains('Configure your quiz').should('be.visible');

    // Angular replaces the contents of `<app-root>` on bootstrap, which is
    // what makes the notice free on the happy path — it is not hidden, it is
    // no longer in the document.
    cy.get('.boot-fallback').should('not.exist');
  });

  it('appears when the entry script never arrives', () => {
    cy.intercept('GET', ENTRY_SCRIPT, { statusCode: 404, body: '' }).as('entryScript');
    cy.visit('/');
    cy.wait('@entryScript');

    cy.get('.boot-fallback').should('exist');

    // The delay is the whole reason this is safe to ship: without it the
    // notice would flash on every slow-but-fine load. Asserted on the computed
    // style rather than by watching a clock, so the check says "it cannot
    // appear immediately" without depending on how fast this runner is.
    cy.get('.boot-fallback').should(($el) => {
      const delay = Number.parseFloat(getComputedStyle($el[0]).animationDelay);
      expect(delay, 'reveal delay in seconds').to.be.at.least(5);
    });

    // `be.visible` retries up to `defaultCommandTimeout` (20s), comfortably
    // past the reveal delay.
    cy.get('.boot-fallback').should('be.visible');
    cy.get('.boot-fallback').should(($el) => {
      expect($el.text()).to.contain('could not finish loading');
    });

    // Reloading is the recovery, so the notice has to offer one that works.
    cy.get('.boot-fallback__action').should('have.attr', 'href');
  });

  it('recovers when the entry script is available again', () => {
    // One interception, consumed by the first load only — `times: 1` is what
    // makes the reload serve the real script, so this test covers the
    // transition rather than just the broken state.
    cy.intercept('GET', ENTRY_SCRIPT, { statusCode: 404, body: '', times: 1 }).as('entryScript');
    cy.visit('/');
    cy.wait('@entryScript');
    cy.get('.boot-fallback').should('be.visible');

    cy.get('.boot-fallback__action').click();

    cy.contains('Configure your quiz').should('be.visible');
    cy.get('.boot-fallback').should('not.exist');
  });
});
