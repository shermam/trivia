// Temporary diagnostic, not part of the permanent suite — see the PR
// discussion. Confirmed so far: fetch('/__/firebase/init.json') IS called
// (window.fetch patch caught it), but Cypress's own network-intercept layer
// never sees a matching request — meaning the fetch itself is failing or
// hanging before it ever reaches the wire. This calls it directly from the
// page context and reports the actual resolve/reject outcome (or a genuine
// hang, via Cypress's own command timeout) via a forced test failure — the
// one channel proven to reliably show up in the CI log.
describe('preview network diagnostic', () => {
  it('directly fetches /__/firebase/init.json and reports the outcome', () => {
    cy.visit('/');
    cy.window().then((win) => {
      const startedAt = Date.now();
      return win.fetch('/__/firebase/init.json').then(
        (res) => {
          throw new Error(`RESOLVED after ${Date.now() - startedAt}ms: status=${res.status}`);
        },
        (err: unknown) => {
          throw new Error(`REJECTED after ${Date.now() - startedAt}ms: ${String(err)}`);
        },
      );
    });
  });
});
