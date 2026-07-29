describe('authenticated profile management', () => {
  // Computed fresh in `beforeEach` (not once at describe-scope) — see the
  // identical comment in sign-in-save-score.cy.ts: this file's two `it`s
  // share this hook, and there's no reset between them against the real
  // preview backend.
  let email: string;
  const password = 'correct horse battery staple';

  beforeEach(() => {
    email = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
