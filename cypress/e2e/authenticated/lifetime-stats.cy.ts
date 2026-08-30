import questionsFixture from '../../fixtures/open-trivia-questions.json';

const CORRECT_ANSWERS = questionsFixture.results.map((q) => q.correct_answer);
const password = 'Str0ngPassw0rd!';

/**
 * How long to wait for a `recordGameResult` invocation to be made and
 * answered. Generous on purpose: this is a ceiling, not a delay — the wait
 * ends when the response arrives — and it has to clear a cold Functions
 * emulator on a CPU-starved runner. Above Cypress's 5s `requestTimeout`
 * default, which is what `cy.wait('@alias')` would otherwise use.
 */
const CALLABLE_TIMEOUT_MS = 30000;

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

  /**
   * Every test here asserts an exact tally, so every game they play is
   * **unlimited**.
   *
   * The default 15-second limit is a real deadline, and on a loaded runner a
   * click can land after it expires: the question auto-advances as wrong and
   * the game ends 4/5. That is what made this spec red on `main` — the
   * assertion reported `correctAnswers` 4 against an expected 5, with nothing
   * in the message pointing at a clock, and the callable was right about the
   * game it was told about. Removing the deadline removes the whole class of
   * failure, and costs nothing: `functions/src/game-stats.ts` never reads the
   * time limit, so an unlimited game banks identically. The countdown itself
   * is `adjustable-timer.cy.ts`'s subject, not this file's.
   *
   * **All three tests use `startGame`, including the two that have already
   * loaded the page.** `startNewGame` skips `cy.wait('@categories')` by design
   * — its contract is "the app is loaded and categories are cached" — and
   * picking the time limit without that wait made both tests using it fail in
   * CI while the one using `startGame` passed. The extra page load is a small
   * price for touching the setup form only once it has settled, which is the
   * order `adjustable-timer.cy.ts` has always used. Signing in survives the
   * revisit; the reload in the second test already depends on that.
   */
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

    cy.startGame(5, 'unlimited');
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
    // Spy on the callable — pass-through, nothing is stubbed — so the reload's
    // own invocation becomes something this test can wait *for* rather than
    // wait *out*. `/game-over` fires it from `ngOnInit`, so there is one
    // request per visit and `cy.wait` consumes them in order.
    //
    // A RegExp rather than a glob: the callable posts to
    // `http://127.0.0.1:5001/<projectId>/us-central1/recordGameResult`, and a
    // `**/` glob has to match across the `//` in the protocol, which is
    // exactly where minimatch is fussy. A regex is matched against the whole
    // URL with no such subtlety.
    cy.intercept('POST', /\/recordGameResult(\?|$)/).as('recordGameResult');
    cy.visit('/');
    cy.signInViaUi(email, password);

    cy.startGame(5, 'unlimited');
    playFullGame();

    cy.wait('@recordGameResult', { timeout: CALLABLE_TIMEOUT_MS });
    cy.then(() => {
      cy.waitForGameplayStats(uid).should('include', { gamesPlayed: 1 });
    });

    cy.reload();
    cy.location('pathname').should('eq', '/game-over');
    cy.contains('Game Over!');

    // **The reload's call has to have been made and answered before the
    // assertion below means anything** — otherwise "still 1" could just mean
    // "the second call has not happened yet", which would pass against the
    // very double-count this test exists to catch.
    //
    // Which is why this waits on the interception and not on a clock. A fixed
    // delay is calibrated against whichever machine it was written on: too
    // short on a loaded runner and the assertion passes vacuously, too long
    // and every run pays for it. Waiting on the request returns the instant
    // the response lands.
    cy.wait('@recordGameResult', { timeout: CALLABLE_TIMEOUT_MS });

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
    cy.startGame(5, 'unlimited');
    playFullGame();

    // A positive anchor first. The count below is a negative assertion, and a
    // negative assertion straight after a navigation is satisfied by a page
    // that has not finished doing anything yet (`ci-cd.md` §4.3) — here, by
    // the callable simply not having been reached.
    cy.contains('Sign in to save this score to the leaderboard.').should('be.visible');

    cy.countGameplayStatsDocuments().should('eq', 0);
  });
});
