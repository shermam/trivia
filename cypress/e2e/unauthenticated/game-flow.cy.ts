import questionsFixture from '../../fixtures/open-trivia-questions.json';

const CORRECT_ANSWERS = questionsFixture.results.map((q) => q.correct_answer);

/**
 * How long the leaderboard query is held open so its loading state is
 * observable. Comfortably longer than Cypress's 50ms retry interval and than
 * the ~35ms the skeleton lives for unaided, and short enough to cost the suite
 * nothing that matters.
 */
const LEADERBOARD_HOLD_MS = 500;

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
    //
    // `be.visible` / `not.be.visible` rather than exists / does not exist: the
    // card's five faces all live in one grid cell so that its height cannot
    // change with its state, which means every face is in the DOM at all
    // times. `not.exist` would now fail outright, and — the half worth
    // watching — a bare `cy.contains` would go on *passing vacuously* against
    // a face nobody can see (`CLAUDE.md` §4.6).
    cy.contains('Sign in to save this score to the leaderboard.').should('be.visible');
    cy.contains('form', 'Save Score').should('not.be.visible');
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
   * Every face of the score card is the same height, which is what stops the
   * page moving when auth resolves.
   *
   * The card has five states — sign in, verify, save, saved, save failed — and
   * which one shows is decided by auth arriving. Measured before the fix at
   * 390x1000: sign-in 146px, verify 148px, save form 192px. So a returning
   * player who could actually save watched the leaderboard drop **46px** the
   * moment auth resolved, and a signed-out one was shown the verify prompt
   * first and then the sign-in prompt, for a 2px twitch on top of being told
   * about a problem they did not have.
   *
   * **390 wide is the whole test.** At 1024 the same three measured 122 / 124 /
   * 120 — a 4px spread — because the save form only stacks its input above its
   * button below `sm`. Checking this at a desktop viewport would have called it
   * near enough while a phone was moving half a card.
   *
   * Asserted face-by-face against the cell rather than by driving the app
   * through all five states: they share one grid cell, so equal face heights
   * *is* the property. It also means an anonymous game — the cheapest thing
   * this suite can set up — can prove something about the signed-in states.
   */
  it('gives every face of the score card the same height', () => {
    cy.viewport(390, 1000);
    cy.startGame(5);
    CORRECT_ANSWERS.forEach((answer) => {
      cy.answerQuestion(answer);
    });
    cy.location('pathname').should('eq', '/game-over');

    cy.get('[data-cy="score-action"]').should(($card) => {
      const cell = $card[0].getBoundingClientRect().height;
      const faces = [...$card[0].children];

      expect(faces.length, 'faces stacked in the cell').to.equal(5);
      expect(cell, 'card collapsed').to.be.greaterThan(0);
      faces.forEach((face) => {
        expect(
          face.getBoundingClientRect().height,
          `face ${face.getAttribute('data-cy')} differs from the reserved height`,
        ).to.be.closeTo(cell, 0.5);
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
   *
   * **The loading state has to be held open, or catching it is a coin flip.**
   * `isLoadingLeaderboard` flips the moment `getTopScores` resolves, and
   * against the local Firestore emulator that is fast: instrumented in
   * Chromium with a `MutationObserver`, the skeleton's real lifetime is
   * **30–38ms**, against a Cypress retry interval of 50ms. So the assertion
   * below was never testing the leaderboard — it was testing whether a poll
   * happened to land inside a window narrower than the gap between polls. It
   * failed that way twice on `main` before this intercept existed (runs
   * 33018692994 and 33095985892), both times with the same
   * "Expected to find element: `[data-cy="leaderboard-skeleton"]`".
   *
   * Holding the response makes the loading state deterministic rather than
   * lucky. **It does not weaken anything**: the assertions are unchanged, the
   * fetch is real, and the board still has to hold its height across a real
   * load — the delay only guarantees there is a loading state to measure.
   * Measured with the hold in place: 576px loading, 576px loaded.
   *
   * Note this is emulator-specific in origin but applied unconditionally. The
   * preview suite runs the same spec against a real project, where network
   * latency made the window wide enough that it never failed — but a fix that
   * only works where the bug happens to be visible is one environment away
   * from being no fix at all.
   */
  it('does not resize the leaderboard when the scores arrive', () => {
    // Host-agnostic on purpose: emulator and production Firestore differ in
    // origin but not in this path. `req.continue` is a passthrough, so the
    // real response is still what the board renders.
    cy.intercept({ method: 'POST', url: /\/leaderboards\/[^/]+:runQuery/ }, (req) => {
      req.continue((res) => {
        res.setDelay(LEADERBOARD_HOLD_MS);
      });
    }).as('topScores');

    cy.startGame(5);
    CORRECT_ANSWERS.forEach((answer) => {
      cy.answerQuestion(answer);
    });
    cy.location('pathname').should('eq', '/game-over');

    // Captured while the placeholders are still on screen.
    cy.get('[data-cy="leaderboard-skeleton"]').should('exist');
    cy.get('[data-cy="leaderboard-body"]').then(($body) => {
      const whileLoading = $body[0].getBoundingClientRect().height;

      cy.wait('@topScores');
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

  /**
   * `FEAT-001`. The recap is the one part of game-over built from state the
   * player produced *on a different screen*, so the thing worth testing here
   * is the handoff: five answers given at `/play`, five rows rendered at
   * `/game-over`, each showing the option that was actually clicked.
   *
   * A wrong answer and a *correct* one, deliberately — the unit tests cover
   * every branch, but only a real run proves the ids recorded during play are
   * the same ids the recap resolves against afterwards, which is the whole
   * mechanism and the part no stub can vouch for.
   */
  it('recaps every answer of the round, right and wrong alike', () => {
    cy.startGame(5);

    const wrongAnswer = questionsFixture.results[0].incorrect_answers[0];
    cy.answerQuestion(wrongAnswer);
    const [, ...restCorrect] = CORRECT_ANSWERS;
    restCorrect.forEach((answer) => {
      cy.answerQuestion(answer);
    });

    cy.location('pathname').should('eq', '/game-over');

    // Collapsed by default, and the header carries the tally.
    cy.get('[data-cy="recap-toggle"]')
      .should('contain', 'Review answers')
      .and('contain', `(4/5 correct)`)
      .and('have.attr', 'aria-expanded', 'false');
    cy.get('[data-cy="recap-panel"]').should('not.exist');

    cy.get('[data-cy="recap-toggle"]').click();
    cy.get('[data-cy="recap-toggle"]').should('have.attr', 'aria-expanded', 'true');
    cy.get('[data-cy="recap-row"]').should('have.length', 5);

    // The missed question shows what was picked *and* what was right; the
    // rest show only the pick, which is the same string either way.
    cy.get('[data-cy="recap-row"]')
      .first()
      .within(() => {
        cy.contains(questionsFixture.results[0].question);
        cy.get('[data-cy="recap-picked"]').should('contain', wrongAnswer);
        cy.get('[data-cy="recap-correct"]').should('contain', CORRECT_ANSWERS[0]);
      });

    cy.get('[data-cy="recap-row"]')
      .eq(1)
      .within(() => {
        cy.get('[data-cy="recap-picked"]').should('contain', CORRECT_ANSWERS[1]);
        cy.get('[data-cy="recap-correct"]').should('not.exist');
      });

    // Nothing timed out — every question was answered well inside 15s.
    cy.get('[data-cy="recap-timed-out"]').should('not.exist');

    cy.get('[data-cy="recap-toggle"]').click();
    cy.get('[data-cy="recap-panel"]').should('not.exist');
  });

  /**
   * The recap grows on purpose — but it must grow **downwards**, and nothing
   * about that is guaranteed by where it sits in the template.
   *
   * The game-over card is vertically centred (`min-h-screen flex items-center`),
   * so anything that makes it taller can lift the whole thing: that is exactly
   * how the result banner moved the card 43px
   * ([#128](https://github.com/shermam/trivia/pull/128)). `CLAUDE.md` §4.4 asks
   * for the assertion to live where a real layout exists, which is here — jsdom
   * has no layout and Lighthouse only loads `/`.
   *
   * **This is also the measurement behind the placement decision.** `FEAT-001`
   * asked for the recap "directly below the score summary"; #137 put it after
   * the leaderboard instead. Hoisting the card back above the score summary in
   * a real browser and running exactly this measurement moves the score card
   * and the leaderboard **545px** at 1024×1000, against **0px** as shipped — so
   * the deviation is a measured one rather than an argued one, and this test is
   * what would notice it being undone.
   *
   * Two details the reading depends on. It is **document-relative**
   * (`top + scrollY`), because scrolling the toggle into view would otherwise
   * be measured as layout. And the leaderboard is awaited first: its own
   * arrival is a 508px change of its own, and catching it mid-flight would
   * attribute that to the recap.
   *
   * `FEAT-046` (the deferred open/close transition, `known-gaps.md`) is the
   * change most likely to break this: the only way to animate to an `auto`
   * height is an always-mounted panel with `grid-template-rows: 0fr → 1fr`,
   * which alters what the collapsed card contributes to the stack.
   */
  it('does not move anything above it when the recap expands', () => {
    cy.viewport(1024, 1000);
    cy.startGame(5);
    CORRECT_ANSWERS.forEach((answer) => {
      cy.answerQuestion(answer);
    });
    cy.location('pathname').should('eq', '/game-over');

    // Settle the board first — see above.
    cy.get('[data-cy="leaderboard-skeleton"]').should('not.exist');
    cy.get('[data-cy="recap-toggle"]').scrollIntoView();

    const WATCHED = ['score-action', 'leaderboard-body', 'recap-toggle'] as const;
    const tops = (win: Cypress.AUTWindow) =>
      Object.fromEntries(
        WATCHED.map((name) => [
          name,
          Math.round(
            win.document.querySelector(`[data-cy="${name}"]`)!.getBoundingClientRect().top +
              win.scrollY,
          ),
        ]),
      );

    cy.window().then((win) => {
      const before = tops(win);

      cy.get('[data-cy="recap-toggle"]').click();
      cy.get('[data-cy="recap-panel"]').should('exist');

      // One retrying callback over all three, rather than three chained
      // `should`s — they retry together and the subject never moves
      // (`CLAUDE.md` §4.6).
      cy.window().should((after) => {
        expect(
          tops(after),
          'expanding the recap must not move the score card, the leaderboard, or the toggle itself',
        ).to.deep.equal(before);
      });
    });
  });

  /**
   * `FEAT-002`. The lifelines are three interactions the unit layer can only
   * check in pieces — jsdom has no real click-to-disable, and the ids recorded
   * during play are only proved to match the recap by a real round.
   */
  it('spends each lifeline once, and a skip reads as skipped at game over', () => {
    cy.startGame(5);

    // All three offered on a timed game, none spent.
    cy.get('[data-cy="lifelines"]').should('have.attr', 'aria-label', 'Lifelines');
    cy.get('[data-cy="lifeline-fiftyFifty"]').should('not.be.disabled');
    cy.get('[data-cy="lifeline-extraTime"]').should('not.be.disabled');
    cy.get('[data-cy="lifeline-skip"]').should('not.be.disabled');

    // 50/50 removes two of the four options and cannot be used twice.
    cy.get('[data-cy="answer-option"]').should('have.length', 4);
    cy.get('[data-cy="lifeline-fiftyFifty"]').click();
    cy.get('[data-cy="answer-option"][data-eliminated]').should('have.length', 2);
    // The options stay in the DOM — the grid must not collapse under the
    // player's cursor (`CLAUDE.md` §4.4).
    cy.get('[data-cy="answer-option"]').should('have.length', 4);
    cy.get('[data-cy="lifeline-fiftyFifty"]').should('be.disabled');

    // Answer the first question with a surviving option.
    cy.get('[data-cy="answer-option"]:not([data-eliminated])').first().click();
    cy.contains(`Question 2 / 5`);
    // Spent for the round, not just for that question.
    cy.get('[data-cy="lifeline-fiftyFifty"]').should('be.disabled');
    // ...and the elimination does not follow us to the next question.
    cy.get('[data-cy="answer-option"][data-eliminated]').should('not.exist');

    // Skip advances immediately — no result banner, no 2s wait.
    cy.get('[data-cy="lifeline-skip"]').click();
    cy.contains('Question 3 / 5');
    cy.get('[data-cy="lifeline-skip"]').should('be.disabled');

    // Extra time is spendable once.
    cy.get('[data-cy="lifeline-extraTime"]').click();
    cy.get('[data-cy="lifeline-extraTime"]').should('be.disabled');

    // Finish the round.
    cy.get('[data-cy="answer-option"]').first().click();
    cy.contains('Question 4 / 5');
    cy.get('[data-cy="answer-option"]').first().click();
    cy.contains('Question 5 / 5');
    cy.get('[data-cy="answer-option"]').first().click();

    cy.location('pathname').should('eq', '/game-over');

    // The skipped question reads as skipped, not as a timeout — and it still
    // counts, so the recap has all five rows.
    cy.get('[data-cy="recap-toggle"]').click();
    cy.get('[data-cy="recap-row"]').should('have.length', 5);
    cy.get('[data-cy="recap-skipped"]').should('have.length', 1);
    cy.get('[data-cy="recap-timed-out"]').should('not.exist');
    cy.get('[data-cy="recap-row"]')
      .eq(1)
      .within(() => {
        cy.get('[data-cy="recap-picked"]').should('contain', 'You skipped this');
      });
  });

  // A skip must not shrink the denominator — see `registerSkippedQuestion`.
  it('counts a skipped question in the score denominator', () => {
    cy.startGame(5);

    cy.get('[data-cy="lifeline-skip"]').click();
    cy.contains('Question 2 / 5');
    const [, ...rest] = CORRECT_ANSWERS;
    rest.forEach((answer) => {
      cy.answerQuestion(answer);
    });

    cy.location('pathname').should('eq', '/game-over');
    // Four right out of five, not four out of four.
    cy.contains('4 / 5');
    cy.contains('80%');
  });

  // Hidden rather than disabled, because there is no countdown to extend.
  it('offers no Extra Time on an unlimited game', () => {
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.wait('@categories');
    cy.get('#amount').select('5');
    cy.get('[data-cy="time-limit-unlimited"]').click({ force: true });
    cy.contains('button', 'Start Game').click();
    cy.wait('@questions');
    cy.get('[data-cy="question-text"]').should('be.visible');

    cy.get('[data-cy="lifeline-extraTime"]').should('not.exist');
    cy.get('[data-cy="lifeline-fiftyFifty"]').should('exist');
    cy.get('[data-cy="lifeline-skip"]').should('exist');
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
