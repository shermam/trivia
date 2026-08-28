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
 *
 * **Emulator-only, and `cypress.preview.config.ts` excludes it.** Against a
 * deployed channel `firebase.json` serves `**\/*.@(js|css)` as
 * `max-age=31536000, immutable`, so by the time this spec runs the browser
 * already holds the entry script from an earlier spec and satisfies the
 * request from its own cache. No request reaches the network, `cy.intercept`
 * never matches, and `cy.wait` fails with "No request ever occurred" — which
 * is what happened on the first CI run of this file.
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
    cy.get('[data-cy=boot-fallback]').should('not.exist');
  });

  it('appears when the entry script never arrives', () => {
    cy.intercept('GET', ENTRY_SCRIPT, { statusCode: 404, body: '' }).as('entryScript');
    cy.visit('/');
    cy.wait('@entryScript');

    // The delay is the whole reason this is safe to ship: without it the
    // notice would flash on every slow-but-fine load. Asserted on the computed
    // style rather than by watching a clock, so the check says "it cannot
    // appear immediately" without depending on how fast this runner is.
    cy.get('[data-cy=boot-fallback]').should(($el) => {
      const delay = Number.parseFloat(getComputedStyle($el[0]).animationDelay);
      expect(delay, 'reveal delay in seconds').to.be.at.least(5);
    });

    // `be.visible` retries up to `defaultCommandTimeout` (20s), comfortably
    // past the reveal delay.
    cy.get('[data-cy=boot-fallback]')
      .should('be.visible')
      .and('contain.text', 'could not finish loading');
  });

  /**
   * The recovery affordance, in two halves.
   *
   * **It deliberately does not click the link**, and that is worth explaining
   * rather than leaving as an omission. Clicking it navigates to the URL the
   * page is already on, and Cypress does not survive that: driven by hand in
   * Chromium — against both a production build and this same `ng serve` — the
   * click navigates and the app boots normally, but under `cypress run` the
   * AUT ends up showing neither the app nor the notice, and the assertion
   * after it fails. Two full-suite runs and one targeted run reproduced it
   * identically, including across the `position: absolute` change, so it is
   * not the element.
   *
   * Rather than defend a test against the runner's own navigation handling,
   * the two facts that matter are asserted directly: the link points at the
   * app root, and the app really does come back once the script is served.
   * What is given up is proof that a *click* triggers the navigation, which is
   * browser behaviour for an `<a href>` rather than behaviour of this app.
   */
  it('offers a link to the app root, and the app comes back once the script does', () => {
    // `times: 1` so the reload below is served the real script.
    cy.intercept('GET', ENTRY_SCRIPT, { statusCode: 404, body: '', times: 1 }).as('entryScript');
    cy.visit('/');
    cy.wait('@entryScript');
    cy.get('[data-cy=boot-fallback]').should('be.visible');

    cy.get('[data-cy=boot-fallback-reload]').should(($a) => {
      const href = ($a[0] as HTMLAnchorElement).href;
      expect(href, 'resolved href').to.eq(`${window.location.origin}/`);
    });

    cy.reload();

    cy.contains('Configure your quiz').should('be.visible');
    cy.get('[data-cy=boot-fallback]').should('not.exist');
  });
});
