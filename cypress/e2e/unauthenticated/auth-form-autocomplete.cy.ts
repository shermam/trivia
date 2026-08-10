/**
 * Finding G6. The auth form's `autocomplete` attributes turned out to be
 * mostly right already — the finding was phrased "needs confirming", and this
 * spec is that confirmation made permanent: `email` on the email input, and
 * `current-password`/`new-password` switched with the form's mode, which is
 * what lets a password manager offer the stored credential on sign-in but
 * generate a fresh one on sign-up. Without the tokens, WCAG 1.3.5 (Identify
 * Input Purpose) fails silently — Lighthouse and the template lint have no
 * audit for a *missing* autocomplete attribute.
 *
 * What the confirmation actually surfaced was the two *name* fields: the
 * profile display name and the game-over leaderboard name carried no token at
 * all. Both collect data about the user (the HTML `nickname` purpose); they
 * are asserted in profile.cy.ts and sign-in-save-score.cy.ts, since each
 * needs a real signed-in account to render.
 */
describe('auth form autocomplete (G6)', () => {
  beforeEach(() => {
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.get('[data-cy="auth-menu-trigger"]').click();
  });

  // The panel opens in *sign-up* mode ("Create an account"), so that is the
  // baseline each test starts from — asserting sign-in values first was this
  // spec's own first bug, caught by running it.
  it('identifies the email and password fields to a password manager', () => {
    cy.get('input[name=email]').should('have.attr', 'autocomplete', 'email');
    cy.get('input[name=password]').should('have.attr', 'autocomplete', 'new-password');
  });

  it('switches the password purpose when the form switches mode', () => {
    cy.contains('button', 'Already have an account? Sign in').click();
    cy.get('input[name=password]').should('have.attr', 'autocomplete', 'current-password');

    // And back — the toggle is not one-way.
    cy.contains('button', "Don't have an account? Sign up").click();
    cy.get('input[name=password]').should('have.attr', 'autocomplete', 'new-password');
  });
});
