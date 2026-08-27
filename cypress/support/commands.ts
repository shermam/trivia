import { deleteOfflineDatabase } from './offline-storage';
import type {
  AccountState,
  AccountStateQuery,
  CustomQuestionSeed,
  LeaderboardSeed,
  ProSubscriptionSeed,
  QuestionReportRecord,
  ReviewerSeed,
  VerifiedUserSeed,
} from '../tasks/types';

declare global {
  namespace Cypress {
    interface Chainable {
      /** Wipes all emulator Auth users + Firestore `leaderboard`/`custom_questions` docs. */
      resetBackend(): Chainable<null>;
      /**
       * Deletes the app's IndexedDB database — the saved game and the offline
       * question pool — which Cypress's own test isolation does not touch.
       *
       * **Must be called before the test's first `cy.visit()`**, and is, from
       * the `beforeEach` in both support files. `deleteDatabase` blocks on any
       * open connection, and the app holds one for the life of the tab; see
       * `offline-storage.ts` for the two placements that were tried and what
       * each one actually did.
       */
      clearOfflineStorage(): Chainable<void>;
      /** Intercepts the Open Trivia DB endpoints with deterministic fixtures. */
      stubOpenTrivia(): Chainable<null>;
      /**
       * Visits `/`, waits for the stubbed categories to load, selects
       * `amount`, starts the game, and waits until `/play` is actually the
       * active route.
       */
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
      /** Grants the `user_roles` moderation role — Admin SDK only, as in production. */
      seedReviewer(seed: ReviewerSeed): Chainable<null>;
      /** Writes documents straight into `custom_questions`, bypassing Firestore rules. */
      seedCustomQuestions(questions: CustomQuestionSeed[]): Chainable<null>;
      /** Writes a single `leaderboard/{uid}` document, bypassing Firestore rules. */
      seedLeaderboardEntry(entry: LeaderboardSeed): Chainable<null>;
      /** Retrieves the emulator's pending OOB (out-of-band) email-verification link for this address. */
      getVerificationLink(email: string): Chainable<string>;
      /**
       * Simulates a completed Stripe subscription for this uid — sets the
       * `stripeRole: 'pro'` custom claim and seeds a matching
       * `customers/{uid}/subscriptions` doc — without touching Stripe.
       */
      setProSubscription(seed: ProSubscriptionSeed): Chainable<null>;
      /** Seeds a fake Pro product/price so `getProPriceId()` resolves without a real Stripe sync. */
      seedProProduct(): Chainable<null>;
      /** Reads back Auth/leaderboard/customer/question state after an account deletion. */
      inspectAccountState(query: AccountStateQuery): Chainable<AccountState>;
      countGameplayStatsDocuments(): Chainable<number>;
      /** Reads every `question_reports` doc via the Admin SDK — clients are forbidden from reading them. */
      getQuestionReports(): Chainable<QuestionReportRecord[]>;
    }
  }
}

Cypress.Commands.add('resetBackend', () => {
  cy.task('resetBackend');
});

Cypress.Commands.add('clearOfflineStorage', () => {
  // `{ log: false }` on the window read only: the deletion itself stays in the
  // command log, so a spec that fails on leaked state shows this ran.
  cy.window({ log: false }).then((win) => deleteOfflineDatabase(win));
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
  waitForPlayRoute();
});

Cypress.Commands.add('startNewGame', (amount = 5) => {
  cy.location('pathname').should('eq', '/');
  cy.get('#amount').select(String(amount));
  cy.contains('button', 'Start Game').click();
  cy.wait('@questions');
  waitForPlayRoute();
});

/**
 * Waits until the quiz loop is genuinely on screen.
 *
 * Both commands above used to end at `cy.wait('@questions')`, which is not the
 * same thing and is a quiet trap for the caller. That wait resolves the moment
 * Cypress forwards the intercepted response — and the questions response is
 * what `GameControllerService.startGame()` awaits *before* it navigates, so at
 * that instant the app is still on the setup screen, with the lazy `/play`
 * chunk not yet fetched. Any caller whose next command was a negative
 * assertion (`should('not.exist')`) therefore passed against `/`, testing
 * nothing — which is exactly what happened to the "no flag on an Open Trivia
 * question" test. Callers that go straight to a positive, retrying query were
 * always fine; this makes both cases safe.
 *
 * The heading assertion is the load-bearing half: the URL can commit a tick
 * before the outlet paints, but the question text cannot appear until the
 * component has rendered.
 */
function waitForPlayRoute(): void {
  cy.location('pathname').should('eq', '/play');
  cy.get('[data-cy="question-text"]').should('be.visible');
}

Cypress.Commands.add('answerQuestion', (answerText: string) => {
  cy.contains('button', answerText).click();
});

Cypress.Commands.add('openAuthMenu', () => {
  cy.get('[data-cy=auth-menu-trigger]').click();
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

Cypress.Commands.add('seedReviewer', (seed: ReviewerSeed) => {
  cy.task('seedReviewer', seed);
});

Cypress.Commands.add('seedLeaderboardEntry', (entry: LeaderboardSeed) => {
  cy.task('seedLeaderboardEntry', entry);
});

Cypress.Commands.add('getVerificationLink', (email: string) => {
  cy.task<string>('getVerificationLink', email);
});

Cypress.Commands.add('setProSubscription', (seed: ProSubscriptionSeed) => {
  cy.task('setProSubscription', seed);
});

Cypress.Commands.add('seedProProduct', () => {
  cy.task('seedProProduct');
});

Cypress.Commands.add('inspectAccountState', (query: AccountStateQuery) => {
  cy.task('inspectAccountState', query);
});

Cypress.Commands.add('countGameplayStatsDocuments', () => {
  cy.task('countGameplayStatsDocuments');
});

Cypress.Commands.add('getQuestionReports', () => {
  cy.task('getQuestionReports');
});
