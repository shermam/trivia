// Temporary diagnostic, not part of the permanent suite — see the PR
// discussion. The intercept-based check below reported "no request ever
// occurred" for both /__/firebase/init.json and identitytoolkit — this
// patches window.fetch itself (before any app code runs) to see whether
// fetch() is even being *called*, independent of Cypress's own network
// proxy layer. Reports via a forced test failure, since that's the one
// channel we've proven reliably surfaces in the CI log (unlike an earlier,
// silently-broken attempt at console/task-based logging).
describe('preview network diagnostic', () => {
  it('records every fetch() call the app makes in the first 6s', () => {
    cy.on('window:before:load', (win) => {
      const calls: string[] = [];
      (win as unknown as { __fetchLog: string[] }).__fetchLog = calls;
      const originalFetch = win.fetch.bind(win);
      win.fetch = ((...args: Parameters<typeof fetch>) => {
        calls.push(String(args[0]));
        return originalFetch(...args);
      }) as typeof fetch;
    });

    cy.visit('/');
    cy.wait(6000);
    cy.window()
      .its('__fetchLog')
      .then((calls: string[]) => {
        throw new Error(`fetch() calls observed: ${JSON.stringify(calls)}`);
      });
  });

  it('reaches identitytoolkit.googleapis.com and gets a response', () => {
    cy.intercept('POST', '**/identitytoolkit.googleapis.com/**').as('authCall');
    cy.visit('/');
    cy.wait('@authCall', { timeout: 15000 }).its('response.statusCode').should('eq', 200);
  });

  it('reaches /__/firebase/init.json and gets a response', () => {
    cy.intercept('GET', '**/__/firebase/init.json').as('configCall');
    cy.visit('/');
    cy.wait('@configCall', { timeout: 15000 }).its('response.statusCode').should('eq', 200);
  });
});
