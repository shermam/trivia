import { expect, test } from '../../fixtures/test';
import { answerQuestion, optionLabel, startGame, waitForPlayRoute } from '../../support/game';
import { readSavedGame } from '../../support/offline-storage';
import { CORRECT_ANSWERS, stubExtraCategory, stubOpenTrivia } from '../../support/open-trivia';

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
 * **`startGame(page, 5)` is load-bearing, not incidental.** It picks a question
 * count through the real `<select>`, which is what produced the bad value; the
 * form's *default* stayed a genuine number, so a version of this test that
 * never touched that control would have passed against the bug. Whatever else
 * changes here, keep something that chooses a non-default amount.
 *
 * Kept staged rather than collapsed into one assertion, because the next
 * regression here will not necessarily be the same one.
 */
test.describe('resuming a game after a reload (B8)', () => {
  test('restores the in-progress game when the page is reloaded', async ({ page }) => {
    await startGame(page, 5);

    // The persisting effect queues an async write with no observable "landed"
    // signal, so reloading immediately would be racing it rather than testing
    // the feature. Asserting the record exists is what makes the wait honest.
    await expect
      .poll(() => readSavedGame(page), { message: 'a game is persisted before the reload' })
      .not.toBeNull();

    await page.reload();

    await expect
      .poll(() => readSavedGame(page), { message: 'the persisted game survives the page load' })
      .not.toBeNull();

    // Anchored on the quiz itself, not on the URL: after a reload the URL is
    // already /play, so a pathname assertion passes before Angular boots and
    // keeps passing if the guard then redirects to /.
    await expect(page.getByTestId('question-text')).toBeVisible();
    // The count as well as the screen. It is the field that was corrupted, so
    // a restore that came back with the wrong one would still be a failure.
    await expect(page.getByText('Question 1 / 5').first()).toBeVisible();
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
test.describe('reloading a finished game on /game-over (B8)', () => {
  test('keeps the completed game, and the score waiting to be submitted', async ({ page }) => {
    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }

    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByText('Game Over!').first()).toBeVisible();
    await expect(
      page.getByText(`${CORRECT_ANSWERS.length} / ${CORRECT_ANSWERS.length}`).first(),
    ).toBeVisible();

    await expect
      .poll(() => readSavedGame(page), { message: 'a finished game is persisted too' })
      .toMatchObject({ isComplete: true });

    await page.reload();

    // Anchored on rendered content, never on the URL: `/game-over` is already
    // the pathname after a reload, so a location assertion passes before
    // Angular boots and keeps on passing if `hasCompletedGameGuard` then
    // sends the player home.
    await expect(page.getByText('Game Over!').first()).toBeVisible();
    await expect(
      page.getByText(`${CORRECT_ANSWERS.length} / ${CORRECT_ANSWERS.length}`).first(),
    ).toBeVisible();
    await expect(page.getByTestId('leaderboard-title')).toBeVisible();
  });

  test('does not offer a finished game as one to resume', async ({ page }) => {
    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page.getByText('Game Over!').first()).toBeVisible();

    // A fresh load of `/`, so the banner's only possible source is IndexedDB.
    await page.goto('/');

    // Positive anchor before the negative assertion — a count of zero is
    // satisfied by a page that has not rendered yet (`docs/ci-cd.md` §4.3).
    await expect(page.locator('#amount')).toBeVisible();
    // `hasResumableGame()` is `totalQuestions() > 0 && !isComplete()`. The
    // record is still there — the test above proves that — and it is still
    // deliberately not offered, because resuming would send the player back to
    // replay and re-score the final question.
    await expect(page.getByTestId('resume-banner')).toHaveCount(0);
  });
});

test.describe('resuming from the setup screen (B8)', () => {
  test('offers the saved game after a fresh page load, and resumes where it left off', async ({
    page,
  }) => {
    await startGame(page, 5);
    await expect(page.getByText('Question 1 / 5').first()).toBeVisible();
    await answerQuestion(page, CORRECT_ANSWERS[0]);
    await expect(page.getByText('Question 2 / 5').first()).toBeVisible();
    await expect(page.getByText('Score: 1').first()).toBeVisible();

    // How a player actually abandons a game part-way: the top-bar logo is a
    // plain `routerLink="/"`, with no guard and no reset behind it.
    await page.locator('header a[href="/"]').first().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await expect(page.getByTestId('resume-banner')).toBeVisible();

    // Reloading is what makes this the PWA-relaunch case rather than a
    // navigation: after it, the in-memory signals are gone and the banner can
    // only be coming back out of IndexedDB.
    await page.reload();
    const banner = page.getByTestId('resume-banner');
    await expect(banner).toBeVisible();
    // Whitespace-tolerant: the count is interpolated across a line break in
    // the template, so an exact substring match would pin the formatting
    // rather than the content.
    await expect(banner).toContainText(/question\s+2\s+of\s+5/);

    await page.getByTestId('resume-game').click();

    await expect(page).toHaveURL(/\/play$/);
    await expect(page.getByTestId('question-text')).toBeVisible();
    // Position *and* score: a restore that came back at the right question
    // with the wrong score is still a lost game.
    await expect(page.getByText('Question 2 / 5').first()).toBeVisible();
    await expect(page.getByText('Score: 1').first()).toBeVisible();
  });

  test('discards the saved game — the banner goes, and so does the record', async ({ page }) => {
    await startGame(page, 5);
    await answerQuestion(page, CORRECT_ANSWERS[0]);
    await expect(page.getByText('Question 2 / 5').first()).toBeVisible();

    await page.goto('/');
    await expect(page.getByTestId('resume-banner')).toBeVisible();
    await page.getByTestId('discard-game').click();
    await expect(page.getByTestId('resume-banner')).toHaveCount(0);

    // The banner disappearing only proves the signals were cleared.
    // `discardSavedGame()` also enqueues a write, and if that half were
    // missing the game would be back on the next load — which is the whole
    // difference between discarding and hiding.
    await expect
      .poll(() => readSavedGame(page), { message: 'the discarded game is gone from storage' })
      .toBeNull();

    await page.reload();
    await expect(page.locator('#amount')).toBeVisible();
    await expect(page.getByTestId('resume-banner')).toHaveCount(0);
  });
});

test.describe('flagged questions survive a reload (B8 + H4)', () => {
  test('keeps the flag, and the chosen time limit, across a reload', async ({ page, firebase }) => {
    // Unique per test, not merely per run: workers share one emulator, so the
    // ids **and** the category have to be this test's alone — see the category
    // note on `stubExtraCategory`. Against the preview target the same uniqueness
    // is what keeps the real bank from colliding with itself.
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const category = `Resume Flags ${runId}`;
    const customQuestions = [
      {
        id: `resume-flag-q1-${runId}`,
        category,
        type: 'multiple' as const,
        difficulty: 'easy' as const,
        question: 'Which planet is known as the Red Planet?',
        correct_answer: 'Mars',
        incorrect_answers: ['Venus', 'Jupiter', 'Mercury'],
      },
      {
        id: `resume-flag-q2-${runId}`,
        category,
        type: 'boolean' as const,
        difficulty: 'easy' as const,
        question: 'Sound travels faster in water than in air.',
        correct_answer: 'True',
        incorrect_answers: ['False'],
      },
    ];

    // Community questions only — an Open Trivia DB question has no flag button,
    // because its id is minted per fetch and a report about one could never be
    // acted on.
    await firebase.seedCustomQuestions(customQuestions);
    await stubOpenTrivia(page);
    await stubExtraCategory(page, category);
    await page.goto('/');
    await expect(page.locator('#category')).toContainText(category);

    // Non-default on purpose, for the same reason `startGame(page, 5)` is
    // load-bearing above: B11 only ever bit a player who touched this control,
    // and a spec that leaves it alone passes against that bug.
    await page.locator('#amount').selectOption({ label: '5' });
    await page.locator('#category').selectOption(category);
    await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
    // No countdown. This test is about what survives a reload, and a 15-second
    // deadline running underneath it would auto-answer the question being
    // asserted on. It also puts the chosen limit — part of the persisted
    // config, and the field that decides which leaderboard the score lands on
    // — through the same round trip, which is the assertion G7 wanted and
    // could not have while the reload itself was broken.
    await optionLabel(page, page.getByTestId('time-limit-unlimited')).click();
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();

    await waitForPlayRoute(page);
    await expect(page.getByTestId('no-time-limit')).toBeVisible();

    // Read from the DOM rather than assumed: the bank serves in an order this
    // test does not control.
    const flaggedQuestion = (await page.getByTestId('question-text').textContent())?.trim();

    await page.getByTestId('flag-question').click();
    await expect(page.getByTestId('flag-notice')).toBeVisible();

    await expect
      .poll(async () => (await readSavedGame(page))?.['flaggedQuestionIds'], {
        message: 'the flag reaches storage before the reload',
      })
      .toHaveLength(1);

    await page.reload();

    await expect(page.getByTestId('question-text'), 'the same question is back on screen').toHaveText(
      flaggedQuestion!,
    );
    // The flag is a promise to the player — it says they will be asked for
    // detail at game over — so a reload that dropped it would break that
    // promise with nothing on screen to say so.
    await expect(page.getByTestId('flag-question')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('flag-notice')).toBeVisible();
    await expect(page.getByTestId('no-time-limit')).toBeVisible();
  });
});
