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
    // G6: the display name is data about the user, so it declares its purpose.
    cy.get('#displayName').should('have.attr', 'autocomplete', 'nickname');
    cy.get('#displayName').clear().type('Ada Lovelace');
    cy.contains('button', 'Save').click();

    cy.get('header').contains('Ada Lovelace');
  });

  it('signs out back to an anonymous session without flashing the verify-email prompt', () => {
    cy.openAuthMenu();

    // Sign-out briefly transitions through a signed-out `null` user before
    // re-anonymizing; a MutationObserver over the whole render (rather than
    // a point-in-time assertion) is what actually catches a flash that a
    // synchronous `cy.contains` check would step right over.
    cy.window().then((win) => {
      const state = { sawVerifyEmailFlash: false };
      const observer = new MutationObserver(() => {
        if (win.document.body.innerText.includes('Verify your email')) {
          state.sawVerifyEmailFlash = true;
        }
      });
      observer.observe(win.document.body, { childList: true, subtree: true, characterData: true });
      (win as unknown as { __signOutObserverState: typeof state }).__signOutObserverState = state;
    });

    cy.contains('button', 'Sign out').click();

    cy.get('header').contains('button', 'Sign in');

    cy.window().then((win) => {
      const { sawVerifyEmailFlash } = (
        win as unknown as { __signOutObserverState: { sawVerifyEmailFlash: boolean } }
      ).__signOutObserverState;
      expect(sawVerifyEmailFlash, 'the verify-email prompt should never flash during sign-out').to
        .be.false;
    });
  });
});
