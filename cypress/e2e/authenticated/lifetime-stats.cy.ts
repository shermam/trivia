import questionsFixture from '../../fixtures/open-trivia-questions.json';

const CORRECT_ANSWERS = questionsFixture.results.map((q) => q.correct_answer);
const password = 'Str0ngPassw0rd!';

/**
 * `users/{uid}` — the lifetime totals a completed game banks.
 *
 * Every assertion reads the document through the Admin SDK rather than through
 * the UI, and it has to: nothing in the app renders these numbers yet
 * (`FEAT-005`'s profile page is a separate feature), and the risk being
 * guarded is a write that silently does not happen or silently happens twice —
 * both of which look identical from the front end.
 *
 * `firestore.rules` gives the collection no client write path at all, so a
 * document appearing here is proof the callable ran, not proof the browser
 * could reach Firestore.
 */
describe('lifetime gameplay totals', () => {
  let email: string;
  let uid: string;

  beforeEach(() => {
    cy.resetBackend();
    email = `stats-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    cy.createVerifiedUser({ email, password }).then((user) => {
      uid = user.uid;
    });
  });

  function playFullGame() {
    CORRECT_ANSWERS.forEach((answer) => {
      cy.answerQuestion(answer);
    });
    cy.location('pathname').should('eq', '/game-over');
  }

  it('banks a finished game against the signed-in account', () => {
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.signInViaUi(email, password);

    cy.startNewGame(5);
    playFullGame();

    // `waitForGameplayStats` rather than a bare `.should()`: the call is
    // fire-and-forget so nothing in the DOM changes when it lands, and
    // `cy.task` is not a retrying query — an assertion chained onto it reads
    // once. These three tests passed that way, and passing by luck is not the
    // same as passing.
    cy.then(() => {
      cy.waitForGameplayStats(uid).should('include', {
        gamesPlayed: 1,
        questionsAnswered: 5,
        correctAnswers: 5,
        bestStreak: 5,
      });
    });
  });

  /**
   * **The defect `lastGameId` exists to prevent.** `/game-over` is deliberately
   * restorable — the completed game stays in the snapshot so a refresh does not
   * lose the score about to be submitted — which means `ngOnInit` runs again
   * and calls the callable again with the same game.
   *
   * The assertion has to read the counter, not merely check the document
   * exists: an implementation that banks the game twice produces a document
   * either way, so an existence check would pass against the bug.
   */
  it('does not bank the same game twice when the results screen is reloaded', () => {
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.signInViaUi(email, password);

    cy.startNewGame(5);
    playFullGame();

    cy.then(() => {
      cy.waitForGameplayStats(uid).should('include', { gamesPlayed: 1 });
    });

    cy.reload();
    cy.location('pathname').should('eq', '/game-over');
    cy.contains('Game Over!');

    // The reload's own call has to have been made and refused before this is
    // meaningful, so give it the same window the first write got — otherwise
    // "still 1" could just mean "the second call has not happened yet", which
    // would pass against the very double-count this test exists to catch.
    cy.wait(3000);
    cy.then(() => {
      cy.waitForGameplayStats(uid).should('include', {
        gamesPlayed: 1,
        questionsAnswered: 5,
      });
    });
  });

  /**
   * Anonymous sessions get no document, enforced in the callable because there
   * is no client write rule for the gate to live in.
   *
   * Not tidiness: `deleteAccount` never runs for an anonymous account and
   * Firebase's auto-deletion removes only the Auth record, so a document per
   * guest would accumulate with nothing able to delete it — and the Privacy
   * Policy's claim that nothing is kept for anonymous play would stop being
   * true on the first page load after deploy.
   *
   * Asserted by counting the whole collection rather than by inspecting one
   * uid: the claim is that *nobody* got a document, and `resetBackend()` has
   * emptied it in `beforeEach`, so a count of zero says exactly that — and
   * says it without the test having to dig an anonymous uid out of the
   * browser's auth state, which would be the more fragile half of the check.
   */
  it('keeps nothing for an anonymous player', () => {
    cy.startGame(5);
    playFullGame();

    // A positive anchor first. The count below is a negative assertion, and a
    // negative assertion straight after a navigation is satisfied by a page
    // that has not finished doing anything yet (`ci-cd.md` §4.3) — here, by
    // the callable simply not having been reached.
    cy.contains('Sign in to save this score to the leaderboard.').should('be.visible');

    cy.countGameplayStatsDocuments().should('eq', 0);
  });
});
