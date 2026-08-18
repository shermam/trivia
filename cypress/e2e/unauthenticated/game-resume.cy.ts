/**
 * Finding B8's resume path, in a browser — which, until finding B11, nothing
 * covered. The unit suites verify that `GamePersistenceService` round-trips a
 * game and that `GameControllerService` reads it back, but neither can show
 * that a real page load restores one, and that is the entire promise B8 makes:
 * a refresh, a tab crash or a PWA relaunch does not cost you the game.
 *
 * This spec is what found **B11**, and the staging is why it could: a failure
 * says *where* the game was lost rather than only that it was.
 *
 *   1. persisted before the reload  → the write landed at all
 *   2. still persisted after it     → the record survived the page load
 *   3. quiz rendered                → bootstrap actually restored it
 *
 * (1) and (2) passed and (3) failed, which located the bug between storage and
 * the signals: the record was there and the app would not take it. It was
 * being *rejected* on read — `GameConfig.amount` is declared `number`, the
 * setup form's `<select>` was writing the string `"5"` into it, and
 * `parseSavedGame` type-checks that field. The reader was right; the writer
 * was wrong. See `game-setup.component.spec.ts`.
 *
 * **`cy.startGame(5)` is load-bearing, not incidental.** It picks a question
 * count through the real `<select>`, which is what produced the bad value; the
 * form's *default* stayed a genuine number, so a version of this test that
 * never touched that control would have passed against the bug. Whatever else
 * changes here, keep something that chooses a non-default amount.
 *
 * Kept staged rather than collapsed into one assertion, because the next
 * regression here will not necessarily be the same one.
 */

import questionsFixture from '../../fixtures/open-trivia-questions.json';

const CORRECT_ANSWERS = questionsFixture.results.map((q) => q.correct_answer);

const DB_NAME = 'trivia-offline';
const STORE = 'game-state';
const KEY = 'current';

/**
 * Reads the persisted game straight out of IndexedDB in the app's own window.
 *
 * Opened without a version on purpose: naming one risks triggering an upgrade
 * from the test, and this only ever reads. A database that does not exist yet
 * is created empty by `open`, which is why the store is checked before the
 * transaction rather than assumed.
 */
function readSavedGame(win: Window): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const open = win.indexedDB.open(DB_NAME);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.close();
        resolve(null);
        return;
      }
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      request.onsuccess = () => {
        db.close();
        resolve((request.result as Record<string, unknown>) ?? null);
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    };
  });
}

describe('resuming a game after a reload (B8)', () => {
  it('restores the in-progress game when the page is reloaded', () => {
    cy.startGame(5);

    // The persisting effect queues an async write with no observable "landed"
    // signal, so reloading immediately would be racing it rather than testing
    // the feature. Asserting the record exists is what makes the wait honest.
    cy.window()
      .then((win) => readSavedGame(win))
      .should((saved) => {
        expect(saved, 'a game is persisted before the reload').to.not.equal(null);
      });

    cy.reload();

    cy.window()
      .then((win) => readSavedGame(win))
      .should((saved) => {
        expect(saved, 'the persisted game survives the page load').to.not.equal(null);
      });

    // Anchored on the quiz itself, not on the URL: after a reload the URL is
    // already /play, so a pathname assertion passes before Angular boots and
    // keeps passing if the guard then redirects to /.
    cy.get('[data-cy="question-text"]').should('be.visible');
    // The count as well as the screen. It is the field that was corrupted, so
    // a restore that came back with the wrong one would still be a failure.
    cy.contains('Question 1 / 5');
  });
});

/**
 * The rest of B8's persistence, which the single test above does not reach.
 *
 * That test reloads `/play`. One test was the right size for a bug fix; it is
 * the wrong size for the feature, and every path below goes through the same
 * stored record by a route nothing exercised:
 *
 * - a **completed** game reloaded on `/game-over` — persisted deliberately, so
 *   a refresh does not lose a score that is about to be submitted;
 * - the **setup screen's banner**, which is what a PWA relaunch or a tap on the
 *   logo actually reaches, because both land on `/` rather than `/play`;
 * - **Discard**, which has to remove the record and not just the banner;
 * - **flags**, which are in the snapshot (`flaggedQuestionIds`) and had no
 *   round-trip test of their own.
 *
 * `parseSavedGame` *clears* the record when it rejects it, which is what made
 * B11 destructive rather than merely broken. So every one of these is a path
 * along which a future validation change can silently delete a player's game,
 * and none of them had a browser-level test.
 */
