describe('pricing / Stripe checkout', () => {
  const password = 'correct horse battery staple';
  let email: string;

  beforeEach(() => {
    email = `pricing-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    cy.seedProProduct();
  });

  it('prompts an anonymous visitor to sign in instead of starting checkout', () => {
    cy.visit('/pricing');
    cy.contains('button', 'Sign in to subscribe').click();

    cy.get('app-auth-menu').should('be.visible');
  });

  it('creates a real checkout session via the emulated Cloud Function and redirects to Stripe', () => {
    cy.createVerifiedUser({ email, password });
    cy.visit('/');
    cy.signInViaUi(email, password);
    cy.visit('/pricing');

    // `createCheckoutSession` (functions/src/checkout-sessions.ts) runs for
    // real here, against the Functions emulator — it's only the Stripe API
    // call inside it that's mocked (STRIPE_MOCK_CHECKOUT, see
    // .env.demo-trivia-app-e2e), so this exercises the full write → trigger
    // → write-back → listener → `window.location.assign` round trip for
    // real, all the way through. Nothing is stubbed: Location.assign/href
    // are non-configurable/read-only in real Chromium/Electron, so rather
    // than fight that, the mock URL itself (see checkout-sessions.ts) is a
    // same-origin, hash-only target — a harmless in-page navigation.
    //
    // `cy.contains('button', 'Subscribe')` also doubles as a wait for
    // PricingComponent's own `authReady()` gate (the button reads
    // "Loading…" until then) — without it, a click landing in that brief
    // window would misfire the "verify your email" branch, since
    // `isAnonymous`/`isFullyAuthenticated` both default to `false` before
    // the first auth state resolves.
    cy.contains('button', 'Subscribe').click();

    cy.location('hash').should('match', /^#mock-checkout-session-/);
  });

  it('shows the Pro badge once subscribed and hides the Subscribe button', () => {
    cy.createVerifiedUser({ email, password }).then(({ uid }) => {
      cy.visit('/');
      cy.signInViaUi(email, password);
      cy.setProSubscription({ uid });
    });

    cy.visit('/pricing');
    cy.contains("You're subscribed");
    cy.contains('button', 'Subscribe').should('not.exist');
  });
});
