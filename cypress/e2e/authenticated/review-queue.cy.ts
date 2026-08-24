/**
 * The moderation role and queue, end to end (`BACKLOG.md` item 4b-ii).
 *
 * This is the layer neither the rules suite nor the unit specs can reach. The
 * rules tests prove `firestore.rules` refuses the right writes; the unit specs
 * prove the service sends the right ones. Only this proves that a role
 * document created out of band actually reaches `ReviewerService`, renders the
 * link, and that a decision made in the browser is accepted by the real rules
 * — which is the seam `AuthService` has already produced three bugs in.
 */

const REVIEWER = { email: 'reviewer@example.com', password: 'Password123!' };
const PLAIN = { email: 'plain@example.com', password: 'Password123!' };

function seedQuestions() {
  cy.seedCustomQuestions([
    {
      id: 'pending-1',
      category: 'Science',
      type: 'multiple',
      difficulty: 'easy',
      question: 'Is this question waiting for review?',
      correct_answer: 'Yes',
      incorrect_answers: ['No', 'Maybe', 'Unsure'],
      createdBy: 'someone-else',
      createdAt: Date.now(),
      status: 'pending',
    },
    {
      id: 'approved-1',
      category: 'History',
      type: 'multiple',
      difficulty: 'easy',
      question: 'Is this question already live?',
      correct_answer: 'Yes',
      incorrect_answers: ['No', 'Maybe', 'Unsure'],
      createdBy: 'someone-else',
      createdAt: Date.now(),
      status: 'approved',
    },
  ]);
}

/**
 * Starts a **Custom** game. Not `cy.startGame`, which uses the Open Trivia
 * source and never reads `custom_questions` at all — a negative assertion
 * after that would hold no matter what the status filter did.
 */
function startCustomGame(): void {
  cy.visit('/');
  cy.wait('@categories');
  cy.get('#amount').select('5');
  cy.contains('label', 'Custom').click();
  cy.contains('button', 'Start Game').click();
  cy.location('pathname').should('eq', '/play');
  cy.get('[data-cy="question-text"]').should('be.visible');
}

/**
 * Acts on the queue row containing `text`.
 *
 * Scoped to the row and addressed by `data-cy` on purpose: `cy.contains(
 * 'button', 'Approve')` matches the **"Approved" tab**, because contains() is
 * a substring match and takes the first hit in DOM order. That shipped once
 * and made a `should('not.exist')` pass for the wrong reason.
 */
function decideOn(text: string, decision: 'approve' | 'reject'): void {
  cy.get('[data-cy="review-question"]')
    .filter(`:contains("${text}")`)
    .should('have.length', 1)
    .find(`[data-cy="${decision}-question"]`)
    .click();
}

