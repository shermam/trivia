/**
 * `FEAT-022`. A contributor can cite where an answer comes from; a reviewer
 * and a player can follow the citation.
 *
 * Three seams, none of which any cheaper layer reaches:
 *
 * - **The rules accept the widened document.** The rules suite proves
 *   `isValidCustomQuestion()` admits `sourceUrl`/`sourceTitle`, but it builds
 *   the payload by hand. Only this proves the payload the *form* builds is the
 *   one the rules were widened for — the two have disagreed before, and a
 *   mismatch surfaces as a bare `permission-denied` with the contributor's
 *   work lost.
 * - **The reviewer's card renders the link.** This is where the feature earns
 *   its keep: a reviewer who cannot check the source is approving on vibes.
 * - **The recap renders the link, and renders nothing without one.** The
 *   negative half matters as much as the positive: the common case is a
 *   question with no source at all, and a badge, placeholder or empty row
 *   there would be a regression for every Open Trivia DB question in the app.
 *
 * Under `authenticated/` deliberately, which keeps it out of
 * `cypress.preview.config.ts` — the recap test seeds custom questions, and
 * the preview runner shares a real backend.
 */

const SOURCE_REVIEWER = { email: 'source-reviewer@example.com', password: 'Password123!' };

const SOURCED_QUESTION = {
  id: 'sourced-1',
  category: 'Science',
  type: 'multiple' as const,
  difficulty: 'easy' as const,
  question: 'What is the chemical symbol for water?',
  correct_answer: 'H2O',
  incorrect_answers: ['CO2', 'O2', 'NaCl'],
  createdBy: 'someone-else',
  createdAt: Date.now(),
  sourceUrl: 'https://example.org/water',
  sourceTitle: 'Example Journal',
};

const UNSOURCED_QUESTION = {
  id: 'unsourced-1',
  category: 'Science',
  type: 'multiple' as const,
  difficulty: 'easy' as const,
  question: 'What planet is known as the Red Planet?',
  correct_answer: 'Mars',
  incorrect_answers: ['Venus', 'Jupiter', 'Saturn'],
  createdBy: 'someone-else',
  createdAt: Date.now(),
};

/**
 * Starts a **Custom** game, so the questions come from `custom_questions`
 * rather than the stubbed Open Trivia response — the latter carries no source
 * and never will, so a recap assertion after `cy.startGame` would hold no
 * matter what this feature did.
 */
function startSourcedCustomGame(): void {
  cy.visit('/');
  cy.wait('@categories');
  cy.get('#amount').select('5');
  cy.contains('label', 'Custom').click();
  cy.contains('button', 'Start Game').click();
  cy.location('pathname').should('eq', '/play');
  cy.get('[data-cy="question-text"]').should('be.visible');
}

/** Answers whatever is on screen until the game ends. */
function playToGameOver(): void {
  cy.get('[data-cy="answer-option"]').first().click();
  cy.get('[data-cy="answer-option"]').first().click();
  cy.location('pathname').should('eq', '/game-over');
}

