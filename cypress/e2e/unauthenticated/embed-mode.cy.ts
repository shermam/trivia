describe('embed mode', () => {
  it('shows the top bar by default', () => {
    cy.visit('/');
    cy.get('header').should('exist');
  });

  it('hides the top bar when ?embed=1 is present', () => {
    cy.visit('/?embed=1');
    cy.get('header').should('not.exist');
    // The game itself must stay fully usable with no top bar.
    cy.contains('Trivimind');
    cy.contains('button', 'Start Game').should('exist');
  });
});
