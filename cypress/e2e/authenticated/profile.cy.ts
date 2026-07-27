describe('authenticated profile management', () => {
  const email = `profile-${Date.now()}@example.com`;
  const password = 'correct horse battery staple';

  beforeEach(() => {
    cy.createVerifiedUser({ email, password });
    cy.visit('/');
    cy.signInViaUi(email, password);
  });

  it('updates the display name and reflects it in the top bar', () => {
    cy.openAuthMenu();
    cy.contains('Your profile');
    cy.get('#displayName').clear().type('Ada Lovelace');
    cy.contains('button', 'Save').click();

    cy.get('header').contains('Ada Lovelace');
  });

  it('signs out back to an anonymous session', () => {
    cy.openAuthMenu();
    cy.contains('button', 'Sign out').click();

    cy.get('header').contains('button', 'Sign in');
  });
});
