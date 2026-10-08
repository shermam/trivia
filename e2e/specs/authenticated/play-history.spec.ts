import { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { expect, test } from '../../fixtures/test';
import { FirebaseBackend } from '../../fixtures/firebase-backend';
import { PlayRecord } from '../../fixtures/types';
import { openAuthMenu, signInViaUi } from '../../support/auth';
import { answerQuestion, optionLabel, startNewGame, waitForPlayRoute } from '../../support/game';
import { CORRECT_ANSWERS, stubExtraCategory, stubOpenTrivia } from '../../support/open-trivia';

const password = 'Str0ngPassw0rd!';

/**
 * Unique per test, not per file: workers share one emulator and there is no
 * reset between tests, so a fixed address collides with the account another
 * worker — or this test's own previous run — already created.
 */
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * `users/{uid}/plays/{gameId}` — one document per completed game (`FEAT-049`).
 *
 * Every assertion reads the subcollection through the Admin SDK, and it has to:
 * **nothing in the app renders a play history**, by design. The export is where
 * a player sees it, and the only other consumer is a recommender that does not
 * exist yet. So the risk being guarded is a write that silently does not
 * happen, silently happens twice, or happens for somebody it must not — three
 * outcomes that look identical from the front end.
 *
 * `firestore.rules` gives the collection no client write path at all, so a
 * document appearing here is proof the callable ran, not proof the browser
 * could reach Firestore.
 */
test.describe('per-player play history', () => {
  /**
   * Waits for the game to be banked, then returns the history.
   *
   * `recordGameResult` is fire-and-forget by design — `/game-over` renders from
   * local state and must not wait on a cold start — so nothing in the DOM
   * changes when the write lands and there is no locator to hang an assertion
   * off. An Admin-SDK read is a plain `await` rather than a retrying query, so
   * an assertion written against one reads the database exactly once, which is
   * a race by construction (`CLAUDE.md` §4.6). `expect.poll` re-runs the
   * **read**, which is the thing that has to happen again.
   */
  async function waitForPlayHistory(
    firebase: FirebaseBackend,
    uid: string,
    expected = 1,
  ): Promise<PlayRecord[]> {
    await expect
      .poll(async () => (await firebase.getPlayHistory(uid)).length, {
        message:
          `users/${uid}/plays never reached ${expected} document(s). recordGameResult is ` +
          'fire-and-forget, so either it was never called, it was refused (anonymous or an ' +
          'unsupported provider), or the submission was rejected as invalid.',
      })
      .toBe(expected);

    return firebase.getPlayHistory(uid);
  }

  async function playFullGame(page: Page): Promise<void> {
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);
  }

  test('writes one document for a signed-in game, with an entry per question', async ({
    page,
    firebase,
  }) => {
    const email = `plays-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);

    await startNewGame(page, 5);
    await playFullGame(page);

    const [play] = await waitForPlayHistory(firebase, uid);

    expect(play.answers).toHaveLength(5);
    expect(play.at).toBeGreaterThan(0);
    for (const answer of play.answers) {
      expect(answer.correct, 'every question was answered correctly').toBe(true);
      expect(answer.difficulty).toBe('easy');
      // Open Trivia ids are minted per fetch and mean nothing across batches,
      // so the key is omitted rather than filled with one — and the same for
      // tags, which that source does not have.
      expect('questionId' in answer, 'no id for an Open Trivia question').toBe(false);
      expect('tags' in answer, 'no tags for an Open Trivia question').toBe(false);
      // Bounded rather than exact: the number is real wall-clock time on a
      // shared runner, so the assertion is that it is a plausible duration and
      // not a placeholder.
      expect(answer.ms).toBeGreaterThanOrEqual(0);
      expect(answer.ms).toBeLessThanOrEqual(120_000);
    }

    // The document id is the game id, which is what makes the whole call
    // idempotent — and what ties this round to the lifetime totals' own
    // `lastGameId`.
    expect(play.id.length).toBeGreaterThan(0);
  });

  /**
   * A question from the bank carries its own id and the tags it had at play
   * time, which is what the recommender will score affinities from. Snapshotted
   * rather than looked up later: re-reading each question's current tags would
   * be a read per question per game, and would rewrite history when a question
   * is re-tagged.
   */
  test('records the id and the tags of a question drawn from the bank', async ({
    page,
    firebase,
  }) => {
    const email = `plays-bank-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });
    const runId = unique();
    // This test's own category, so the draw can only serve questions it seeded
    // — the emulator is shared and the bank is not.
    const category = `Play History ${runId}`;
    const questionIds = [0, 1, 2, 3, 4].map((index) => `play-history-${runId}-${index}`);

    await firebase.seedCustomQuestions(
      questionIds.map((id, index) => ({
        id,
        category,
        type: 'multiple' as const,
        difficulty: 'hard' as const,
        question: `Play-history question ${index} (${runId})?`,
        // **The same correct answer on every question, deliberately.** The draw
        // is randomly ordered, so a loop answering `Right 0`, `Right 1`, … in
        // seed order fails on whichever question happens to come first — which
        // is how the first version of this test failed. One label the loop can
        // click five times removes the order from the test's premise, and the
        // assertions below are about the ids and the tags rather than about
        // which question came when.
        correct_answer: 'Right',
        incorrect_answers: [`Wrong ${index}a`, `Wrong ${index}b`, `Wrong ${index}c`],
        tags: ['play-history', `run-${index}`],
      })),
    );

    await stubOpenTrivia(page);
    // The setup screen's category list comes from Open Trivia DB, not from the
    // bank, so a seeded custom category is not in the dropdown until the stub
    // puts it there — which is also what keeps this draw to questions this test
    // owns, against an emulator every worker is writing to.
    await stubExtraCategory(page, category);
    await page.goto('/');
    await signInViaUi(page, email, password);

    await expect(page.locator('#category')).toContainText(category);
    await page.locator('#amount').selectOption({ label: '5' });
    await page.locator('#category').selectOption(category);
    await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
    // No deadline, so a starved worker cannot turn a question into a timeout
    // and make this a test about the countdown. A timeout would still be
    // recorded — as `correct: false` — so removing it costs the feature no
    // coverage (`docs/ci-cd.md` §4.3 records the same trade elsewhere).
    await optionLabel(page, page.getByRole('radio', { name: 'No limit', exact: true })).click();
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await waitForPlayRoute(page);

    // Five clicks on the same label. Answering disables every option until the
    // next question renders, and a Playwright click waits for an enabled
    // element — so the app's own disabled state is the wait between questions.
    for (let index = 0; index < 5; index += 1) {
      await answerQuestion(page, 'Right');
    }
    await expect(page).toHaveURL(/\/game-over$/);

    const [play] = await waitForPlayHistory(firebase, uid);

    expect(play.answers).toHaveLength(5);
    expect(play.answers.map((answer) => answer.questionId).sort()).toEqual([...questionIds].sort());
    for (const answer of play.answers) {
      expect(answer.difficulty).toBe('hard');
      expect(answer.tags).toContain('play-history');
    }
  });

  /**
   * **The defect `gameId` exists to prevent, one collection deeper.**
   * `/game-over` is deliberately restorable — the completed game stays in the
   * snapshot so a refresh does not lose the score about to be submitted — so
   * `ngOnInit` runs again and calls the callable again with the same game. The
   * play document is keyed on that id and written in the same transaction as
   * the totals, so the existing duplicate check governs it.
   *
   * The assertion has to be on the **count**, not on existence: an
   * implementation that appended a second round under a fresh id produces a
   * document either way.
   */
  test('does not write a second document when the results screen is reloaded', async ({
    page,
    firebase,
  }) => {
    const email = `plays-reload-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);

    await startNewGame(page, 5);
    await playFullGame(page);

    const [first] = await waitForPlayHistory(firebase, uid);

    await page.reload();
    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByRole('heading', { name: 'Game Over!', exact: true })).toBeVisible();

    // **The reload's call has to have been made and answered before the
    // assertion means anything** — otherwise "still one" could just mean "the
    // second call has not happened yet", which would pass against the very
    // duplicate this test exists to catch. So it waits on the callable's own
    // response rather than on a clock; a fixed delay is calibrated against
    // whichever machine it was written on.
    await page.waitForResponse((response) => /\/recordGameResult(\?|$)/.test(response.url()));

    const after = await firebase.getPlayHistory(uid);
    expect(after, 'the reload rewrote the same document rather than adding one').toHaveLength(1);
    expect(after[0].id).toBe(first.id);
  });

  /**
   * Anonymous sessions get nothing, enforced in the callable's provider
   * allowlist because there is no client write rule for the gate to live in.
   *
   * Not tidiness: `deleteAccount` never runs for an anonymous account and
   * Firebase's auto-deletion removes only the Auth record, so a history per
   * guest would accumulate with nothing able to delete it — and the Privacy
   * Policy's "Nothing is recorded for anonymous play" would stop being true on
   * the first page load after deploy.
   *
   * Asserted against **this session's own uid** rather than by counting the
   * collection: a count would only mean something behind a reset that emptied
   * it first, and there is none here — workers share one emulator and every
   * signed-in game in the run writes a document.
   */
  test('records nothing for an anonymous player', async ({ page, firebase }) => {
    await stubOpenTrivia(page);
    await page.goto('/');
    await startNewGame(page, 5);
    await playFullGame(page);

    // A positive anchor first. The assertion below is a negative one, and a
    // negative assertion straight after a navigation is satisfied by a page
    // that has not finished doing anything yet — here, by the callable simply
    // not having been reached.
    await expect(page.getByText('Sign in to save this score to the leaderboard.')).toBeVisible();

    const uid = await anonymousUid(page);
    expect(uid, 'the anonymous session this game was played in').not.toBe('');

    expect(await firebase.getPlayHistory(uid), 'no play history for a guest').toEqual([]);
  });

  /**
   * The export is the **only** place a player can read their own history back,
   * because the app deliberately has no screen for it — so this is the one test
   * standing behind that promise in the Privacy Policy.
   */
  test('includes the play history in the exported file', async ({ page, firebase }) => {
    const email = `plays-export-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);

    await startNewGame(page, 5);
    await playFullGame(page);
    await waitForPlayHistory(firebase, uid);

    await openAuthMenu(page);
    // Armed before the click, not after: the download can complete before the
    // next statement runs, and an event that has already fired is not waited
    // for — it is missed.
    const downloading = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByTestId('download-my-data').click();
    const download = await downloading;

    // Assert on the delivered file, not on the UI: the point of an export is
    // what it contains.
    const exported = JSON.parse(await readFile(await download.path(), 'utf8')) as {
      playHistory: PlayRecord[];
    };

    expect(exported.playHistory).toHaveLength(1);
    expect(exported.playHistory[0].answers).toHaveLength(5);
    expect(exported.playHistory[0].id.length).toBeGreaterThan(0);
  });

  /**
   * **`deleteAccount` has to enumerate the subcollection**, because deleting
   * `users/{uid}` does not take what hangs beneath it — the trap this whole
   * test exists for. Non-vacuous because the game above proved the history was
   * there a moment earlier.
   */
  test('removes the play history when the account is deleted', async ({ page, firebase }) => {
    const email = `plays-delete-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);

    await startNewGame(page, 5);
    await playFullGame(page);
    await waitForPlayHistory(firebase, uid);

    await openAuthMenu(page);
    await page.getByTestId('delete-account').click();
    await page.getByTestId('confirm-delete-account').click();

    // The menu closes on success and the app falls back to an anonymous
    // session, so the sign-in affordance returns. Asserted on the chip's own
    // text rather than by looking for a button labelled "Sign in", because
    // game-over's own "Sign in" button becomes visible at the same moment.
    await expect(page.getByTestId('auth-menu-trigger')).toContainText('Sign in', {
      timeout: 30_000,
    });

    expect(await firebase.getPlayHistory(uid), 'play history removed with the account').toEqual([]);
  });
});

/**
 * The uid of the session the browser is holding, read from where Firebase Auth
 * persists it.
 *
 * `browserLocalPersistence` writes the whole user record under
 * `firebase:authUser:<apiKey>:<appName>`; the key is scanned for rather than
 * rebuilt, because the apiKey half is synthesised from the emulator config and
 * restating it here would be a second copy of something decided elsewhere.
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
