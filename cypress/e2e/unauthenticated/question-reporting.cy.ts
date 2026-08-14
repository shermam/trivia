import questionsFixture from '../../fixtures/open-trivia-questions.json';
import { assertRadiosAreGrouped } from '../../support/a11y-assertions';

/**
 * Finding H4 — the reporting path for community questions, driven as an
 * anonymous player on purpose: most players never sign in, and the whole
 * design decision was that reporting works for them. The written document is
 * asserted through the Admin SDK (`getQuestionReports`), because clients are
 * forbidden from reading `question_reports` back — the UI saying "Reported"
 * proves nothing about the write on its own.
 */
describe('reporting a community question from game-over', () => {
  // Unique per run so concurrent CI runs never race on the same doc IDs.
  const runId = Date.now();
  const customQuestions = [
    {
      id: `report-q1-${runId}`,
      category: 'Science',
      type: 'multiple' as const,
      difficulty: 'easy' as const,
      question: 'What planet do we live on?',
      correct_answer: 'Earth',
      incorrect_answers: ['Mars', 'Venus', 'Jupiter'],
    },
    {
      id: `report-q2-${runId}`,
      category: 'Science',
      type: 'boolean' as const,
      difficulty: 'easy' as const,
      question: 'Water boils at 100°C at sea level.',
      correct_answer: 'True',
      incorrect_answers: ['False'],
    },
  ];

  function finishCustomGame(): void {
    cy.seedCustomQuestions(customQuestions);
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.wait('@categories');
    cy.get('#amount').select('5');
    cy.contains('label', 'Custom').click();
    cy.contains('button', 'Start Game').click();
    cy.location('pathname').should('eq', '/play');
    const correctAnswerPattern = new RegExp(customQuestions.map((q) => q.correct_answer).join('|'));
    customQuestions.forEach(() => {
      cy.contains('button', correctAnswerPattern).click();
    });
    cy.location('pathname').should('eq', '/game-over');
  }

  it('files a report the emulator actually holds, capped and attributed', () => {
    finishCustomGame();

    // Both community questions from this game are offered.
    cy.contains('Community questions from this game');
    customQuestions.forEach((q) => cy.contains(q.question));

    // The trigger is a disclosure and says so (CLAUDE.md §4.5).
    cy.get(`[data-cy="report-question-${customQuestions[0].id}"]`)
      .should('have.attr', 'aria-expanded', 'false')
      .click();
    cy.get(`[data-cy="report-question-${customQuestions[0].id}"]`).should(
      'have.attr',
      'aria-expanded',
      'true',
    );

    // Focus moved into the panel on open (G2 contract).
    cy.focused().should('have.id', `report-panel-${customQuestions[0].id}`);

    // The reason picker is a labelled radiogroup (G4 contract) — swept
    // generically, so a reason option added later is covered too.
    assertRadiosAreGrouped();

    cy.contains('label', 'The answer is wrong').click();
    cy.get('textarea[name="report-detail"]').type('We live on Earth, not Mars.');
    cy.get(`[data-cy="send-report-${customQuestions[0].id}"]`).click();

    // The form is replaced by the badge, and the outcome is announced.
    cy.contains('Reported');
    cy.get(`[data-cy="report-question-${customQuestions[0].id}"]`).should('not.exist');
    cy.get('[role="status"]').should('contain.text', 'Report sent');

    cy.getQuestionReports().then((reports) => {
      expect(reports).to.have.length(1);
      const report = reports[0];
      expect(report.questionId).to.equal(customQuestions[0].id);
      expect(report.reason).to.equal('incorrect');
      expect(report.detail).to.equal('We live on Earth, not Mars.');
      // The uid is the anonymous session's — unknown in advance, but the
      // document ID must carry the volume cap and end in that same uid.
      expect(report.reportedBy).to.be.a('string').and.not.be.empty;
      expect(report.id).to.match(new RegExp(`^\\d+-\\d-${report.reportedBy}$`));
      expect(report.createdAt).to.be.closeTo(Date.now(), 60_000);
    });

    // The other question is still reportable — reporting is per-question.
    cy.get(`[data-cy="report-question-${customQuestions[1].id}"]`).should('exist');
  });

  it('closes on Escape with focus restored, and writes nothing on cancel', () => {
    finishCustomGame();

    const trigger = () => cy.get(`[data-cy="report-question-${customQuestions[0].id}"]`);

    trigger().click();
    cy.focused().type('{esc}');
    trigger().should('have.attr', 'aria-expanded', 'false');
    // Focus returns to what opened the panel (G2) — losing it to <body>
    // would strand a keyboard user at the top of the page.
    cy.focused().should('have.attr', 'data-cy', `report-question-${customQuestions[0].id}`);

    trigger().click();
    cy.contains('label', 'Spam or nonsense').click();
    cy.contains('button', 'Cancel').click();
    trigger().should('have.attr', 'aria-expanded', 'false');

    cy.getQuestionReports().then((reports) => {
      expect(reports).to.have.length(0);
    });
  });

  it('offers no reporting section for a game without community questions', () => {
    cy.startGame(5);
    questionsFixture.results.forEach((q) => cy.answerQuestion(q.correct_answer));
    cy.location('pathname').should('eq', '/game-over');
    cy.contains('Game Over!');
    cy.contains('Community questions from this game').should('not.exist');
  });
});