describe('question source attribution', () => {
  beforeEach(() => {
    cy.resetBackend();
    cy.stubOpenTrivia();
  });

  it('accepts a cited question through the real rules, and shows the reviewer the link', () => {
    const password = 'correct horse battery staple';
    const email = `source-author-${Date.now()}@example.com`;

    cy.createVerifiedUser({ email, password }).then(({ uid }) => {
      cy.visit('/');
      cy.signInViaUi(email, password);
      cy.visit('/pricing?checkout=success');
      cy.setProSubscription({ uid });
    });
    cy.contains("You're subscribed");

    cy.visit('/add-question');
    cy.get('#category').type('Science');
    cy.get('#question').type('What is the chemical symbol for water?');
    cy.get('#correctAnswer').type('H2O');
    cy.get('input[placeholder="Incorrect answer 1"]').type('CO2');
    cy.get('input[placeholder="Incorrect answer 2"]').type('O2');
    cy.get('input[placeholder="Incorrect answer 3"]').type('NaCl');
    cy.get('[data-cy="source-url"]').type('https://example.org/water');
    cy.get('[data-cy="source-title"]').type('Example Journal');
    cy.contains('button', 'Add Question').click();

    // The assertion that matters: the write was accepted. A `hasOnly()`
    // allowlist that had not been widened would land here as a generic
    // failure message instead.
    cy.contains('Thanks! Your question has been submitted for review.');

    // Now the other end of the same document. A fresh reviewer account, since
    // the submission is pending and only a reviewer may list it.
    cy.createVerifiedUser(SOURCE_REVIEWER).then(({ uid }) => {
      cy.seedReviewer({ uid, reviewer: true });
    });
    cy.visit('/');
    cy.signInViaUi(SOURCE_REVIEWER.email, SOURCE_REVIEWER.password);
    cy.visit('/review');

    cy.get('[data-cy="review-question"]')
      .filter(':contains("chemical symbol for water")')
      .should('have.length', 1)
      .find('[data-cy="question-source-link"]')
      .should(($link) => {
        // One callback rather than a chain: `should('have.attr', name)` with
        // no expected value changes the subject to the attribute's *string*,
        // so anything chained after it stops being about the element
        // (`CLAUDE.md` §4.6).
        expect($link.attr('href')).to.equal('https://example.org/water');
        expect($link.attr('target')).to.equal('_blank');
        expect($link.attr('rel')).to.equal('noopener noreferrer');
        expect($link.text()).to.contain('Example Journal');
      });
  });

  it('refuses a malformed source link in the form, naming the field', () => {
    const password = 'correct horse battery staple';
    const email = `source-bad-${Date.now()}@example.com`;

    cy.createVerifiedUser({ email, password }).then(({ uid }) => {
      cy.visit('/');
      cy.signInViaUi(email, password);
      cy.visit('/pricing?checkout=success');
      cy.setProSubscription({ uid });
    });
    cy.contains("You're subscribed");

    cy.visit('/add-question');
    cy.get('#category').type('Science');
    cy.get('#question').type('What planet is known as the Red Planet?');
    cy.get('#correctAnswer').type('Mars');
    cy.get('input[placeholder="Incorrect answer 1"]').type('Venus');
    cy.get('input[placeholder="Incorrect answer 2"]').type('Jupiter');
    cy.get('input[placeholder="Incorrect answer 3"]').type('Saturn');
    cy.get('[data-cy="source-url"]').type('example.org/mars');
    cy.contains('button', 'Add Question').click();

    // Named and focused, not a silent no-op: the whole reason the source
    // controls are in `fieldLabels`.
    cy.get('[data-cy="source-url-error"]').should('be.visible');
    cy.get('#sourceUrl').should('have.focus');
    cy.contains('Thanks! Your question has been submitted for review.').should('not.exist');
  });

  it('offers the source in the recap, and shows nothing for a question without one', () => {
    cy.seedCustomQuestions([SOURCED_QUESTION, UNSOURCED_QUESTION]);

    startSourcedCustomGame();
    playToGameOver();

    cy.get('[data-cy="recap-toggle"]').click();
    cy.get('[data-cy="recap-row"]').should('have.length', 2);

    cy.get('[data-cy="recap-row"]')
      .filter(':contains("chemical symbol for water")')
      .find('[data-cy="question-source-link"]')
      .should(($link) => {
        expect($link.attr('href')).to.equal('https://example.org/water');
        expect($link.attr('rel')).to.equal('noopener noreferrer');
        expect($link.text()).to.contain('Example Journal');
      });

    // The common case, and the one a placeholder would quietly ruin.
    cy.get('[data-cy="recap-row"]')
      .filter(':contains("Red Planet")')
      .find('[data-cy="question-source"]')
      .should('not.exist');
  });
});
