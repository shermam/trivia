import questionsFixture from '../../fixtures/open-trivia-questions.json';

const CORRECT_ANSWERS = questionsFixture.results.map((q) => q.correct_answer);

describe('verified user saves a score to the leaderboard', () => {
  // Computed fresh in `beforeEach` (not once at describe-scope) — this file
  // has two `it`s sharing this hook, and against the real preview backend
  // (cypress.preview.config.ts) there's no reset between them: a second
  // `createVerifiedUser` call with the same, already-created email would
  // deterministically fail with "email address already in use". Against the
  // emulator this never mattered since `resetBackend()` wipes every user
  // before each test anyway.
  let email: string;
  const password = 'correct horse battery staple';
  // Unique per run so concurrent CI runs (e.g. two preview deploys against
  // the same real project) never race on the same doc.
  const existingLeaderUid = `existing-leader-${Date.now()}`;

  beforeEach(() => {
    email = `player-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
    CORRECT_ANSWERS.forEach((answer) => {
      cy.answerQuestion(answer);
    });
    cy.location('pathname').should('eq', '/game-over');

    // Anonymous at game-over: prompted to sign in instead of the save form.
    // `be.visible`, because every face of the card is always in the DOM — see
    // the height test in `game-flow.cy.ts`.
    cy.contains('Sign in to save this score to the leaderboard.').should('be.visible');

    // The same card, measured across a real auth transition rather than
    // face-by-face. Only a couple of pixels are at stake at this viewport, so
    // the load-bearing version of this assertion is the mobile one in
    // `game-flow.cy.ts`; this is the end-to-end confirmation that the states
    // the app actually reaches behave like the boxes that reserve them.
    let signedOutHeight = 0;
    cy.get('[data-cy="score-action"]').then(($card) => {
      signedOutHeight = $card[0].getBoundingClientRect().height;
    });

    cy.signInFromGameOver(email, password);

    // Closing the menu returns focus to whatever opened it — here game-over's
    // own "Sign in" button, which signing in has just hidden rather than
    // removed, because the card's faces are stacked and only toggle
    // `visibility`. `focus()` on a hidden element is a silent no-op that drops
    // focus to `<body>`, so without the visibility check in `TopBarComponent`
    // a keyboard user loses their place with nothing logged anywhere. jsdom
    // enforces neither half of that, which is why this assertion is here and
    // not in the unit spec.
    cy.focused().should('have.attr', 'data-cy', 'auth-menu-trigger');

    cy.get('[data-cy="score-save"]').should('be.visible');
    cy.get('[data-cy="score-action"]').should(($card) => {
      expect(
        $card[0].getBoundingClientRect().height,
        'card height moved when auth resolved',
      ).to.be.closeTo(signedOutHeight, 0.5);
    });

    // G6: the leaderboard name is data about the user (the `nickname`
    // purpose), so a browser can prefill it from the profile it knows.
    cy.get('input[name=playerName]').should('have.attr', 'autocomplete', 'nickname');
    cy.get('input[name=playerName]').clear().type('Test Player');
    cy.contains('button', 'Save Score').click();

    cy.get('[data-cy="score-saved"]').should('be.visible');
    cy.get('[data-cy="score-action"]').should(($card) => {
      expect(
        $card[0].getBoundingClientRect().height,
        'card height moved when the score saved',
      ).to.be.closeTo(signedOutHeight, 0.5);
    });
    cy.contains('Reigning Champ');
    cy.contains('Test Player');
  });

  it('surfaces a friendly message when the new score does not beat the existing best', () => {
    cy.startGame(5);
    CORRECT_ANSWERS.forEach((answer) => {
      cy.answerQuestion(answer);
    });
    cy.location('pathname').should('eq', '/game-over');

    cy.signInFromGameOver(email, password);
    cy.get('input[name=playerName]').clear().type('Repeat Player');
    cy.contains('button', 'Save Score').click();
    cy.get('[data-cy="score-saved"]').should('be.visible');

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
    CORRECT_ANSWERS.slice(1).forEach((answer) => {
      cy.answerQuestion(answer);
    });
    cy.location('pathname').should('eq', '/game-over');

    cy.get('input[name=playerName]').clear().type('Repeat Player');
    cy.contains('button', 'Save Score').click();
    cy.contains('already higher');
  });
});
