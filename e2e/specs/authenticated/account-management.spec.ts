import { readFile } from 'node:fs/promises';
import { expect, test } from '../../fixtures/test';
import { openAuthMenu, signInViaUi } from '../../support/auth';
import { answerQuestion, startNewGame } from '../../support/game';
import { waitForGameplayStats } from '../../support/gameplay-stats';
import { CORRECT_ANSWERS, stubOpenTrivia } from '../../support/open-trivia';

const password = 'Str0ngPassw0rd!';

/**
 * Unique per test, not per file: workers share one emulator and there is no
 * `resetBackend()` between tests, so a fixed address would collide with the
 * account another worker (or this test's own previous run) already created.
 */
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Deletion spans Auth, Stripe, the leaderboard and the question bank. The UI
 * can only ever show that *something* happened, so every assertion here reads
 * the backend directly via the Admin SDK — the risk this guards against is a
 * step that silently doesn't run, which looks identical from the front end.
 */
test.describe('account management: export and deletion', () => {
  test('removes the account and its leaderboard entry, and unlinks contributed questions', async ({
    page,
    firebase,
  }) => {
    const email = `deleter-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });
    const questionId = `authored-by-departing-user-${unique()}`;

    await firebase.seedLeaderboardEntry({
      uid,
      name: 'Departing Player',
      score: 4,
      totalQuestions: 5,
      percentage: 80,
    });
    await firebase.seedCustomQuestions([
      {
        id: questionId,
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

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);

    // Play a game first, so there is a `users/{uid}` document to delete.
    // Without this the "stats removed" assertion below is **vacuous**: the
    // document is created lazily on the first completed game, so an account
    // that never finished one has none, and `null` after deletion would pass
    // against a `deleteAccount` that sweeps nothing at all. This is the single
    // test standing behind a published policy promise.
    await startNewGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);
    // Waits for the write rather than reading once: the call is
    // fire-and-forget, and an Admin-SDK read is not a retrying query, so a bare
    // assertion here would be made against a single read that can easily
    // precede the callable landing. See `waitForGameplayStats`.
    await waitForGameplayStats(firebase, uid);

    await openAuthMenu(page);
    await page.getByTestId('delete-account').click();
    await page.getByTestId('confirm-delete-account').click();

    // The menu closes on success and the app falls back to an anonymous
    // session, so the sign-in affordance returns.
    //
    // Asserted on the chip's own text rather than by looking for a button
    // labelled "Sign in": the chip is always in the document and only its
    // contents change, and game-over's *own* "Sign in" button becomes visible
    // at the same moment — two buttons of that name, which is exactly the
    // ambiguity `CLAUDE.md` §4.6 says to address by `data-cy`.
    await expect(page.getByTestId('auth-menu-trigger')).toContainText('Sign in', {
      timeout: 30_000,
    });

    const state = await firebase.inspectAccountState({ uid, questionId });
    expect(state.authUserExists, 'Auth user removed').toBe(false);
    expect(state.leaderboardExists, 'leaderboard entry removed').toBe(false);
    expect(state.customerExists, 'customer record removed').toBe(false);
    // Non-vacuous because the game above proved it existed a moment ago.
    expect(state.gameplayStats, 'gameplay totals removed').toBeNull();
    // The question survives — it belongs to the shared bank other players draw
    // from — but is no longer traceable to the deleted user.
    expect(state.questionExists, 'contributed question kept').toBe(true);
    expect(state.questionCreatedBy, 'author link stripped').toBe('[deleted-user]');
  });

  test('exports everything held about the user as a downloadable file', async ({
    page,
    firebase,
  }) => {
    const email = `deleter-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });
    const questionId = `authored-for-export-${unique()}`;

    await firebase.seedLeaderboardEntry({
      uid,
      name: 'Curious Player',
      score: 3,
      totalQuestions: 5,
      percentage: 60,
    });
    await firebase.seedCustomQuestions([
      {
        id: questionId,
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

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);

    await openAuthMenu(page);
    // Armed before the click, not after: the download can complete before the
    // next statement runs, and an event that has already fired is not waited
    // for — it is missed.
    const downloading = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByTestId('download-my-data').click();
    const download = await downloading;

    // Assert on the delivered file, not on the UI: the point of an export is
    // that what lands on disk is complete and honest.
    expect(download.suggestedFilename()).toBe('trivimind-my-data.json');
    const exported = JSON.parse(await readFile(await download.path(), 'utf8')) as {
      account: { uid: string; email: string; signInProviders: string[] };
      leaderboardEntries: { board: string; score: number }[];
      contributedQuestions: { id: string }[];
      gameplayStats: Record<string, number> | null;
      notHeldHere: string[];
    };

    expect(exported.account.uid).toBe(uid);
    expect(exported.account.email).toBe(email);
    expect(exported.account.signInProviders).toContain('password');
    // One entry per board since G7, each labelled with the board it came from —
    // an export that collapsed them would be an incomplete answer to a
    // data-access request.
    expect(exported.leaderboardEntries).toHaveLength(1);
    expect(exported.leaderboardEntries[0].board).toBe('15');
    expect(exported.leaderboardEntries[0].score).toBe(3);
    expect(exported.contributedQuestions.map((question) => question.id)).toContain(questionId);
    // Present and explicitly null, because this account never finished a game.
    // The key has to be *there*: an absent key reads as "we are not telling
    // you", an explicit null reads as "there is nothing" — the distinction
    // `notHeldHere` exists to make everywhere else.
    expect(exported).toHaveProperty('gameplayStats');
    expect(exported.gameplayStats).toBeNull();
    // The export has to say what it deliberately does not contain, otherwise a
    // missing card number reads as concealment.
    expect(exported.notHeldHere.join(' ')).toMatch(/stripe/i);
  });

  test('can be backed out of without deleting anything', async ({ page, firebase }) => {
    const email = `deleter-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);

    await openAuthMenu(page);
    await page.getByTestId('delete-account').click();
    await expect(page.getByText('Delete your account?')).toBeVisible();
    await page.getByRole('button', { name: 'Keep my account', exact: true }).click();

    await expect(page.getByText('Delete your account?')).toHaveCount(0);
    const state = await firebase.inspectAccountState({ uid });
    expect(state.authUserExists, 'account still present').toBe(true);
  });
});
