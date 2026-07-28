import questionsFixture from '../../fixtures/open-trivia-questions.json';

const CORRECT_ANSWERS = questionsFixture.results.map((q) => q.correct_answer);

describe('verified user saves a score to the leaderboard', () => {
  const email = `player-${Date.now()}@example.com`;
  const password = 'correct horse battery staple';
  // Unique per run so concurrent CI runs (e.g. two preview deploys against
  // the same real project) never race on the same doc.
  const existingLeaderUid = `existing-leader-${Date.now()}`;

  beforeEach(() => {
    cy.createVerifiedUser({ email, password });
  });

  it('shows the save-score form once fully authenticated and records the entry', () => {
    cy.seedLeaderboardEntry({
      uid: existingLeaderUid,
      name: 'Reigning Champ',
      score: 5,
      totalQuestions: 5,
      percentage: 100,
    });

    cy.startGame(5);
    CORRECT_ANSWERS.forEach((answer) => cy.answerQuestion(answer));
    cy.location('pathname').should('eq', '/game-over');

    // Anonymous at game-over: prompted to sign in instead of the save form.
    cy.contains('Sign in to save this score to the leaderboard.');
    cy.signInFromGameOver(email, password);

    cy.get('input[name=playerName]').clear().type('Test Player');
    cy.contains('button', 'Save Score').click();

    cy.contains('Score saved to the leaderboard!');
    cy.contains('Reigning Champ');
    cy.contains('Test Player');
  });

  it('surfaces a friendly message when the new score does not beat the existing best', () => {
    cy.startGame(5);
    CORRECT_ANSWERS.forEach((answer) => cy.answerQuestion(answer));
    cy.location('pathname').should('eq', '/game-over');

    cy.signInFromGameOver(email, password);
    cy.get('input[name=playerName]').clear().type('Repeat Player');
    cy.contains('button', 'Save Score').click();
    cy.contains('Score saved to the leaderboard!');

    cy.contains('button', 'Play Again').click();
    // Replays via the app's own "Play Again" reset — no revisit — since a
    // redundant `cy.visit('/')` back to the page it's already on, right
    // after heavy Auth/Firestore activity, was flaky in CI (occasionally
    // left the auth-menu dropdown rendered open for no in-app reason).
    cy.startNewGame(5);

    // Miss the first question this time so the new attempt can't beat the
    // perfect score already on file for this uid.
    const wrongAnswer = questionsFixture.results[0].incorrect_answers[0];
    cy.answerQuestion(wrongAnswer);
    CORRECT_ANSWERS.slice(1).forEach((answer) => cy.answerQuestion(answer));
    cy.location('pathname').should('eq', '/game-over');

    cy.get('input[name=playerName]').clear().type('Repeat Player');
    cy.contains('button', 'Save Score').click();
    cy.contains('already higher');
  });
});
