import questionsFixture from '../../fixtures/open-trivia-questions.json';
import { assertRadiosAreGrouped } from '../../support/a11y-assertions';

/**
 * Finding H4 — the reporting path for community questions, driven as an
 * anonymous player on purpose: most players never sign in, and the whole
 * design decision was that reporting works for them. The written document is
 * asserted through the Admin SDK (`getQuestionReports`), because clients are
 * forbidden from reading `question_reports` back — the UI saying "Reported"
 * proves nothing about the write on its own.
 *
 * Reporting starts *during* the game: a flag on the question the player is
 * looking at, and game-over then leads with what they flagged. The dialog is
 * the escape hatch for "I noticed but didn't flag it", so it lists everything.
 */
describe('reporting a community question', () => {
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

  function startCustomGame(): void {
    cy.seedCustomQuestions(customQuestions);
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.wait('@categories');
    cy.get('#amount').select('5');
    cy.contains('label', 'Custom').click();
    cy.contains('button', 'Start Game').click();
    cy.location('pathname').should('eq', '/play');
  }

  /**
   * Plays the rest of the game from whatever question is on screen, flagging
   * the ones whose ids are in `flagIds`.
   *
   * The bank is served in an order this test does not control, so each
   * question is identified from the DOM rather than by position — flagging by
   * index would flag whichever question happened to come up, and pass anyway.
   *
   * The `should` is what makes reading the heading safe. The quiz holds the
   * answered question on screen for two seconds before advancing, so a bare
   * `.then()` can resolve against the question just answered and then sit
   * waiting for its now-disabled options. Asserting the heading has moved on
   * is retriable; reading it is not.
   */
  function playRemainingQuestions(flagIds: string[] = []): void {
    const flagged = new Set(flagIds);
    const answered = new Set<string>();

    customQuestions.forEach(() => {
      cy.get('h2')
        .should((heading) => expect(answered.has(heading.text().trim())).to.equal(false))
        .invoke('text')
        .then((text) => {
          const served = text.trim();
          const onScreen = customQuestions.find((q) => q.question === served);
          if (!onScreen) {
            throw new Error(`Served question "${served}" is not one of the seeded ones`);
          }
          answered.add(served);
          if (flagged.has(onScreen.id)) {
            cy.get('[data-cy="flag-question"]').click();
          }
          cy.contains('[data-cy="answer-option"]', onScreen.correct_answer).click();
        });
    });

    cy.location('pathname').should('eq', '/game-over');
  }

  function finishCustomGame(flagIds: string[] = []): void {
    startCustomGame();
    playRemainingQuestions(flagIds);
  }

  it('flags a question mid-game and files the report the emulator holds', () => {
    finishCustomGame([customQuestions[0].id]);

    // Game-over leads with the flagged question — and only that one. The
    // second community question is behind the dialog, not on the page.
    cy.contains('Questions you flagged');
    cy.contains(customQuestions[0].question);
    cy.get(`[data-cy="report-question-${customQuestions[1].id}"]`).should('not.exist');

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
    cy.get('[data-cy="report-status"]').should('contain.text', 'Report sent');
    // The trigger focus would normally be restored is gone (the badge
    // replaced it), so the badge itself must catch focus — otherwise the
    // happy path strands a keyboard user at <body> (G2 contract; found by
    // review, not by the original suite).
    cy.focused().should('have.attr', 'data-cy', `reported-badge-${customQuestions[0].id}`);

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
  });

  // The flag is the entire promise that reporting is coming, so the state it
  // shows has to survive the rest of the game — and be conveyed by more than
  // colour (WCAG 1.4.1), which is why `aria-pressed` and the notice are
  // asserted rather than the red fill.
  it('announces the flag and lets the player take it back', () => {
    startCustomGame();

    cy.get('[data-cy="flag-question"]').should('have.attr', 'aria-pressed', 'false');
    cy.get('[data-cy="flag-notice"]').should('not.exist');

    cy.get('[data-cy="flag-question"]').click();
    cy.get('[data-cy="flag-question"]').should('have.attr', 'aria-pressed', 'true');
    cy.get('[data-cy="flag-notice"]').should('contain.text', 'end of the game');
    // The announcement names the question's position, and that is the point of
    // it: two flags in one game must produce two *different* strings, or the
    // second is a no-op set on a signal and the live region never announces
    // it. Asserted verbatim rather than by keyword for the same reason.
    cy.get('[data-cy="flag-status"]').should('contain.text', 'Question 1 flagged');

    // Un-flagging is the same control, and clears the promise with it —
    // including the announcement, which must empty rather than linger.
    cy.get('[data-cy="flag-question"]').click();
    cy.get('[data-cy="flag-question"]').should('have.attr', 'aria-pressed', 'false');
    cy.get('[data-cy="flag-notice"]').should('not.exist');
    // Matched against whitespace rather than compared to '': the region is a
    // permanent element (G3) whose interpolation sits on its own line, so its
    // textContent is never the empty string even when it says nothing.
    cy.get('[data-cy="flag-status"]').invoke('text').should('match', /^\s*$/);

    // ...and game-over honours that: nothing flagged, nothing led with.
    playRemainingQuestions();
    cy.contains('Questions you flagged').should('not.exist');
  });

  it('offers every community question through the dialog, trapped and dismissible', () => {
    finishCustomGame();

    cy.contains('Questions you flagged').should('not.exist');
    cy.get('[data-cy="open-report-dialog"]')
      .should('have.attr', 'aria-haspopup', 'dialog')
      .should('have.attr', 'aria-expanded', 'false')
      .click();

    // Everything from the game is offered here, flagged or not.
    cy.get('[data-cy="report-dialog"]').within(() => {
      customQuestions.forEach((q) => cy.contains(q.question));
    });

    // Focus lands on the dialog itself, so it is announced with its title
    // before Tab reaches the close button (G2 contract).
    cy.focused().should('have.attr', 'data-cy', 'report-dialog');

    // `aria-modal="true"` is a promise; the trap is what keeps it true for
    // sighted keyboard users, who are not covered by that attribute at all.
    //
    // Driven with synthetic keydowns rather than `cy.press`, which has no
    // modifier option and so cannot express Shift+Tab — the direction that
    // matters most here, since it is the one that escapes backwards past the
    // dialog's first control. The handler is what implements the wrap either
    // way: if it did nothing, focus would simply stay put and these fail.
    //
    // The last control is read from the DOM, not assumed to be
    // `customQuestions[1]`: the bank is served in an order this test does not
    // control, so the dialog lists the two questions in either order.
    cy.get('[data-cy="report-dialog"] [data-cy^="report-question-"]')
      .last()
      .invoke('attr', 'data-cy')
      .then((lastTrigger) => {
        cy.get('[data-cy="report-dialog"]').trigger('keydown', {
          key: 'Tab',
          shiftKey: true,
          cancelable: true,
        });
        cy.focused().should('have.attr', 'data-cy', lastTrigger);

        cy.focused().trigger('keydown', { key: 'Tab', cancelable: true, bubbles: true });
        cy.focused().should('have.attr', 'data-cy', 'close-report-dialog');
      });

    // From the control that has focus, not the dialog element — Escape has to
    // reach the handler by bubbling, which is how a real user produces it.
    cy.focused().type('{esc}');
    cy.get('[data-cy="report-dialog"]').should('not.exist');
    // Closing returns focus to the button that opened it.
    cy.focused().should('have.attr', 'data-cy', 'open-report-dialog');

    cy.getQuestionReports().then((reports) => {
      expect(reports).to.have.length(0);
    });
  });

  it('closes the report form on Escape with focus restored, and writes nothing on cancel', () => {
    finishCustomGame([customQuestions[0].id]);

    const trigger = () => cy.get(`[data-cy="report-question-${customQuestions[0].id}"]`);

    trigger().click();
    // Wait for the focus-move effect before typing: right after the click,
    // focus is still on the trigger (which has no Escape handler), and
    // Angular's effect only moves it into the panel after render. Typing
    // into cy.focused() without this retriable assertion races that effect.
    cy.focused().should('have.id', `report-panel-${customQuestions[0].id}`);
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

  it('offers no reporting at all for a game without community questions', () => {
    cy.startGame(5);
    // An Open Trivia DB question is not ours to moderate, so it gets no flag
    // either — the affordance is absent from the quiz loop, not just disabled.
    cy.get('[data-cy="flag-question"]').should('not.exist');
    questionsFixture.results.forEach((q) => cy.answerQuestion(q.correct_answer));
    cy.location('pathname').should('eq', '/game-over');
    cy.contains('Game Over!');
    cy.contains('Questions you flagged').should('not.exist');
    cy.get('[data-cy="open-report-dialog"]').should('not.exist');
  });
});
