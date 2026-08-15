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
   * Two things here are load-bearing:
   *
   * - The heading is read through `[data-cy=question-text]`, not `h2`. That is
   *   what makes an overrun legible: if a question auto-answers on timeout,
   *   the loop runs one iteration more than there are questions left, and this
   *   selector simply does not exist on `/game-over` — so it fails saying so.
   *   `h2` matches three elements there (the leaderboard, the flagged card,
   *   the dialog) and jQuery's `.text()` silently *concatenates* a
   *   multi-element match, which produced "Top 10 Leaderboard is not one of
   *   the seeded ones" and sent the reader to the seeding task.
   * - The `should` retries until the heading has moved on from the question
   *   just answered. The quiz holds an answered question on screen for two
   *   seconds before advancing, so a bare `.then()` can resolve against it and
   *   then sit waiting for options that are already disabled. Asserting is
   *   retriable; reading is not.
   */
  function playRemainingQuestions(flagIds: string[] = []): void {
    const flagged = new Set(flagIds);
    const answered = new Set<string>();

    customQuestions.forEach(() => {
      cy.get('[data-cy="question-text"]')
        .should((heading) =>
          expect(
            answered.has(heading.text().trim()),
            `a question other than the ${answered.size} already answered is on screen`,
          ).to.equal(false),
        )
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
    // Anchored on something that only exists once the component has rendered.
    // Every `should('not.exist')` after this would otherwise be free to pass
    // against the empty `<app-game-over>` that exists between the router
    // committing the URL and the next change-detection tick — this app is
    // zoneless, so that tick is a scheduled callback, not a synchronous one.
    cy.contains('Game Over!');
  }

  function finishCustomGame(flagIds: string[] = []): void {
    startCustomGame();
    playRemainingQuestions(flagIds);
  }

  /**
   * Dispatches a Tab (or Shift+Tab) keydown from whatever currently has focus,
   * and asserts the dialog's handler cancelled it.
   *
   * Fired from the focused element rather than from the dialog, because the
   * handler branches on `document.activeElement` — and asserting
   * `defaultPrevented` is the half that a focus assertion cannot cover, since
   * a synthetic key event performs no native focus move of its own.
   */
  function pressTabInDialog({ shift }: { shift: boolean }): void {
    cy.focused().then(($el) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: shift,
        bubbles: true,
        cancelable: true,
      });
      $el[0].dispatchEvent(event);
      expect(
        event.defaultPrevented,
        `${shift ? 'Shift+' : ''}Tab was cancelled by the trap`,
      ).to.equal(true);
    });
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
    // Driven with hand-built keydowns rather than `cy.press`, for two reasons.
    // `cy.press` takes no modifier option, so it cannot express Shift+Tab —
    // the direction that matters most, since it is the one that escapes
    // backwards past the dialog's first control. And dispatching the event
    // ourselves is the only way to read `defaultPrevented` afterwards: a
    // synthetic keydown performs no native focus move, so a handler that
    // called `.focus()` but dropped `preventDefault()` would land focus in
    // exactly the right place here while a *real* Tab escaped the dialog on
    // top of it. Asserting where focus went is not enough on its own.
    //
    // The last control is read from the DOM rather than assumed to be
    // `customQuestions[1]`: the bank is served in an order this test does not
    // control. It is the last focusable only because no report form is open
    // and nothing is reported yet — opening a form would append its radios,
    // textarea and buttons after it.
    cy.get('[data-cy="report-dialog"] [data-cy^="report-question-"]')
      .last()
      .invoke('attr', 'data-cy')
      .then((lastTrigger) => {
        pressTabInDialog({ shift: true });
        cy.focused().should('have.attr', 'data-cy', lastTrigger);

        pressTabInDialog({ shift: false });
        cy.focused().should('have.attr', 'data-cy', 'close-report-dialog');

        // ...and Shift+Tab again, this time from the dialog's *first* control
        // rather than from the dialog element. That is the branch real use
        // hits on every keystroke after the first, and it is a different arm
        // of the same condition.
        pressTabInDialog({ shift: true });
        cy.focused().should('have.attr', 'data-cy', lastTrigger);
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
    // `cy.startGame` now waits for the quiz loop to be *rendered*, not merely
    // for the questions response. That matters here more than anywhere else in
    // the suite: this test's assertions are all negative, and before that
    // change `should('not.exist')` passed on its first poll against the setup
    // screen — staying green even with the `source === 'custom'` guard deleted
    // and a flag rendered on every question.
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
