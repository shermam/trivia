describe('email sign-up and verification', () => {
  const email = `signup-${Date.now()}@example.com`;
  const password = 'correct horse battery staple';

  it('requires verifying the email before treating the account as fully authenticated', () => {
    cy.visit('/');
    cy.signUpViaUi(email, password);

    // Signed in (uid upgraded from anonymous), but not yet verified.
    cy.contains("Account created! We've sent a verification link to your email.");
    cy.contains('Verify your email');
    cy.contains('button', 'Resend verification email');

    cy.getVerificationLink(email).then((link) => {
      cy.request(link);
    });

    // Sign out and back in to pick up the now-verified account from the server.
    cy.get('app-auth-menu').contains('button', 'Sign out').click();
    cy.signInViaUi(email, password);

    cy.get('header').contains('button', 'Sign in').should('not.exist');
    cy.openAuthMenu();
    cy.contains('Your profile');
    cy.contains('Verified');
  });

  it('rejects email-alias sign-ups client-side', () => {
    cy.visit('/');
    cy.openAuthMenu();
    cy.get('app-auth-menu input[name=email]').type('someone+tag@example.com');
    cy.get('app-auth-menu input[name=password]').type(password);
    cy.get('app-auth-menu form button[type=submit]').click();

    cy.contains(/email aliases.*aren't allowed/i);
  });
});
