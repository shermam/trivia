// Temporary diagnostic, not part of the permanent suite — see the PR
// discussion. Isolates whether the browser (Cypress's Electron, headless,
// in CI) ever actually issues the anonymous-sign-in network call and gets a
// response, independent of any application code/UI assertions.
describe('preview network diagnostic', () => {
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
