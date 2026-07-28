import questionsFixture from '../../fixtures/open-trivia-questions.json';

const CORRECT_ANSWERS = questionsFixture.results.map((q) => q.correct_answer);

describe('anonymous game flow (open_trivia source)', () => {
  it('plays a full game, tracks score, and offers to sign in to save it', () => {
    cy.startGame(5);
    cy.location('pathname').should('eq', '/play');

    // First question shown, scored 0 so far.
    cy.contains('Question 1 / 5');
    cy.contains('Score: 0');

    CORRECT_ANSWERS.forEach((answer) => {
      cy.answerQuestion(answer);
    });

    cy.location('pathname').should('eq', '/game-over');
    cy.contains('Game Over!');
    cy.contains(`${CORRECT_ANSWERS.length} / ${CORRECT_ANSWERS.length}`);
    cy.contains('100%');

    // Anonymous players can view the leaderboard but are prompted to sign in
    // instead of getting a save-score form.
    cy.contains('Sign in to save this score to the leaderboard.');
    cy.contains('form', 'Save Score').should('not.exist');
    cy.contains('Top 10 Leaderboard');

    cy.contains('button', 'Play Again').click();
    cy.location('pathname').should('eq', '/');
  });

  it('only credits score for correct answers', () => {
    cy.startGame(5);

    // Miss the first question on purpose, then answer the rest correctly.
    const [, ...restCorrect] = CORRECT_ANSWERS;
    const wrongAnswer = questionsFixture.results[0].incorrect_answers[0];
    cy.answerQuestion(wrongAnswer);
    cy.contains(`Question 2 / ${CORRECT_ANSWERS.length}`);
    cy.contains('Score: 0');

    restCorrect.forEach((answer) => cy.answerQuestion(answer));

    cy.location('pathname').should('eq', '/game-over');
    cy.contains(`${restCorrect.length} / ${CORRECT_ANSWERS.length}`);
  });
});

describe('anonymous game flow (custom source)', () => {
  const customQuestions = [
    {
      id: 'q1',
      category: 'Science',
      type: 'multiple' as const,
      difficulty: 'easy' as const,
      question: 'What planet do we live on?',
      correct_answer: 'Earth',
      incorrect_answers: ['Mars', 'Venus', 'Jupiter'],
    },
    {
      id: 'q2',
      category: 'Science',
      type: 'boolean' as const,
      difficulty: 'easy' as const,
      question: 'Water boils at 100°C at sea level.',
      correct_answer: 'True',
      incorrect_answers: ['False'],
    },
  ];

  it('reads questions from the seeded Firestore question bank', () => {
    cy.seedCustomQuestions(customQuestions);
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.wait('@categories');
    cy.get('#amount').select('5');
    cy.contains('label', 'Custom').click();
    cy.contains('button', 'Start Game').click();

    cy.location('pathname').should('eq', '/play');
    // fetchCustomQuestions() shuffles question order, so don't assume which
    // of the two seeded questions renders first. Both correct answers are
    // distinct, so matching either via one regex — using Cypress's own
    // retry-and-click instead of manually reading the question text first —
    // always hits whichever question is currently showing.
    const correctAnswerPattern = new RegExp(
      customQuestions.map((q) => q.correct_answer).join('|'),
    );
    customQuestions.forEach(() => {
      cy.contains('button', correctAnswerPattern).click();
    });
    cy.location('pathname').should('eq', '/game-over');
    cy.contains('2 / 2');
  });
});
