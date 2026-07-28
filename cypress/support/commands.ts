import type { CustomQuestionSeed, LeaderboardSeed, VerifiedUserSeed } from '../tasks/types';

declare global {
  namespace Cypress {
    interface Chainable {
      /** Wipes all emulator Auth users + Firestore `leaderboard`/`custom_questions` docs. */
      resetBackend(): Chainable<null>;
      /** Intercepts the Open Trivia DB endpoints with deterministic fixtures. */
      stubOpenTrivia(): Chainable<null>;
      /** Visits `/`, waits for the stubbed categories to load, selects `amount`, and starts the game. */
      startGame(amount?: 5 | 10 | 15 | 20 | 25): Chainable<null>;
      /**
       * Starts another game without revisiting the page — for replaying via
       * "Play Again" within the same test/session, where the app is already
       * loaded and on `/`. Categories are already cached in `TriviaService`
       * from the first `startGame()`, so no new `@categories` request fires.
       */
      startNewGame(amount?: 5 | 10 | 15 | 20 | 25): Chainable<null>;
      /** Clicks the answer button matching this exact text on the active quiz question. */
      answerQuestion(answerText: string): Chainable<null>;
      /** Opens the top-bar auth menu (only valid while it's closed). */
      openAuthMenu(): Chainable<null>;
      /** Drives the real sign-up UI (auth menu defaults to sign-up mode). */
      signUpViaUi(email: string, password: string): Chainable<null>;
      /** Drives the real sign-in UI (switches the auth menu out of its default sign-up mode). */
      signInViaUi(email: string, password: string): Chainable<null>;
      /** Opens the auth menu via game-over's own "Sign in" prompt, then signs in. */
      signInFromGameOver(email: string, password: string): Chainable<null>;
      /** Creates an already-email-verified user directly in the Auth emulator. */
      createVerifiedUser(seed: VerifiedUserSeed): Chainable<{ uid: string }>;
      /** Writes documents straight into `custom_questions`, bypassing Firestore rules. */
      seedCustomQuestions(questions: CustomQuestionSeed[]): Chainable<null>;
      /** Writes a single `leaderboard/{uid}` document, bypassing Firestore rules. */
      seedLeaderboardEntry(entry: LeaderboardSeed): Chainable<null>;
      /** Retrieves the emulator's pending OOB (out-of-band) email-verification link for this address. */
      getVerificationLink(email: string): Chainable<string>;
    }
  }
}

Cypress.Commands.add('resetBackend', () => {
  cy.task('resetBackend');
});

Cypress.Commands.add('stubOpenTrivia', () => {
  cy.intercept('GET', 'https://opentdb.com/api_category.php', {
    fixture: 'open-trivia-categories.json',
  }).as('categories');
  cy.intercept('GET', 'https://opentdb.com/api.php*', {
    fixture: 'open-trivia-questions.json',
  }).as('questions');
});

Cypress.Commands.add('startGame', (amount = 5) => {
  cy.stubOpenTrivia();
  cy.visit('/');
  cy.wait('@categories');
  cy.get('#amount').select(String(amount));
  cy.contains('button', 'Start Game').click();
  cy.wait('@questions');
});

Cypress.Commands.add('startNewGame', (amount = 5) => {
  cy.location('pathname').should('eq', '/');
  cy.get('#amount').select(String(amount));
  cy.contains('button', 'Start Game').click();
  cy.wait('@questions');
});

Cypress.Commands.add('answerQuestion', (answerText: string) => {
  cy.contains('button', answerText).click();
});

Cypress.Commands.add('openAuthMenu', () => {
  cy.get('header button').click();
});

// Scoped to <app-auth-menu> throughout: the setup screen's own form (and its
// type=submit "Start Game" button) is often still in the DOM behind the
// dropdown, so an unscoped `form button[type=submit]` matches two elements.
function fillEmailForm(email: string, password: string): void {
  cy.get('app-auth-menu input[name=email]').type(email);
  cy.get('app-auth-menu input[name=password]').type(password);
}

Cypress.Commands.add('signUpViaUi', (email: string, password: string) => {
  cy.openAuthMenu();
  fillEmailForm(email, password);
  cy.get('app-auth-menu form button[type=submit]').click();
  // The menu stays open after sign-up, but the panel it shows next varies
  // (still anonymous on failure vs. an "awaiting verification" panel with no
  // form at all on success) — "Please wait…" disappearing is the one signal
  // common to every outcome, so wait for that instead of racing the next
  // command against the in-flight call.
  cy.get('app-auth-menu').should('not.contain', 'Please wait');
});

Cypress.Commands.add('signInViaUi', (email: string, password: string) => {
  cy.openAuthMenu();
  cy.get('app-auth-menu')
    .contains('button[type=button]', 'Already have an account? Sign in')
    .click();
  fillEmailForm(email, password);
  cy.get('app-auth-menu form button[type=submit]').click();
  // A successful sign-in closes the menu — wait for that instead of racing
  // the next command against the in-flight sign-in call.
  cy.get('app-auth-menu').should('not.exist');
});

Cypress.Commands.add('signInFromGameOver', (email: string, password: string) => {
  cy.get('[data-cy=open-sign-in]').click();
  cy.get('app-auth-menu')
    .contains('button[type=button]', 'Already have an account? Sign in')
    .click();
  fillEmailForm(email, password);
  cy.get('app-auth-menu form button[type=submit]').click();
  cy.get('app-auth-menu').should('not.exist');
});

Cypress.Commands.add('createVerifiedUser', (seed: VerifiedUserSeed) => {
  cy.task('createVerifiedUser', seed);
});

Cypress.Commands.add('seedCustomQuestions', (questions: CustomQuestionSeed[]) => {
  cy.task('seedCustomQuestions', questions);
});

Cypress.Commands.add('seedLeaderboardEntry', (entry: LeaderboardSeed) => {
  cy.task('seedLeaderboardEntry', entry);
});

Cypress.Commands.add('getVerificationLink', (email: string) => {
  cy.task<string>('getVerificationLink', email);
});
