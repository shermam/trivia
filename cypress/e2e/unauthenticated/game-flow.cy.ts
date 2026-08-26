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
    cy.contains('Top 10 — 15-second games');

    cy.contains('button', 'Play Again').click();
    cy.location('pathname').should('eq', '/');
  });

  /**
   * The result banner must not move the card, at the only layer that can see
   * it.
   *
   * The card is vertically centred (`min-h-screen flex items-center`), so a
   * banner that appears on answering does not push the page down — it makes
   * the card taller and centring lifts the whole thing by half of that.
   * Measured before the space was reserved: the card jumped 43px at 390x1000
   * and 37px at 1024x900, right as the reader's eye went to the answer they
   * had just picked.
   *
   * **The viewport height is the whole test.** At 390x700 and 1024x800 the
   * same bug measured exactly 0px, because below a certain height the card
   * already overflows its container and is pinned to the top — so a check at a
   * convenient size would have called this fixed while it was broken. 1000px
   * is deliberately tall enough to leave centring some slack to spend.
   */
  it('does not move the card when the result banner appears', () => {
    cy.viewport(1024, 1000);
    cy.startGame(5);

    cy.get('[data-cy="result-banner"]').should('exist');

    cy.get('.max-w-xl')
      .first()
      .then(($card) => {
        const before = $card[0].getBoundingClientRect();

        cy.contains('button', CORRECT_ANSWERS[0]).click();

        // Read after the answer has actually registered, so this cannot pass by
        // measuring twice before anything changed.
        cy.get('[data-cy="result-status"]').should('contain.text', 'Correct');
        cy.get('.max-w-xl')
          .first()
          .should(($after) => {
            const after = $after[0].getBoundingClientRect();
            expect(after.height, 'card height').to.be.closeTo(before.height, 0.5);
            expect(after.top, 'card top').to.be.closeTo(before.top, 0.5);
          });
      });
  });

  /**
   * The leaderboard holds its height across the fetch, at the only layer that
   * can see it.
   *
   * It used to be a single line of "Loading leaderboard…" that became up to ten
   * rows. Measured against the compiled stylesheet that is a **508px** jump —
   * 68px to 576px — landing exactly as a player reads their final score. Ten is
   * known before the data is (it is the `limit` passed to `getTopScores`), so
   * the board is ten rows in every state: real entries, then filler rows for
   * the slots the board has not reached.
   *
   * The height is captured while the skeleton is still up and compared after
   * the rows arrive, rather than asserting a fixed number — a hard-coded 576
   * would need re-measuring every time a row's padding changed, and would pass
   * for the wrong reason if both states drifted together.
   */
  it('does not resize the leaderboard when the scores arrive', () => {
    cy.startGame(5);
    CORRECT_ANSWERS.forEach((answer) => {
      cy.answerQuestion(answer);
    });
    cy.location('pathname').should('eq', '/game-over');

    // Captured while the placeholders are still on screen.
    cy.get('[data-cy="leaderboard-skeleton"]').should('exist');
    cy.get('[data-cy="leaderboard-body"]').then(($body) => {
      const whileLoading = $body[0].getBoundingClientRect().height;

      cy.get('[data-cy="leaderboard-skeleton"]').should('not.exist');

      cy.get('[data-cy="leaderboard-body"]').should(($loaded) => {
        expect($loaded[0].getBoundingClientRect().height, 'leaderboard height').to.be.closeTo(
          whileLoading,
          0.5,
        );

        // Ten row-height boxes, whatever mix of entries and fillers they are.
        const rows = $loaded[0].querySelectorAll(
          'li, :scope > div[aria-hidden="true"]:not([data-cy="leaderboard-skeleton"])',
        );
        expect(rows.length, 'leaderboard rows').to.equal(10);
      });
    });
  });

  it('only credits score for correct answers', () => {
    cy.startGame(5);

    // Miss the first question on purpose, then answer the rest correctly.
    const [, ...restCorrect] = CORRECT_ANSWERS;
    const wrongAnswer = questionsFixture.results[0].incorrect_answers[0];
    cy.answerQuestion(wrongAnswer);
    cy.contains(`Question 2 / ${CORRECT_ANSWERS.length}`);
    cy.contains('Score: 0');

    restCorrect.forEach((answer) => {
      cy.answerQuestion(answer);
    });

    cy.location('pathname').should('eq', '/game-over');
    cy.contains(`${restCorrect.length} / ${CORRECT_ANSWERS.length}`);
  });
});

describe('anonymous game flow (custom source)', () => {
  // Unique per run so concurrent CI runs never race on the same doc IDs.
  const runId = Date.now();
  const customQuestions = [
    {
      id: `q1-${runId}`,
      category: 'Science',
      type: 'multiple' as const,
      difficulty: 'easy' as const,
      question: 'What planet do we live on?',
      correct_answer: 'Earth',
      incorrect_answers: ['Mars', 'Venus', 'Jupiter'],
    },
    {
      id: `q2-${runId}`,
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

    // How many questions the game *actually* drew, rather than assuming it is
    // the two seeded above. Against the emulator it is exactly those two, but
    // this spec also runs against the real project on the preview job, where
    // the bank holds every other custom question that exists — including any
    // a previous preview run seeded and failed to sweep, because
    // `finalCleanup` only runs from an `after()` hook and an aborted run
    // never reaches it. Hard-coding 2 made this test fail the moment that
    // count drifted, for reasons no PR's diff could explain.
    cy.contains(/Question 1 \/ \d+/)
      .invoke('text')
      .then((label) => {
        const total = Number(/\/\s*(\d+)/.exec(label)?.[1]);
        expect(total, 'questions drawn from the custom bank').to.be.greaterThan(0);

        // Whichever option is on screen — the point here is that a custom
        // game sources real questions and completes, not what it scores
        // (the open_trivia specs above own scoring).
        for (let i = 0; i < total; i++) {
          cy.get('[data-cy=answer-option]').first().click();
        }

        cy.location('pathname').should('eq', '/game-over');
        cy.contains(`/ ${total}`);
      });
  });
});
