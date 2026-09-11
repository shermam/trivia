import { Locator, Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import {
  answerOption,
  answerQuestion,
  optionLabel,
  startGame,
  waitForPlayRoute,
} from '../../support/game';
import { CORRECT_ANSWERS, questionsFixture, stubOpenTrivia } from '../../support/open-trivia';

/**
 * The pixel tolerance every layout assertion below uses.
 *
 * Sub-pixel, because these tests are about a box moving and a box staying put:
 * anything looser would pass through the 43px and 508px jumps they exist to
 * catch, and anything tighter would fail on fractional layout rounding.
 * Anything larger than the tolerance is returned as-is, so a failure names the
 * jump rather than merely reporting that there was one.
 */
function drift(actual: number, expected: number): number {
  const delta = actual - expected;
  return Math.abs(delta) <= 0.5 ? 0 : delta;
}

/** A single comparison, for a measurement already gated on a settled state. */
function expectUnmoved(actual: number, expected: number, what: string): void {
  expect(drift(actual, expected), `${what} (${actual} vs ${expected})`).toBe(0);
}

test.describe('anonymous game flow (open_trivia source)', () => {
  test('plays a full game, tracks score, and offers to sign in to save it', async ({ page }) => {
    await startGame(page, 5);
    await expect(page).toHaveURL(/\/play$/);

    // First question shown, scored 0 so far.
    await expect(page.getByText('Question 1 / 5')).toBeVisible();
    await expect(page.getByText('Score: 0')).toBeVisible();

    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }

    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByRole('heading', { name: 'Game Over!', exact: true })).toBeVisible();
    // **Exact, because the leaderboard on this same screen renders scores in the
    // same words.** A row reads `5 / 5 (100%)`, so the substring form of either
    // of these resolves to the score summary *plus* every entry that happens to
    // have played a perfect round — a strict-mode failure that says nothing
    // about the app. It is latent rather than theoretical: it depends entirely
    // on what else is on the board, which is another spec's business against a
    // shared emulator and the owner's real data against the preview project.
    // Exact matching addresses the summary and nothing else, because a row's
    // text carries its percentage in brackets and the summary's does not.
    await expect(
      page.getByText(`${CORRECT_ANSWERS.length} / ${CORRECT_ANSWERS.length}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('100%', { exact: true })).toBeVisible();

    // Anonymous players can view the leaderboard but are prompted to sign in
    // instead of getting a save-score form.
    //
    // Visible / hidden rather than exists / does not exist: the card's five
    // faces all live in one grid cell so that its height cannot change with its
    // state, which means every face is in the DOM at all times. A count of zero
    // would now fail outright, and — the half worth watching — a plain "the
    // text is there" assertion would go on *passing vacuously* against a face
    // nobody can see (`CLAUDE.md` §4.6).
    await expect(page.getByText('Sign in to save this score to the leaderboard.')).toBeVisible();
    await expect(page.getByTestId('score-save').locator('form')).toBeHidden();
    await expect(page.getByTestId('leaderboard-title')).toHaveText('Top 10 — 15-second games');

    await page.getByRole('button', { name: 'Play Again', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
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
  test('does not move the card when the result banner appears', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 1000 });
    await startGame(page, 5);

    await expect(page.getByTestId('result-banner')).toHaveCount(1);

    const card = page.locator('.max-w-xl').first();
    const before = await card.boundingBox();
    expect(before, 'the quiz card is on screen before the answer').not.toBeNull();

    await answerOption(page, CORRECT_ANSWERS[0]).click();

    // Read after the answer has actually registered, so this cannot pass by
    // measuring twice before anything changed.
    await expect(page.getByTestId('result-status')).toContainText('Correct');

    // Polled, not read once: the banner's arrival is a render the runner does
    // not synchronise with, so a single `boundingBox()` can land on a frame
    // mid-layout and fail for a jump that never reaches a reader's eye. A jump
    // that *does* is not forgiven by polling — the only value this can settle
    // to is where the card started.
    await expect
      .poll(
        async () => {
          const box = (await card.boundingBox())!;
          return { height: drift(box.height, before!.height), top: drift(box.y, before!.y) };
        },
        { message: 'the result banner must not resize or move the quiz card' },
      )
      .toEqual({ height: 0, top: 0 });
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
  test('gives every face of the score card the same height', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    const card = page.getByTestId('score-action');
    await expect(card).toBeVisible();

    // One retrying poll over the whole card rather than a single read: the
    // faces resolve as auth does, and a measurement taken on the frame between
    // two of them would report a mismatch nobody ever sees. Every part of the
    // property is in the one polled value, so they retry together and a card
    // that is genuinely uneven still fails — there is nothing for it to settle
    // into.
    await expect
      .poll(() => measureScoreCardFaces(card), {
        message: 'every face of the score card fills the one reserved cell',
      })
      .toEqual({ faces: 5, collapsed: false, mismatched: [] });
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
   * **30–38ms**. So the assertion below was never testing the leaderboard — it
   * was testing whether a poll happened to land inside a window narrower than
   * the gap between polls, and it failed that way twice on `main` before this
   * intercept existed (runs 33018692994 and 33095985892), both times on
   * "expected to find the leaderboard skeleton".
   *
   * The response is therefore held until this test has measured the loading
   * state, rather than for a fixed delay. **A fixed delay is the same coin
   * flip with a bigger coin**, and it lost: a 500ms hold — five times what the
   * original timing needed — still missed, because the gap between "the URL is
   * `/game-over`" and the runner's first query of the DOM was measured at
   * 823ms against a response released at 669ms. Releasing on the measurement
   * removes the race instead of widening it, and it cannot silently stop
   * working the way a duration can when a machine gets slower.
   *
   * **It does not weaken anything**: the assertions are unchanged, the fetch is
   * real — the handler refetches and replays the genuine response — and the
   * board still has to hold its height across a real load; the hold only
   * guarantees there is a loading state to measure. Measured with it in place:
   * 576px loading, 576px loaded.
   *
   * Note this is emulator-specific in origin but applied unconditionally. The
   * preview suite runs the same spec against a real project, where network
   * latency made the window wide enough that it never failed — but a fix that
   * only works where the bug happens to be visible is one environment away
   * from being no fix at all.
   */
  test('does not resize the leaderboard when the scores arrive', async ({ page }) => {
    // Host-agnostic on purpose: emulator and production Firestore differ in
    // origin but not in this path. The handler refetches and replays the real
    // response, so the board still renders real data.
    //
    // POST only, because that is the response worth holding: the query is
    // `application/json`, so the browser issues a CORS preflight for the same
    // URL first, and delaying that would delay the *request* instead — a
    // different experiment with a much less useful answer.
    // Assigned synchronously by the executor below, which is why the definite
    // assignment assertion is honest rather than a shrug.
    let releaseQuery!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    let heldQueries = 0;
    await page.route(/\/leaderboards\/[^/]+:runQuery/, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      heldQueries += 1;
      await released;
      await route.fulfill({ response });
    });

    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    // Captured while the placeholders are still on screen, which they are for
    // exactly as long as this test needs them to be.
    const body = page.getByTestId('leaderboard-body');
    await expect(page.getByTestId('leaderboard-skeleton')).toBeVisible();
    const whileLoading = (await body.boundingBox())!.height;

    releaseQuery();
    await expect(page.getByTestId('leaderboard-skeleton')).toHaveCount(0);

    // The intercept is load-bearing, so prove it matched. Without this, an
    // intercept that silently stopped matching would leave the test passing by
    // luck again — the same silent-hollowing failure `CLAUDE.md` §4.6
    // catalogues.
    expect(heldQueries, 'leaderboard queries held open by the intercept').toBeGreaterThan(0);

    const loaded = await body.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      // Ten row-height boxes, whatever mix of entries and fillers they are.
      rows: element.querySelectorAll(
        'li, :scope > div[aria-hidden="true"]:not([data-cy="leaderboard-skeleton"])',
      ).length,
    }));

    expectUnmoved(loaded.height, whileLoading, 'leaderboard height');
    expect(loaded.rows, 'leaderboard rows').toBe(10);
  });

  test('only credits score for correct answers', async ({ page }) => {
    await startGame(page, 5);

    // Miss the first question on purpose, then answer the rest correctly.
    const [, ...restCorrect] = CORRECT_ANSWERS;
    const wrongAnswer = questionsFixture.results[0].incorrect_answers[0];
    await answerQuestion(page, wrongAnswer);
    await expect(page.getByText(`Question 2 / ${CORRECT_ANSWERS.length}`)).toBeVisible();
    await expect(page.getByText('Score: 0')).toBeVisible();

    for (const answer of restCorrect) {
      await answerQuestion(page, answer);
    }

    await expect(page).toHaveURL(/\/game-over$/);
    // Exact for the reason given on the same assertion in the first test: a
    // leaderboard row reading `4 / 5 (80%)` matches the substring form too.
    await expect(
      page.getByText(`${restCorrect.length} / ${CORRECT_ANSWERS.length}`, { exact: true }),
    ).toBeVisible();
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
  test('recaps every answer of the round, right and wrong alike', async ({ page }) => {
    await startGame(page, 5);

    const wrongAnswer = questionsFixture.results[0].incorrect_answers[0];
    await answerQuestion(page, wrongAnswer);
    const [, ...restCorrect] = CORRECT_ANSWERS;
    for (const answer of restCorrect) {
      await answerQuestion(page, answer);
    }

    await expect(page).toHaveURL(/\/game-over$/);

    // Collapsed by default, and the header carries the tally.
    //
    // Three separate assertions on the same element rather than a chain: an
    // attribute assertion that changes its own subject is how a chained check
    // stops being about the element it named (`CLAUDE.md` §4.6). Each of these
    // retries on its own and none of them moves the subject.
    const toggle = page.getByTestId('recap-toggle');
    await expect(toggle).toContainText('Review answers');
    await expect(toggle).toContainText('(4/5 correct)');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('recap-panel')).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('recap-row')).toHaveCount(5);

    // The missed question shows what was picked *and* what was right; the
    // rest show only the pick, which is the same string either way.
    const missed = page.getByTestId('recap-row').first();
    await expect(missed).toContainText(questionsFixture.results[0].question);
    await expect(missed.getByTestId('recap-picked')).toContainText(wrongAnswer);
    await expect(missed.getByTestId('recap-correct')).toContainText(CORRECT_ANSWERS[0]);

    const second = page.getByTestId('recap-row').nth(1);
    await expect(second.getByTestId('recap-picked')).toContainText(CORRECT_ANSWERS[1]);
    await expect(second.getByTestId('recap-correct')).toHaveCount(0);

    // Nothing timed out — every question was answered well inside 15s.
    await expect(page.getByTestId('recap-timed-out')).toHaveCount(0);

    await toggle.click();
    await expect(page.getByTestId('recap-panel')).toHaveCount(0);
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
  test('does not move anything above it when the recap expands', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 1000 });
    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    // Settle the board first — see above.
    await expect(page.getByTestId('leaderboard-skeleton')).toHaveCount(0);
    const toggle = page.getByTestId('recap-toggle');
    await toggle.scrollIntoViewIfNeeded();

    const before = await documentTops(page);

    await toggle.click();
    await expect(page.getByTestId('recap-panel')).toBeVisible();

    // One retrying poll over all three, rather than three separate assertions:
    // they retry together, so a transient half-applied layout cannot satisfy
    // them one at a time.
    await expect
      .poll(() => documentTops(page), {
        message:
          'expanding the recap must not move the score card, the leaderboard, or the toggle itself',
      })
      .toEqual(before);
  });

  /**
   * `FEAT-002`. The lifelines are three interactions the unit layer can only
   * check in pieces — jsdom has no real click-to-disable, and the ids recorded
   * during play are only proved to match the recap by a real round.
   */
  test('spends each lifeline once, and a skip reads as skipped at game over', async ({ page }) => {
    await startGame(page, 5);

    // All three offered on a timed game, none spent.
    await expect(page.getByTestId('lifelines')).toHaveAttribute('aria-label', 'Lifelines');
    await expect(page.getByTestId('lifeline-fiftyFifty')).toBeEnabled();
    await expect(page.getByTestId('lifeline-extraTime')).toBeEnabled();
    await expect(page.getByTestId('lifeline-skip')).toBeEnabled();

    // 50/50 removes two of the four options and cannot be used twice.
    await expect(page.getByTestId('answer-option')).toHaveCount(4);
    await page.getByTestId('lifeline-fiftyFifty').click();
    await expect(page.locator('[data-cy="answer-option"][data-eliminated]')).toHaveCount(2);
    // The options stay in the DOM — the grid must not collapse under the
    // player's cursor (`CLAUDE.md` §4.4).
    await expect(page.getByTestId('answer-option')).toHaveCount(4);
    await expect(page.getByTestId('lifeline-fiftyFifty')).toBeDisabled();

    // Answer the first question with a surviving option.
    await page.locator('[data-cy="answer-option"]:not([data-eliminated])').first().click();
    await expect(page.getByText('Question 2 / 5')).toBeVisible();
    // Spent for the round, not just for that question.
    await expect(page.getByTestId('lifeline-fiftyFifty')).toBeDisabled();
    // ...and the elimination does not follow us to the next question.
    await expect(page.locator('[data-cy="answer-option"][data-eliminated]')).toHaveCount(0);

    // Skip advances immediately — no result banner, no 2s wait.
    await page.getByTestId('lifeline-skip').click();
    await expect(page.getByText('Question 3 / 5')).toBeVisible();
    await expect(page.getByTestId('lifeline-skip')).toBeDisabled();

    // Extra time is spendable once.
    await page.getByTestId('lifeline-extraTime').click();
    await expect(page.getByTestId('lifeline-extraTime')).toBeDisabled();

    // Finish the round.
    await page.getByTestId('answer-option').first().click();
    await expect(page.getByText('Question 4 / 5')).toBeVisible();
    await page.getByTestId('answer-option').first().click();
    await expect(page.getByText('Question 5 / 5')).toBeVisible();
    await page.getByTestId('answer-option').first().click();

    await expect(page).toHaveURL(/\/game-over$/);

    // The skipped question reads as skipped, not as a timeout — and it still
    // counts, so the recap has all five rows.
    await page.getByTestId('recap-toggle').click();
    await expect(page.getByTestId('recap-row')).toHaveCount(5);
    await expect(page.getByTestId('recap-skipped')).toHaveCount(1);
    await expect(page.getByTestId('recap-timed-out')).toHaveCount(0);
    await expect(page.getByTestId('recap-row').nth(1).getByTestId('recap-picked')).toContainText(
      'You skipped this',
    );
  });

  // A skip must not shrink the denominator — see `registerSkippedQuestion`.
  test('counts a skipped question in the score denominator', async ({ page }) => {
    await startGame(page, 5);

    await page.getByTestId('lifeline-skip').click();
    await expect(page.getByText('Question 2 / 5')).toBeVisible();
    const [, ...rest] = CORRECT_ANSWERS;
    for (const answer of rest) {
      await answerQuestion(page, answer);
    }

    await expect(page).toHaveURL(/\/game-over$/);
    // Four right out of five, not four out of four. Exact, so that neither of
    // these can be satisfied by a leaderboard row reading `4 / 5 (80%)`.
    await expect(page.getByText('4 / 5', { exact: true })).toBeVisible();
    await expect(page.getByText('80%', { exact: true })).toBeVisible();
  });

  // Hidden rather than disabled, because there is no countdown to extend.
  test('offers no Extra Time on an unlimited game', async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');
    await page.locator('#amount').selectOption({ label: '5' });
    await optionLabel(page, page.getByTestId('time-limit-unlimited')).click();
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await waitForPlayRoute(page);

    await expect(page.getByTestId('lifeline-extraTime')).toHaveCount(0);
    await expect(page.getByTestId('lifeline-fiftyFifty')).toHaveCount(1);
    await expect(page.getByTestId('lifeline-skip')).toHaveCount(1);
  });
});

test.describe('anonymous game flow (custom source)', () => {
  // Unique per run so concurrent CI runs — and concurrent workers against the
  // one shared emulator — never race on the same doc IDs.
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

  test('reads questions from the seeded Firestore question bank', async ({ page, firebase }) => {
    await firebase.seedCustomQuestions(customQuestions);
    await stubOpenTrivia(page);
    await page.goto('/');
    await page.locator('#amount').selectOption({ label: '5' });
    await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();

    await expect(page).toHaveURL(/\/play$/);

    // How many questions the game *actually* drew, rather than assuming it is
    // the two seeded above. Against a private emulator it would be exactly
    // those two, but this emulator is shared by every worker in the run — and
    // the same spec runs against the real project on the preview job, where
    // the bank holds every other custom question that exists. Hard-coding 2
    // made this test fail the moment that count drifted, for reasons no PR's
    // diff could explain.
    const label = await page
      .getByText(/Question 1 \/ \d+/)
      .first()
      .textContent();
    const total = Number(/\/\s*(\d+)/.exec(label ?? '')?.[1]);
    expect(total, 'questions drawn from the custom bank').toBeGreaterThan(0);

    // Whichever option is on screen — the point here is that a custom game
    // sources real questions and completes, not what it scores (the
    // open_trivia tests above own scoring).
    for (let i = 0; i < total; i++) {
      await page.getByTestId('answer-option').first().click();
    }

    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByText(`/ ${total}`).first()).toBeVisible();
  });
});

/**
 * The reserved cell of the game-over score card, and how each of its faces
 * measures against it.
 *
 * Reported as one value so a single poll can hold the whole property: how many
 * faces are stacked in the cell, whether the cell collapsed to nothing, and
 * which faces — named — differ from the reserved height.
 */
async function measureScoreCardFaces(
  card: Locator,
): Promise<{ faces: number; collapsed: boolean; mismatched: string[] }> {
  const measured = await card.evaluate((element) => ({
    cell: element.getBoundingClientRect().height,
    faces: [...element.children].map((face) => ({
      name: face.getAttribute('data-cy'),
      height: face.getBoundingClientRect().height,
    })),
  }));

  return {
    faces: measured.faces.length,
    collapsed: measured.cell <= 0,
    mismatched: measured.faces
      .filter((face) => drift(face.height, measured.cell) !== 0)
      .map((face) => `${face.name} (${face.height} vs ${measured.cell})`),
  };
}

/**
 * The document-relative top of each box the recap must not disturb.
 *
 * Rounded, because a sub-pixel difference here is layout rounding rather than
 * movement, and the assertion is a deep equality rather than a tolerance.
 */
function documentTops(page: Page): Promise<Record<string, number>> {
  const watched = ['score-action', 'leaderboard-body', 'recap-toggle'];
  return page.evaluate(
    (names) =>
      Object.fromEntries(
        names.map((name) => [
          name,
          Math.round(
            document.querySelector(`[data-cy="${name}"]`)!.getBoundingClientRect().top +
              window.scrollY,
          ),
        ]),
      ),
    watched,
  );
}
