import { Locator, Page, Response } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { FirebaseBackend } from '../../fixtures/firebase-backend';
import { CustomQuestionSeed, QuestionCountersRecord } from '../../fixtures/types';
import { signInViaUi } from '../../support/auth';
import { answerQuestion } from '../../support/game';
import { drift } from '../../support/layout';
import { stubOpenTrivia } from '../../support/open-trivia';
import { runTag, startTopicGame } from '../../support/topics';

const password = 'Str0ngPassw0rd!';

/** Unique per test: workers share one emulator and nothing resets between tests. */
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Difficulty calibrated from real play (`FEAT-023`), at the two layers no unit
 * test reaches.
 *
 * **The counters.** `recordGameResult` adds a signed-in game to `answered` and
 * `correct` on each bank question it held, inside the transaction that banks the
 * player's totals — and nothing in the DOM changes when it does, so every
 * assertion reads the documents through the Admin SDK and polls the read
 * (`CLAUDE.md` §4.6). The cases are the ones a reload, a guest and a withdrawn
 * question would get wrong, each of which looks identical from the screen.
 *
 * **The recap.** Each community question's row shows the difficulty its players
 * have measured — the band word alone, in the pill its label used to occupy —
 * derived from the counters the question carried when the game drew it.
 *
 * Under `authenticated/`, and therefore off the preview slice: the counters are
 * written by the real `recordGameResult`, which a preview channel shares with
 * the deployed project (`docs/ci-cd.md` §4.3). Every game here is played with
 * **no time limit**, so a starved worker cannot turn a question into a timeout
 * and make a test about the counters into one about the countdown.
 */
