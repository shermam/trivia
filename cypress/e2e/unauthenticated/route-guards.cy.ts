describe('route guards', () => {
  it('redirects /play to / when there is no active question in memory', () => {
    cy.visit('/play');
    cy.location('pathname').should('eq', '/');
  });

  it('redirects /game-over to / when there is no completed game in memory', () => {
    cy.visit('/game-over');
    cy.location('pathname').should('eq', '/');
  });

  it('redirects unknown routes to /', () => {
    cy.visit('/this-route-does-not-exist');
    cy.location('pathname').should('eq', '/');
  });
});
