import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { signInViaUi } from '../../support/auth';
import { answerQuestion, startGame, startNewGame } from '../../support/game';
import { waitForGameplayStats } from '../../support/gameplay-stats';
import { CORRECT_ANSWERS, stubOpenTrivia } from '../../support/open-trivia';

const password = 'Str0ngPassw0rd!';

/**
 * How long to wait for a `recordGameResult` invocation to be made and answered.
 * Generous on purpose: this is a ceiling, not a delay — the wait ends when the
 * response arrives — and it has to clear a cold Functions emulator on a
 * CPU-starved runner.
 */
const CALLABLE_TIMEOUT_MS = 30_000;

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * `users/{uid}` — the lifetime totals a completed game banks.
 *
 * Every assertion reads the document through the Admin SDK rather than through
 * the UI, and it has to: nothing in the app renders these numbers yet
 * (`FEAT-005`'s profile page is a separate feature), and the risk being guarded
 * is a write that silently does not happen or silently happens twice — both of
 * which look identical from the front end.
 *
 * `firestore.rules` gives the collection no client write path at all, so a
 * document appearing here is proof the callable ran, not proof the browser
 * could reach Firestore.
 */
test.describe('lifetime gameplay totals', () => {
  async function playFullGame(page: Page): Promise<void> {
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);
  }

  test('banks a finished game against the signed-in account', async ({ page, firebase }) => {
    const email = `stats-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);

    await startNewGame(page, 5);
    await playFullGame(page);

    // `waitForGameplayStats` rather than a single read: the call is
    // fire-and-forget so nothing in the DOM changes when it lands, and an
    // Admin-SDK read is not a retrying query — an assertion written against one
    // reads the database exactly once. These three tests passed that way under
    // Cypress, and passing by luck is not the same as passing.
    const stats = await waitForGameplayStats(firebase, uid);
    expect(stats).toMatchObject({
      gamesPlayed: 1,
      questionsAnswered: 5,
      correctAnswers: 5,
      bestStreak: 5,
    });
  });

  /**
   * **The defect `lastGameId` exists to prevent.** `/game-over` is deliberately
   * restorable — the completed game stays in the snapshot so a refresh does not
   * lose the score about to be submitted — which means `ngOnInit` runs again and
   * calls the callable again with the same game.
   *
   * The assertion has to read the counter, not merely check the document
   * exists: an implementation that banks the game twice produces a document
   * either way, so an existence check would pass against the bug.
   */
  test('does not bank the same game twice when the results screen is reloaded', async ({
    page,
    firebase,
  }) => {
    const email = `stats-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });

    await stubOpenTrivia(page);

    // Observe the callable — nothing is intercepted or stubbed — so the
    // reload's own invocation becomes something this test can wait *for* rather
    // than wait *out*. `/game-over` fires it from `ngOnInit`, so there is one
    // request per visit and counting them in order is enough.
    //
    // A page-level listener rather than a per-navigation wait, because it has
    // to survive the reload: `page.on` outlives every navigation in the test,
    // where a `waitForResponse` armed before the reload would be discarded with
    // the document that was armed under it.
    //
    // A RegExp rather than a glob: the callable posts to
    // `http://127.0.0.1:5001/<projectId>/us-central1/recordGameResult`, and a
    // `**/` glob has to match across the `//` in the protocol, which is exactly
    // where minimatch is fussy.
    let answeredCalls = 0;
    page.on('response', (response) => {
      if (/\/recordGameResult(\?|$)/.test(response.url())) {
        answeredCalls += 1;
      }
    });

    await page.goto('/');
    await signInViaUi(page, email, password);

    await startNewGame(page, 5);
    await playFullGame(page);

    await expect
      .poll(() => answeredCalls, { timeout: CALLABLE_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(1);
    expect(await waitForGameplayStats(firebase, uid)).toMatchObject({ gamesPlayed: 1 });

    await page.reload();
    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByRole('heading', { name: 'Game Over!', exact: true })).toBeVisible();

    // **The reload's call has to have been made and answered before the
    // assertion below means anything** — otherwise "still 1" could just mean
    // "the second call has not happened yet", which would pass against the very
    // double-count this test exists to catch.
    //
    // Which is why this waits on the response and not on a clock. A fixed delay
    // is calibrated against whichever machine it was written on: too short on a
    // loaded runner and the assertion passes vacuously, too long and every run
    // pays for it. Waiting on the request returns the instant the response
    // lands.
    await expect
      .poll(() => answeredCalls, { timeout: CALLABLE_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(2);

    expect(await waitForGameplayStats(firebase, uid)).toMatchObject({
      gamesPlayed: 1,
      questionsAnswered: 5,
    });
  });

  /**
   * Anonymous sessions get no document, enforced in the callable because there
   * is no client write rule for the gate to live in.
   *
   * Not tidiness: `deleteAccount` never runs for an anonymous account and
   * Firebase's auto-deletion removes only the Auth record, so a document per
   * guest would accumulate with nothing able to delete it — and the Privacy
   * Policy's claim that nothing is kept for anonymous play would stop being true
   * on the first page load after deploy.
   *
   * **Asserted against this session's own uid, not by counting the
   * collection.** Counting states the claim more directly — "*nobody* got a
   * document" — but it only means that behind a `resetBackend()` that emptied
   * the collection first, and there is none here: workers share one emulator and
   * every signed-in game in the run writes a row. A count is therefore about
   * other tests rather than about this one. Digging the uid out of the browser's
   * auth state is the more fragile half of the check, so it is made loud: the
   * uid is asserted to have been found at all, which is the failure a silent
   * `''` would otherwise turn into a vacuous pass.
   */
  test('keeps nothing for an anonymous player', async ({ page, firebase }) => {
    await startGame(page, 5);
    await playFullGame(page);

    // A positive anchor first. The assertion below is a negative one, and a
    // negative assertion straight after a navigation is satisfied by a page that
    // has not finished doing anything yet (`ci-cd.md` §4.3) — here, by the
    // callable simply not having been reached.
    await expect(page.getByText('Sign in to save this score to the leaderboard.')).toBeVisible();

    const uid = await anonymousUid(page);
    expect(uid, 'the anonymous session this game was played in').not.toBe('');

    const state = await firebase.inspectAccountState({ uid });
    expect(state.gameplayStats, 'no lifetime totals for an anonymous player').toBeNull();
  });
});

/**
 * The uid of the session the browser is holding, read from where Firebase Auth
 * persists it.
 *
 * `browserLocalPersistence` writes the whole user record under
 * `firebase:authUser:<apiKey>:<appName>`; the key is scanned for rather than
 * rebuilt, because the apiKey half is synthesised from the emulator config and
 * restating it here would be a second copy of something that is already
 * decided elsewhere.
 */
function anonymousUid(page: Page): Promise<string> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((name) => name.startsWith('firebase:authUser:'));
    if (!key) {
      return '';
    }
    return (JSON.parse(localStorage.getItem(key) ?? '{}') as { uid?: string }).uid ?? '';
  });
}
