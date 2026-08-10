import { assertRadiosAreGrouped } from '../../support/a11y-assertions';

describe('add-question Pro gating', () => {
  const password = 'correct horse battery staple';
  let email: string;

  beforeEach(() => {
    email = `pro-gating-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  });

  it('shows a free account a friendly upgrade prompt instead of the form', () => {
    cy.createVerifiedUser({ email, password });
    cy.visit('/');
    cy.signInViaUi(email, password);
    cy.visit('/add-question');

    cy.contains("This one's for Pro members");
    cy.contains('button', 'Upgrade to Pro').click();
    cy.location('pathname').should('eq', '/pricing');
  });

  it('lets a Pro account submit a question once subscribed', () => {
    cy.createVerifiedUser({ email, password }).then(({ uid }) => {
      cy.visit('/');
      cy.signInViaUi(email, password);
      // Simulates what our Stripe webhook handler does after a real
      // checkout — no page reload here on purpose: this exercises the app's own
      // real-time subscription listener + token refresh (SubscriptionService
      // / AuthService.refreshIdToken), the same path a real subscriber hits
      // right after returning from Stripe Checkout.
      cy.setProSubscription({ uid });
    });

    cy.contains('a', '+ Create custom question').click();
    cy.location('pathname').should('eq', '/add-question');

    // This screen carries the other two segmented pickers (Question Type and,
    // once a boolean question is chosen, Correct Answer), and it is only
    // reachable as Pro — so G4's sweep runs here rather than in the
    // unauthenticated spec.
    assertRadiosAreGrouped();

    // Retries until the reactive Pro-gated form actually renders — i.e.
    // until the real-time subscription listener + token refresh have
    // landed, not just until the doc write resolved.
    cy.get('#category').type('Science');
    cy.get('#question').type('What planet is known as the Red Planet?');
    cy.get('#correctAnswer').type('Mars');
    cy.get('input[placeholder="Incorrect answer 1"]').type('Venus');
    cy.get('input[placeholder="Incorrect answer 2"]').type('Jupiter');
    cy.get('input[placeholder="Incorrect answer 3"]').type('Saturn');
    cy.contains('button', 'Add Question').click();

    cy.contains('Thanks! Your question was added to the bank.');
  });
});