describe('the review queue', () => {
  beforeEach(() => {
    cy.resetBackend();
    cy.stubOpenTrivia();
    seedQuestions();
  });

  it('shows the link and the queue to a reviewer', () => {
    cy.createVerifiedUser({ ...REVIEWER, displayName: 'Rev' }).then(({ uid }) => {
      cy.seedReviewer({ uid, reviewer: true });
    });
    cy.visit('/');
    cy.signInViaUi(REVIEWER.email, REVIEWER.password);

    cy.get('[data-cy="review-queue-link"]').should('be.visible').click();
    cy.location('pathname').should('eq', '/review');
    cy.contains('Is this question waiting for review?').should('be.visible');
    cy.contains('Is this question already live?').should('not.exist');
  });

  /**
   * Every button here is addressed by `data-cy`, never by its text, and that
   * is not stylistic. The first version of this test clicked
   * `cy.contains('button', 'Approve')` — which matched the **"Approved" tab**,
   * because "Approved" contains "Approve" and the tab bar precedes the list in
   * the DOM. It switched tabs instead of approving anything, and the
   * `should('not.exist')` that followed then passed for entirely the wrong
   * reason: the pending question was absent because the *Approved* tab was
   * showing, not because it had been approved. Only the assertion after it
   * failed, which is the sole reason this was caught at all.
   */
  it('approves a pending question, and the decision survives a reload', () => {
    cy.createVerifiedUser({ ...REVIEWER, displayName: 'Rev' }).then(({ uid }) => {
      cy.seedReviewer({ uid, reviewer: true });
    });
    cy.visit('/');
    cy.signInViaUi(REVIEWER.email, REVIEWER.password);
    cy.visit('/review');

    cy.get('[data-cy="review-question"]').should('have.length', 1);
    cy.contains('Is this question waiting for review?').should('be.visible');
    cy.get('[data-cy="approve-question"]').click();

    // Gone from Pending, and the tab is genuinely empty rather than merely not
    // containing that one string.
    cy.get('[data-cy="review-question"]').should('have.length', 0);

    // ...and the write actually landed, rather than only the row disappearing
    // from a list the browser was holding in memory.
    cy.get('[data-cy="review-tab"][data-status="approved"]').click();
    cy.get('[data-cy="review-question"]').should('have.length', 2);
    cy.contains('Is this question waiting for review?').should('be.visible');

    cy.reload();
    cy.get('[data-cy="review-tab"][data-status="approved"]').click();
    cy.contains('Is this question waiting for review?').should('be.visible');
  });

  it('hides the link from an account with no role document', () => {
    cy.createVerifiedUser({ ...PLAIN, displayName: 'Plain' });
    cy.visit('/');
    cy.signInViaUi(PLAIN.email, PLAIN.password);

    cy.get('[data-cy="review-queue-link"]').should('not.exist');
  });

  // The H6 shape: a document that exists and says `false` is not a reviewer.
  // A truthiness or existence check would pass this and unlock a page whose
  // buttons the server is bound to refuse.
  it('hides the link from an account whose role document says false', () => {
    cy.createVerifiedUser({ ...PLAIN, displayName: 'Plain' }).then(({ uid }) => {
      cy.seedReviewer({ uid, reviewer: false });
    });
    cy.visit('/');
    cy.signInViaUi(PLAIN.email, PLAIN.password);

    cy.get('[data-cy="review-queue-link"]').should('not.exist');
  });

  it('tells a non-reviewer who navigates straight to /review that it is not for them', () => {
    cy.createVerifiedUser({ ...PLAIN, displayName: 'Plain' });
    cy.visit('/');
    cy.signInViaUi(PLAIN.email, PLAIN.password);
    cy.visit('/review');

    cy.contains('This page is for question reviewers').should('be.visible');
    cy.contains('Is this question waiting for review?').should('not.exist');
  });

  /**
   * Item 4c end to end, and the only test that covers the whole promise: a
   * contribution is stored, is *not* served, appears in the queue, and starts
   * being served the moment it is approved.
   *
   * The rules half is covered by the rules suite and the service half by the
   * unit specs, but neither can see the seam — that the status the client
   * writes on submit is the same one the queue filters on, and that the game's
   * query starts matching once a reviewer moves it.
   */
  it('takes a real submission through review and into a game', () => {
    cy.createVerifiedUser({ ...REVIEWER, displayName: 'Rev' }).then(({ uid }) => {
      cy.seedReviewer({ uid, reviewer: true });
      cy.setProSubscription({ uid });
    });
    cy.visit('/');
    cy.signInViaUi(REVIEWER.email, REVIEWER.password);

    cy.visit('/add-question');
    cy.get('#category').type('Astronomy');
    cy.get('#question').type('Which planet has the Great Red Spot?');
    cy.get('#correctAnswer').type('Jupiter');
    cy.get('input[placeholder="Incorrect answer 1"]').type('Mars');
    cy.get('input[placeholder="Incorrect answer 2"]').type('Venus');
    cy.get('input[placeholder="Incorrect answer 3"]').type('Saturn');
    cy.contains('button', 'Add Question').click();
    cy.contains('submitted for review');

    // Not served while pending — the whole point of the feature. Exactly one
    // question is approved at this moment, so the game is deterministic and
    // the assertion below is about which question was served, not about which
    // of several happened to come up first.
    startCustomGame();
    cy.contains('Is this question already live?').should('be.visible');
    cy.contains('Which planet has the Great Red Spot?').should('not.exist');

    cy.visit('/review');
    cy.contains('Which planet has the Great Red Spot?').should('be.visible');
    decideOn('Great Red Spot', 'approve');

    // Reject the one that was already live, so that again exactly one question
    // is approved. That keeps the next game deterministic *and* proves the
    // other half in the same breath: rejecting takes a question out of play.
    cy.get('[data-cy="review-tab"][data-status="approved"]').click();
    decideOn('already live', 'reject');

    startCustomGame();
    cy.contains('Which planet has the Great Red Spot?').should('be.visible');
    cy.contains('Is this question already live?').should('not.exist');
  });

  it('never serves an unapproved question to a player', () => {
    // The client half of review-before-publish. The rule is still open for one
    // release, so this filter is the only thing keeping a pending question out
    // of a game — which makes it worth an e2e row of its own.
    //
    // It has to be a **Custom** game. `cy.startGame` uses the Open Trivia
    // source, which never touches `custom_questions` at all, so the negative
    // assertion below would hold no matter what the filter did.
    startCustomGame();

    // The positive control, and the reason this test is not vacuous: the
    // approved question really is being served from the bank. Without it a
    // custom game that failed to start at all would pass the assertion that
    // follows.
    cy.contains('Is this question already live?').should('be.visible');
    cy.contains('Is this question waiting for review?').should('not.exist');
  });
});