describe('reloading a finished game on /game-over (B8)', () => {
  it('keeps the completed game, and the score waiting to be submitted', () => {
    cy.startGame(5);
    CORRECT_ANSWERS.forEach((answer) => {
      cy.answerQuestion(answer);
    });

    cy.location('pathname').should('eq', '/game-over');
    cy.contains('Game Over!');
    cy.contains(`${CORRECT_ANSWERS.length} / ${CORRECT_ANSWERS.length}`);

    cy.window()
      .then((win) => readSavedGame(win))
      .should((saved) => {
        expect(saved, 'a finished game is persisted too').to.not.equal(null);
        expect(saved?.['isComplete'], 'and is stored as finished').to.equal(true);
      });

    cy.reload();

    // Anchored on rendered content, never on the URL: `/game-over` is already
    // the pathname after a reload, so a location assertion passes before
    // Angular boots and keeps on passing if `hasCompletedGameGuard` then
    // sends the player home.
    cy.contains('Game Over!');
    cy.contains(`${CORRECT_ANSWERS.length} / ${CORRECT_ANSWERS.length}`);
    cy.get('[data-cy="leaderboard-title"]').should('be.visible');
  });

  it('does not offer a finished game as one to resume', () => {
    cy.startGame(5);
    CORRECT_ANSWERS.forEach((answer) => {
      cy.answerQuestion(answer);
    });
    cy.contains('Game Over!');

    // A fresh load of `/`, so the banner's only possible source is IndexedDB.
    cy.visit('/');

    // Positive anchor before the negative assertion — `should('not.exist')` is
    // satisfied by a page that has not rendered yet (`docs/ci-cd.md` §4.3).
    cy.get('#amount').should('be.visible');
    // `hasResumableGame()` is `totalQuestions() > 0 && !isComplete()`. The
    // record is still there — the test above proves that — and it is still
    // deliberately not offered, because resuming would send the player back to
    // replay and re-score the final question.
    cy.get('[data-cy="resume-banner"]').should('not.exist');
  });
});

describe('resuming from the setup screen (B8)', () => {
  it('offers the saved game after a fresh page load, and resumes where it left off', () => {
    cy.startGame(5);
    cy.contains('Question 1 / 5');
    cy.answerQuestion(CORRECT_ANSWERS[0]);
    cy.contains('Question 2 / 5');
    cy.contains('Score: 1');

    // How a player actually abandons a game part-way: the top-bar logo is a
    // plain `routerLink="/"`, with no guard and no reset behind it.
    cy.get('header a[href="/"]').click();
    cy.location('pathname').should('eq', '/');
    cy.get('[data-cy="resume-banner"]').should('be.visible');

    // Reloading is what makes this the PWA-relaunch case rather than a
    // navigation: after it, the in-memory signals are gone and the banner can
    // only be coming back out of IndexedDB.
    cy.reload();
    cy.get('[data-cy="resume-banner"]')
      .should('be.visible')
      // Whitespace-tolerant: the count is interpolated across a line break in
      // the template, so an exact substring match would pin the formatting
      // rather than the content.
      .invoke('text')
      .should('match', /question\s+2\s+of\s+5/);

    cy.get('[data-cy="resume-game"]').click();

    cy.location('pathname').should('eq', '/play');
    cy.get('[data-cy="question-text"]').should('be.visible');
    // Position *and* score: a restore that came back at the right question
    // with the wrong score is still a lost game.
    cy.contains('Question 2 / 5');
    cy.contains('Score: 1');
  });

  it('discards the saved game — the banner goes, and so does the record', () => {
    cy.startGame(5);
    cy.answerQuestion(CORRECT_ANSWERS[0]);
    cy.contains('Question 2 / 5');

    cy.visit('/');
    cy.get('[data-cy="resume-banner"]').should('be.visible');
    cy.get('[data-cy="discard-game"]').click();
    cy.get('[data-cy="resume-banner"]').should('not.exist');

    // The banner disappearing only proves the signals were cleared.
    // `discardSavedGame()` also enqueues a write, and if that half were
    // missing the game would be back on the next load — which is the whole
    // difference between discarding and hiding.
    cy.window()
      .then((win) => readSavedGame(win))
      .should((saved) => {
        expect(saved, 'the discarded game is gone from storage').to.equal(null);
      });

    cy.reload();
    cy.get('#amount').should('be.visible');
    cy.get('[data-cy="resume-banner"]').should('not.exist');
  });
});

