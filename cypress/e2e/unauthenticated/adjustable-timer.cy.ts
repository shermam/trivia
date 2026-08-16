import questionsFixture from '../../fixtures/open-trivia-questions.json';
import { assertRadiosAreGrouped } from '../../support/a11y-assertions';

/**
 * Finding G7. A 15-second limit that cannot be adjusted, extended or turned
 * off fails WCAG 2.2.1. The unit tests cover the countdown arithmetic; what
 * only a browser can show is that the choice actually reaches the quiz, that
 * an unlimited game really has no deadline, and that game-over then names the
 * board the score belongs to.
 */
describe('choosing a time limit', () => {
  function startWith(limit: '15' | '30' | 'unlimited'): void {
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.wait('@categories');
    cy.get('#amount').select('5');
    cy.get(`[data-cy="time-limit-${limit}"]`).click({ force: true });
    cy.contains('button', 'Start Game').click();
    cy.wait('@questions');
    cy.location('pathname').should('eq', '/play');
    cy.get('[data-cy="question-text"]').should('be.visible');
  }

  it('defaults to 15 seconds and says which board that ranks on', () => {
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.wait('@categories');

    cy.get('[data-cy="time-limit-15"]').should('be.checked');
    cy.get('[data-cy="time-limit-note"]').should('contain.text', '15-second leaderboard');

    // The picker is a labelled radiogroup, same contract as Question Source
    // (G4) — swept generically so a fourth option would be covered too.
    assertRadiosAreGrouped();
  });

  it('says the no-limit choice ranks separately, before the game starts', () => {
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.wait('@categories');

    cy.get('[data-cy="time-limit-unlimited"]').click({ force: true });
    cy.get('[data-cy="time-limit-note"]').should('contain.text', 'no-limit leaderboard');
  });

  it('counts down from 30 when 30 is chosen', () => {
    startWith('30');
    // The ring renders the chosen limit, not a hard-coded 15.
    cy.get('[data-cy="question-timer"]').should('contain.text', '30s');
  });

  /*
   * The criterion itself, in a real browser: no countdown element at all, and
   * the question still unanswered after longer than any timed game would have
   * allowed. `cy.tick` is not available here (the app is not using fake
   * timers), so this waits real time — deliberately just over the 15-second
   * default, which is the deadline that would have fired.
   */
  it('never runs a countdown, or auto-answers, without a limit', () => {
    startWith('unlimited');

    cy.get('[data-cy="question-timer"]').should('not.exist');
    cy.get('[data-cy="no-time-limit"]').should('contain.text', 'No time limit');

    cy.get('[data-cy="question-text"]')
      .invoke('text')
      .then((servedQuestion) => {
        // Longer than the 15s default and its 2s auto-advance combined.
        cy.wait(18_000);
        // Same question, still unanswered: nothing expired underneath us.
        cy.get('[data-cy="question-text"]').should('have.text', servedQuestion);
        cy.get('[data-cy="result-status"]').should('not.contain.text', "Time's up");
        cy.contains('Question 1 / 5');
      });
  });

  it('carries the choice through to the board named at game over', () => {
    startWith('unlimited');
    questionsFixture.results.forEach((q) => {
      cy.answerQuestion(q.correct_answer);
    });

    cy.location('pathname').should('eq', '/game-over');
    cy.contains('Game Over!');
    cy.get('[data-cy="leaderboard-title"]').should('contain.text', 'no-limit');
  });

  /*
   * A reload test belongs here — the limit is part of the persisted game (B8),
   * so a refresh must not silently move the player onto a different board —
   * and it is deliberately NOT here yet.
   *
   * Written, it failed on `[data-cy="question-text"]`: after `cy.reload()` the
   * quiz screen does not come back at all, so the game is not being restored
   * in this environment. That is B8's resume path rather than anything this
   * feature owns, and the limit's own round trip through save and restore is
   * covered directly in `game-controller.service.spec.ts` ("carries an
   * unlimited time limit through a reload").
   *
   * It is recorded as finding B11 rather than dropped, because the useful part
   * is what the attempt revealed: no spec in this suite had ever reloaded
   * mid-game, so B8 has never been exercised in a browser at all. Whether the
   * bug is in the app or in the way a Cypress reload interacts with the
   * bootstrap restore is exactly what that finding is for.
   */
});
