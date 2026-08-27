import questionsFixture from '../../fixtures/open-trivia-questions.json';

const CORRECT_ANSWERS = questionsFixture.results.map((q) => q.correct_answer);
const password = 'Str0ngPassw0rd!';

/**
 * Deletion spans Auth, Stripe, the leaderboard and the question bank. The UI
 * can only ever show that *something* happened, so every assertion here reads
 * the backend directly via the Admin SDK — the risk this guards against is a
 * step that silently doesn't run, which looks identical from the front end.
 */
describe('account management: export and deletion', () => {
  let email: string;
  let uid: string;

  beforeEach(() => {
    cy.resetBackend();
    email = `deleter-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    cy.createVerifiedUser({ email, password }).then((user) => {
      uid = user.uid;
    });
  });

  it('removes the account and its leaderboard entry, and unlinks contributed questions', () => {
    cy.then(() => {
      cy.seedLeaderboardEntry({
        uid,
        name: 'Departing Player',
        score: 4,
        totalQuestions: 5,
        percentage: 80,
      });
      cy.seedCustomQuestions([
        {
          id: 'authored-by-departing-user',
          category: 'Science',
          type: 'multiple',
          difficulty: 'easy',
          question: 'A question this user contributed',
          correct_answer: 'Yes',
          incorrect_answers: ['No', 'Maybe', 'Perhaps'],
          createdBy: uid,
          createdAt: Date.now(),
        },
      ]);
    });

    cy.stubOpenTrivia();
    cy.visit('/');
    cy.signInViaUi(email, password);

    // Play a game first, so there is a `users/{uid}` document to delete.
    // Without this the "stats removed" assertion below is **vacuous**: the
    // document is created lazily on the first completed game, so an account
    // that never finished one has none, and `null` after deletion would pass
    // against a `deleteAccount` that sweeps nothing at all. This is the single
    // test standing behind a published policy promise.
    cy.startNewGame(5);
    CORRECT_ANSWERS.forEach((answer) => {
      cy.answerQuestion(answer);
    });
    cy.location('pathname').should('eq', '/game-over');
    cy.then(() => {
      cy.inspectAccountState({ uid }).should((state) => {
        expect(state.gameplayStats, 'stats exist before deletion').to.not.be.null;
      });
    });

    cy.openAuthMenu();
    cy.get('[data-cy=delete-account]').click();
    cy.get('[data-cy=confirm-delete-account]').click();

    // The menu closes on success and the app falls back to an anonymous
    // session, so the sign-in affordance returns.
    cy.contains('button', 'Sign in', { timeout: 30000 }).should('be.visible');

    cy.then(() => {
      cy.inspectAccountState({ uid, questionId: 'authored-by-departing-user' }).then((state) => {
        expect(state.authUserExists, 'Auth user removed').to.be.false;
        expect(state.leaderboardExists, 'leaderboard entry removed').to.be.false;
        expect(state.customerExists, 'customer record removed').to.be.false;
        // Non-vacuous because the game above proved it existed a moment ago.
        expect(state.gameplayStats, 'gameplay totals removed').to.be.null;
        // The question survives — it belongs to the shared bank other players
        // draw from — but is no longer traceable to the deleted user.
        expect(state.questionExists, 'contributed question kept').to.be.true;
        expect(state.questionCreatedBy, 'author link stripped').to.eq('[deleted-user]');
      });
    });
  });

  it('exports everything held about the user as a downloadable file', () => {
    cy.then(() => {
      cy.seedLeaderboardEntry({
        uid,
        name: 'Curious Player',
        score: 3,
        totalQuestions: 5,
        percentage: 60,
      });
      cy.seedCustomQuestions([
        {
          id: 'authored-for-export',
          category: 'History',
          type: 'multiple',
          difficulty: 'medium',
          question: 'A question this user contributed',
          correct_answer: 'Yes',
          incorrect_answers: ['No', 'Maybe', 'Perhaps'],
          createdBy: uid,
          createdAt: Date.now(),
        },
      ]);
    });

    cy.stubOpenTrivia();
    cy.visit('/');
    cy.signInViaUi(email, password);

    cy.openAuthMenu();
    cy.get('[data-cy=download-my-data]').click();

    // Assert on the delivered file, not on the UI: the point of an export is
    // that what lands on disk is complete and honest.
    cy.readFile('cypress/downloads/trivimind-my-data.json', { timeout: 30000 }).then(
      (data: Record<string, never>) => {
        const exported = data as unknown as {
          account: { uid: string; email: string; signInProviders: string[] };
          leaderboardEntries: { board: string; score: number }[];
          contributedQuestions: { id: string }[];
          gameplayStats: Record<string, number> | null;
          notHeldHere: string[];
        };
        expect(exported.account.uid).to.eq(uid);
        expect(exported.account.email).to.eq(email);
        expect(exported.account.signInProviders).to.include('password');
        // One entry per board since G7, each labelled with the board it came
        // from — an export that collapsed them would be an incomplete answer
        // to a data-access request.
        expect(exported.leaderboardEntries).to.have.length(1);
        expect(exported.leaderboardEntries[0].board).to.eq('15');
        expect(exported.leaderboardEntries[0].score).to.eq(3);
        expect(exported.contributedQuestions.map((q) => q.id)).to.include('authored-for-export');
        // Present and explicitly null, because this account never finished a
        // game. The key has to be *there*: an absent key reads as "we are not
        // telling you", an explicit null reads as "there is nothing" — the
        // distinction `notHeldHere` exists to make everywhere else.
        expect(exported).to.have.property('gameplayStats');
        expect(exported.gameplayStats).to.be.null;
        // The export has to say what it deliberately does not contain,
        // otherwise a missing card number reads as concealment.
        expect(exported.notHeldHere.join(' ')).to.match(/stripe/i);
      },
    );
  });

  it('can be backed out of without deleting anything', () => {
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.signInViaUi(email, password);

    cy.openAuthMenu();
    cy.get('[data-cy=delete-account]').click();
    cy.contains('Delete your account?');
    cy.contains('button', 'Keep my account').click();

    cy.contains('Delete your account?').should('not.exist');
    cy.then(() => {
      cy.inspectAccountState({ uid }).then((state) => {
        expect(state.authUserExists, 'account still present').to.be.true;
      });
    });
  });
});