describe('flagged questions survive a reload (B8 + H4)', () => {
  // Unique per run so concurrent CI runs never race on the same doc IDs, and
  // so the preview job's real bank never collides with itself.
  const runId = Date.now();
  const customQuestions = [
    {
      id: `resume-flag-q1-${runId}`,
      category: 'Science',
      type: 'multiple' as const,
      difficulty: 'easy' as const,
      question: 'Which planet is known as the Red Planet?',
      correct_answer: 'Mars',
      incorrect_answers: ['Venus', 'Jupiter', 'Mercury'],
    },
    {
      id: `resume-flag-q2-${runId}`,
      category: 'Science',
      type: 'boolean' as const,
      difficulty: 'easy' as const,
      question: 'Sound travels faster in water than in air.',
      correct_answer: 'True',
      incorrect_answers: ['False'],
    },
  ];

  it('keeps the flag, and the chosen time limit, across a reload', () => {
    // Community questions only — an Open Trivia DB question has no flag button,
    // because its id is minted per fetch and a report about one could never be
    // acted on.
    cy.seedCustomQuestions(customQuestions);
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.wait('@categories');
    // Non-default on purpose, for the same reason `cy.startGame(5)` is
    // load-bearing above: B11 only ever bit a player who touched this control,
    // and a spec that leaves it alone passes against that bug.
    cy.get('#amount').select('5');
    cy.contains('label', 'Custom').click();
    // No countdown. This test is about what survives a reload, and a 15-second
    // deadline running underneath it would auto-answer the question being
    // asserted on. It also puts the chosen limit — part of the persisted
    // config, and the field that decides which leaderboard the score lands on
    // — through the same round trip, which is the assertion G7 wanted and
    // could not have while the reload itself was broken.
    cy.get('[data-cy="time-limit-unlimited"]').click({ force: true });
    cy.contains('button', 'Start Game').click();

    cy.get('[data-cy="question-text"]').should('be.visible');
    cy.get('[data-cy="no-time-limit"]').should('be.visible');

    // Read from the DOM rather than assumed: the bank serves in an order this
    // test does not control, and against the preview job it holds every other
    // custom question that exists.
    cy.get('[data-cy="question-text"]')
      .invoke('text')
      .then((text) => {
        const flaggedQuestion = text.trim();

        cy.get('[data-cy="flag-question"]').click();
        cy.get('[data-cy="flag-notice"]').should('be.visible');

        cy.window()
          .then((win) => readSavedGame(win))
          .should((saved) => {
            expect(
              saved?.['flaggedQuestionIds'],
              'the flag reaches storage before the reload',
            ).to.have.length(1);
          });

        cy.reload();

        cy.get('[data-cy="question-text"]').should((heading) => {
          expect(heading.text().trim(), 'the same question is back on screen').to.equal(
            flaggedQuestion,
          );
        });
        // The flag is a promise to the player — it says they will be asked for
        // detail at game over — so a reload that dropped it would break that
        // promise with nothing on screen to say so.
        cy.get('[data-cy="flag-question"]').should('have.attr', 'aria-pressed', 'true');
        cy.get('[data-cy="flag-notice"]').should('be.visible');
        cy.get('[data-cy="no-time-limit"]').should('be.visible');
      });
  });
});