test.describe('per-question difficulty (FEAT-023)', () => {
  /**
   * A question's wording: unique per seed, since the id carries the test's run
   * id, and the same length for every seed of one test — which is what lets
   * the size test compare two rows that differ in their counters alone.
   */
  const wordingOf = (id: string) => `Difficulty question ${id}?`;

  /**
   * A bank question for one of these tests, under the test's own topic so the
   * draw can serve nothing else (`e2e/support/topics.ts`).
   */
  function bankQuestion(
    id: string,
    topic: string,
    overrides: Partial<CustomQuestionSeed> = {},
  ): CustomQuestionSeed {
    return {
      id,
      type: 'multiple',
      difficulty: 'medium',
      question: wordingOf(id),
      correct_answer: 'Right',
      incorrect_answers: ['Wrong a', 'Wrong b', 'Wrong c'],
      tags: [topic],
      ...overrides,
    };
  }

  /**
   * Polls the counters until they read `expected`.
   *
   * `recordGameResult` is fire-and-forget by design, so there is no locator to
   * wait on; an Admin-SDK read is a single `await`, and an assertion made
   * against one reads the database once — a race by construction. Polling the
   * read is what retries.
   */
  async function expectCounters(
    firebase: FirebaseBackend,
    expected: Record<string, QuestionCountersRecord>,
  ): Promise<void> {
    await expect
      .poll(() => firebase.getQuestionCounters(Object.keys(expected)), {
        message:
          'the counters never reached the expected values. recordGameResult is fire-and-forget, ' +
          'so either it was not called, it refused the game, or it counted it wrongly.',
      })
      .toEqual(expected);
  }

  /** Waits for the results screen's own call to the callable to come back. */
  function recordGameResultResponse(page: Page) {
    return page.waitForResponse(
      (response) =>
        /\/recordGameResult(\?|$)/.test(response.url()) && response.request().method() === 'POST',
    );
  }

  /** What the callable answered, out of the callable protocol's envelope. */
  async function callableResult(response: Response): Promise<unknown> {
    return ((await response.json()) as { result?: unknown }).result;
  }

  /**
   * One label answers every question of these games, whichever order the draw
   * deals them in — the draw is random, so a loop answering question by
   * question in seed order fails on whichever comes first.
   */
  async function answerEveryQuestion(page: Page, count: number, label: string): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await answerQuestion(page, label);
    }
    await expect(page).toHaveURL(/\/game-over$/);
  }

  async function signedInPlayer(page: Page, firebase: FirebaseBackend): Promise<void> {
    const email = `difficulty-${unique()}@example.com`;
    await firebase.createVerifiedUser({ email, password });
    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);
  }

  /**
   * The whole loop, end to end: a signed-in game adds one answer to each bank
   * question it held and one right answer where it was right, and a reload of
   * `/game-over` — which calls the callable again with the same game — adds
   * nothing more.
   *
   * **One label answers both questions, and it is right on one and wrong on
   * the other**, so the draw's order cannot decide which question is counted
   * right. The reload half waits on the callable's own response before reading,
   * because "still the same" read before the second call lands would pass
   * against the very double count it exists to catch — and it starts listening
   * only once the first call has answered, and checks the answer is the
   * duplicate refusal, so the response it waits on cannot be the first game's
   * still arriving.
   */
  test('adds a signed-in game to each bank question once, and a reload adds nothing', async ({
    page,
    firebase,
  }) => {
    const topic = runTag('difficulty');
    const runId = unique();
    const playedBefore = `difficulty-${runId}-played`;
    const fresh = `difficulty-${runId}-fresh`;
    await firebase.seedCustomQuestions([
      // "Shared" is this question's right answer…
      bankQuestion(playedBefore, topic, {
        correct_answer: 'Shared',
        incorrect_answers: ['Decoy 1', 'Decoy 2', 'Decoy 3'],
        answered: 4,
        correct: 1,
      }),
      // …and one of this question's wrong ones.
      bankQuestion(fresh, topic, {
        correct_answer: 'Its own answer',
        incorrect_answers: ['Shared', 'Decoy 4', 'Decoy 5'],
      }),
    ]);

    await signedInPlayer(page, firebase);
    await startTopicGame(page, { topics: [topic], found: 2, noTimeLimit: true });
    const banked = recordGameResultResponse(page);
    await answerEveryQuestion(page, 2, 'Shared');
    expect(await callableResult(await banked)).toEqual({ recorded: true });

    await expectCounters(firebase, {
      [playedBefore]: { answered: 5, correct: 2 },
      [fresh]: { answered: 1, correct: 0 },
    });

    const reloaded = recordGameResultResponse(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Game Over!', exact: true })).toBeVisible();
    expect(await callableResult(await reloaded)).toEqual({ recorded: false, reason: 'duplicate' });

    expect(
      await firebase.getQuestionCounters([playedBefore, fresh]),
      'a reload of the results screen is refused as a duplicate, and moves no counter',
    ).toEqual({
      [playedBefore]: { answered: 5, correct: 2 },
      [fresh]: { answered: 1, correct: 0 },
    });
  });

  /**
   * An author can withdraw a question between the draw and the end of the
   * game. The transaction must skip it — an `update` on a missing document
   * would fail the whole call and cost the player their totals, and a merging
   * `set` would bring back a two-field husk of a question its author removed.
   *
   * Asserted after the surviving question's counters have moved, so the
   * absence below is read after the transaction that could have created it.
   */
  test('skips a question withdrawn mid-game, and never re-creates it', async ({
    page,
    firebase,
  }) => {
    const topic = runTag('difficulty');
    const runId = unique();
    const kept = `difficulty-${runId}-kept`;
    const withdrawn = `difficulty-${runId}-withdrawn`;
    await firebase.seedCustomQuestions([bankQuestion(kept, topic), bankQuestion(withdrawn, topic)]);

    await signedInPlayer(page, firebase);
    await startTopicGame(page, { topics: [topic], found: 2, noTimeLimit: true });
    // Drawn and on screen, and now gone from the bank.
    await firebase.deleteCustomQuestion(withdrawn);
    await answerEveryQuestion(page, 2, 'Right');

    await expectCounters(firebase, { [kept]: { answered: 1, correct: 1 } });
    expect(
      await firebase.getQuestionCounters([withdrawn]),
      'the withdrawn question is not brought back by the count',
    ).toEqual({ [withdrawn]: null });
  });

  /**
   * Anonymous play adds nothing, which is the Privacy Policy's sentence: the
   * shared caller gate (`functions/src/caller-gate.ts`) refuses a guest before
   * anything is written, counters included — and says why, `anonymous`, which
   * is the refusal the client keeps quiet about. Read after the callable has
   * answered, so "unchanged" cannot mean "not yet".
   */
  test('counts nothing for an anonymous player', async ({ page, firebase }) => {
    const topic = runTag('difficulty');
    const id = `difficulty-${unique()}-guest`;
    await firebase.seedCustomQuestions([bankQuestion(id, topic, { answered: 3, correct: 2 })]);

    await stubOpenTrivia(page);
    await page.goto('/');
    await startTopicGame(page, { topics: [topic], found: 1, noTimeLimit: true });
    const recorded = recordGameResultResponse(page);
    await answerEveryQuestion(page, 1, 'Right');
    await expect(page.getByText('Sign in to save this score to the leaderboard.')).toBeVisible();
    expect(await callableResult(await recorded)).toEqual({
      recorded: false,
      reason: 'anonymous',
      provider: 'anonymous',
    });

    expect(await firebase.getQuestionCounters([id])).toEqual({
      [id]: { answered: 3, correct: 2 },
    });
  });

  /**
   * The recap reads the difficulty off the counters the question carried when
   * the game drew it, and shows the band alone. The seed is chosen so that
   * both halves of that sentence show: 7 answers, 2 right, on four options is
   * barely above chance — a twenty-first of players knowing it — so a medium
   * label (0.5, worth ten answers) gives (10 × 0.5 + 7 × 20/21) / 17 = 0.69,
   * which is **hard**, not the medium it was labelled. And this game's right
   * answer makes it 8 and 3, (10 × 0.5 + 8 × 5/6) / 18 = 0.65, which would be
   * **medium** again — so a recap that re-read the question after the game
   * would say so. A question nobody has played reads its label.
   *
   * Not the counts this game has since added: the band is about the question
   * the player was dealt.
   */
  test("shows each community question's measured difficulty in the recap", async ({
    page,
    firebase,
  }) => {
    const topic = runTag('difficulty');
    const runId = unique();
    const calibrated = `difficulty-${runId}-calibrated`;
    const unplayed = `difficulty-${runId}-unplayed`;
    await firebase.seedCustomQuestions([
      bankQuestion(calibrated, topic, { difficulty: 'medium', answered: 7, correct: 2 }),
      bankQuestion(unplayed, topic, { difficulty: 'easy' }),
    ]);

    await signedInPlayer(page, firebase);
    await startTopicGame(page, { topics: [topic], found: 2, noTimeLimit: true });
    await answerEveryQuestion(page, 2, 'Right');

    const rows = await openRecap(page);
    await expect(rowFor(rows, wordingOf(calibrated)).getByTestId('recap-difficulty')).toHaveText(
      'hard',
    );
    await expect(rowFor(rows, wordingOf(unplayed)).getByTestId('recap-difficulty')).toHaveText(
      'easy',
    );
    // The band alone: no score anywhere in the row.
    await expect(rowFor(rows, wordingOf(calibrated))).not.toContainText(/\d\.\d/);

    // …and the counts the game has since added do not move it, reloaded or
    // not: the recap is rebuilt from the question as it was drawn.
    await expectCounters(firebase, {
      [calibrated]: { answered: 8, correct: 3 },
      [unplayed]: { answered: 1, correct: 1 },
    });
    await page.reload();
    const reloadedRows = await openRecap(page);
    await expect(
      rowFor(reloadedRows, wordingOf(calibrated)).getByTestId('recap-difficulty'),
    ).toHaveText('hard');
  });

  /**
   * **The row keeps its size** (`CLAUDE.md` §4.4). The measured band is shown
   * in the label's own pill rather than on a line of its own, and a question
   * nobody has played reads its label in the same box — so a calibrated row and
   * an uncalibrated one with the same content are the same height, and the
   * pill sits on the line the topic already occupies.
   *
   * Measured at a phone and a desktop width, because whether a row wraps is a
   * question about the width it is given; one viewport cannot answer it for
   * the other.
   */
  for (const viewport of [
    { width: 390, height: 1000 },
    { width: 1024, height: 900 },
  ]) {
    test.describe(`at ${viewport.width}×${viewport.height}`, () => {
      test.use({ viewport });

      test('a calibrated row and an uncalibrated one are the same height', async ({
        page,
        firebase,
      }) => {
        const topic = runTag('difficulty');
        const runId = unique();
        // The same wording, length for length, and the same answers: the rows
        // differ in their counters and nothing else. Both land in the same
        // band, so the two pills hold the same word.
        const calibrated = `difficulty-${runId}-a`;
        const unplayed = `difficulty-${runId}-b`;
        await firebase.seedCustomQuestions([
          bankQuestion(calibrated, topic, { answered: 20, correct: 10 }),
          bankQuestion(unplayed, topic),
        ]);

        await signedInPlayer(page, firebase);
        await startTopicGame(page, { topics: [topic], found: 2, noTimeLimit: true });
        await answerEveryQuestion(page, 2, 'Right');

        const rows = await openRecap(page);
        const calibratedRow = rowFor(rows, wordingOf(calibrated));
        const unplayedRow = rowFor(rows, wordingOf(unplayed));
        // Half right on four options is a third of players knowing it:
        // (10 × 0.5 + 20 × 2/3) / 30 = 0.61, which is medium.
        await expect(calibratedRow.getByTestId('recap-difficulty')).toHaveText('medium');
        await expect(unplayedRow.getByTestId('recap-difficulty')).toHaveText('medium');

        // The content of each row, inside its padding and border: the list's
        // last row has no bottom border, and which of the two comes last is
        // the draw's random order rather than anything about calibration —
        // measuring the `<li>` itself failed by exactly that 1px, once in each
        // direction. Polled as a pair, so a late layout frame retries both
        // readings together rather than racing one against the other
        // (`CLAUDE.md` §4.6).
        const content = (row: Locator) => row.locator(':scope > div');
        await expect
          .poll(async () => {
            const [a, b] = await Promise.all([
              content(calibratedRow).boundingBox(),
              content(unplayedRow).boundingBox(),
            ]);
            return a && b ? drift(a.height, b.height) : Number.NaN;
          })
          .toBe(0);

        if (viewport.width >= 1024) {
          // Wide enough for the pills to share a line: the calibrated
          // difficulty sits on the topic's line rather than starting its own.
          await expect
            .poll(async () => {
              const [topicPill, difficultyPill] = await Promise.all([
                calibratedRow.getByTestId('recap-topic').boundingBox(),
                calibratedRow.getByTestId('recap-difficulty').boundingBox(),
              ]);
              return topicPill && difficultyPill
                ? drift(topicPill.y, difficultyPill.y)
                : Number.NaN;
            })
            .toBe(0);
        }
      });
    });
  }

  /** Opens the recap and returns its rows. */
  async function openRecap(page: Page): Promise<Locator> {
    await page.getByTestId('recap-toggle').click();
    await expect(page.getByTestId('recap-panel')).toBeVisible();
    return page.getByTestId('recap-row');
  }

  /** The recap row for one seeded question, found by its wording — which is unique per test. */
  function rowFor(rows: Locator, wording: string): Locator {
    return rows.filter({ hasText: wording });
  }
});
