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

      // Stripe sends a real subscriber back to
      // `${origin}/pricing?checkout=success` (functions/src/checkout-sessions.ts),
      // so that is the page a new subscription first becomes visible on — and
      // this test goes there rather than staying put.
      //
      // It used to stay put *on purpose*: `SubscriptionService` held an
      // `onSnapshot` listener that saw the webhook's write whenever it landed,
      // wherever the user happened to be. That listener was one of the two
      // things keeping the 559 kB Firestore SDK in the bundle and is gone
      // (`BACKLOG.md` item 2). What replaces it is a read when the signed-in
      // user changes, plus a bounded poll on this exact page.
      cy.visit('/pricing?checkout=success');

      // Seeded *after* landing, so the subscription document arrives while the
      // page is already open. That is the race `awaitProActivation` exists
      // for — Stripe's redirect and our own `stripeWebhook` delivery run
      // concurrently and the redirect usually wins. Seeding before the visit
      // would be answered by the plain read-on-load and would never exercise
      // the poll.
      cy.setProSubscription({ uid });
    });

    // Fails unless the poll actually picks the subscription up: nothing else
    // on this page will notice it.
    cy.contains("You're subscribed");

    cy.visit('/add-question');
    cy.location('pathname').should('eq', '/add-question');

    // This screen carries the other two segmented pickers (Question Type and,
    // once a boolean question is chosen, Correct Answer), and it is only
    // reachable as Pro — so G4's sweep runs here rather than in the
    // unauthenticated spec.
    assertRadiosAreGrouped();

    // Retries until the Pro-gated form actually renders — i.e. until the
    // subscription read and the forced token refresh have landed, not just
    // until the doc write resolved.
    cy.get('#category').type('Science');
    cy.get('#question').type('What planet is known as the Red Planet?');
    cy.get('#correctAnswer').type('Mars');
    cy.get('input[placeholder="Incorrect answer 1"]').type('Venus');
    cy.get('input[placeholder="Incorrect answer 2"]').type('Jupiter');
    cy.get('input[placeholder="Incorrect answer 3"]').type('Saturn');
    cy.contains('button', 'Add Question').click();

    // Not "added to the bank" any more (item 4c): a submission is stored and
    // queued for review, and the copy has to say so or the app is promising
    // something the rules refuse to do.
    cy.contains('Thanks! Your question has been submitted for review.');
    cy.contains('once a reviewer has approved it');
  });
});
