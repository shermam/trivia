// Temporary diagnostic, not part of the permanent suite — see the PR
// discussion. Confirmed so far: window.fetch() to /__/firebase/init.json
// and identitytoolkit.googleapis.com hangs forever from inside the browser
// (Electron AND real Chrome — ruling out the browser binary), while
// createVerifiedUser (Admin SDK, running directly in Cypress's own Node
// process) has succeeded reliably every single run. cy.request() also runs
// from Cypress's Node process rather than through the browser and its
// internal proxy (every Cypress-controlled browser is launched with
// --proxy-server pointed at Cypress itself) — if this succeeds while
// window.fetch() still hangs, that pins the problem specifically to
// Cypress's own browser-facing proxy layer, not the network, DNS, or the
// browser.
describe('preview network diagnostic', () => {
  it('cy.request() (Cypress-process HTTP, not through the browser) reaches identitytoolkit', () => {
    cy.request({
      method: 'POST',
      url: 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaSyAMeIj6puWPraoGYRs-svBYnT2rkJdsRdk',
      body: { returnSecureToken: true },
      timeout: 15000,
    }).then((res) => {
      throw new Error(`cy.request RESOLVED: status=${res.status}`);
    });
  });

  it('window.fetch() (through the browser + Cypress proxy) reaches identitytoolkit', () => {
    cy.visit('/');
    cy.window().then((win) => {
      const startedAt = Date.now();
      return win
        .fetch(
          'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaSyAMeIj6puWPraoGYRs-svBYnT2rkJdsRdk',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ returnSecureToken: true }),
          },
        )
        .then(
          (res) => {
            throw new Error(
              `fetch RESOLVED after ${Date.now() - startedAt}ms: status=${res.status}`,
            );
          },
          (err: unknown) => {
            throw new Error(`fetch REJECTED after ${Date.now() - startedAt}ms: ${String(err)}`);
          },
        );
    });
  });
});
