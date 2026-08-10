/**
 * Finding H1. An email/password user who forgot their password was locked out
 * permanently — of a paid subscription, if they had one — because the sign-in
 * form offered no reset at all.
 *
 * The second test is as important as the first: the confirmation message must
 * be *identical* whether or not the address has an account. A reset form that
 * answers differently for known and unknown addresses is an
 * account-enumeration oracle. The emulator task checks what actually reached
 * Auth, so the two tests together pin "same words outside, different actions
 * inside".
 */
const NEUTRAL_CONFIRMATION = 'If an account exists for that email';

function requestReset(email: string) {
  cy.get('[data-cy="auth-menu-trigger"]').click();
  cy.contains('button', 'Already have an account? Sign in').click();
  cy.get('input[name=email]').type(email);
  cy.contains('button', 'Forgot password?').click();
}

describe('password reset (H1)', () => {
  beforeEach(() => {
    cy.stubOpenTrivia();
    cy.visit('/');
  });

  it('sends a reset for an existing account, saying so neutrally', () => {
    const email = `reset-${Date.now()}@example.com`;
    cy.createVerifiedUser({ email, password: 'correct horse battery staple' });

    requestReset(email);

    cy.contains(NEUTRAL_CONFIRMATION);
    cy.task('hasPendingPasswordReset', email).should('eq', true);
  });

  it('says exactly the same thing for an unknown address, and sends nothing', () => {
    const email = `nobody-${Date.now()}@example.com`;

    requestReset(email);

    cy.contains(NEUTRAL_CONFIRMATION);
    cy.task('hasPendingPasswordReset', email).should('eq', false);
  });
});
