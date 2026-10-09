import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { CustomQuestionSeed } from '../../fixtures/types';
import { expectRadiosAreGrouped } from '../../support/a11y';
import { waitForAnonymousSession } from '../../support/auth';
import { answerQuestion, optionLabel, waitForPlayRoute } from '../../support/game';
import { expectBoxUnmoved, expectUnmoved, settledBox } from '../../support/layout';
import { holdRequests } from '../../support/requests';
import { runTag } from '../../support/topics';

/**
 * `FEAT-024` in a real browser: a curated quiz is read from its address,
 * played through the same loop as a drawn game in the order its curator chose,
 * and finished without a leaderboard entry.
 *
 * **Seeded through the `firebase` fixture, because nothing else can write a
 * quiz.** `firestore.rules` refuses every client write to `quizzes`, so the
 * suite stands in for the console with the Admin SDK (`seedQuiz`), and the
 * quiz's questions are approved `custom_questions` seeded the same way. Each
 * question carries a run tag of its own (`e2e/support/topics.ts`) so nothing a
 * test seeds can turn up in another worker's topic-filtered draw.
 *
 * Emulator-only for now, and not for a reason about the spec: a preview channel
 * runs whatever `firestore.rules` `main` last deployed, and until this feature
 * merges that is a rule set with no `quizzes` block — so every quiz read there
 * is refused (`playwright.preview.config.ts` says the rest).
 */

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type SeededQuestion = CustomQuestionSeed & { id: string };

/**
 * A question this test alone has seeded, with its own text and its own correct
 * answer, so the loop can be driven — and its order read — by text alone.
 */
function questionFor(
  runId: string,
  tag: string,
  label: string,
  status: 'approved' | 'pending' = 'approved',
): SeededQuestion {
  return {
    id: `quiz-${runId}-${label}`,
    tags: [tag],
    type: 'multiple',
    difficulty: 'easy',
    status,
    question: `Curated question ${label} (${runId})?`,
    correct_answer: `Right ${label}`,
    incorrect_answers: [`Wrong ${label} 1`, `Wrong ${label} 2`, `Wrong ${label} 3`],
  };
}

/** What a page has read from Firestore, by what it was for. */
interface ReadCounts {
  /** `GET quizzes/{id}` — the quiz itself. */
  quiz: number;
  /** A query over `custom_questions` — the quiz's questions, all at once. */
  questionQueries: number;
  /** `GET custom_questions/{id}` — the quiz's questions, one at a time. */
  questionGets: number;
  /** A query over any board under `leaderboards`. */
  leaderboard: number;
}

/**
 * Counts the Firestore requests a page sends, by what they read.
 *
 * Method-filtered on purpose: an authenticated request carries an
 * `Authorization` header, so the browser sends a CORS preflight to the same URL
 * first, and counting that would count every read twice.
 */
function countReads(page: Page): ReadCounts {
  const counts: ReadCounts = { quiz: 0, questionQueries: 0, questionGets: 0, leaderboard: 0 };
  page.on('request', (request) => {
    const url = request.url();
    if (request.method() === 'GET' && /\/documents\/quizzes\/[^/?]+(\?|$)/.test(url)) {
      counts.quiz += 1;
      return;
    }
    if (request.method() === 'GET' && /\/documents\/custom_questions\/[^/?]+(\?|$)/.test(url)) {
      counts.questionGets += 1;
      return;
    }
    if (request.method() !== 'POST' || !/:runQuery(\?|$)/.test(url)) {
      return;
    }
    if (/\/documents\/leaderboards\//.test(url)) {
      counts.leaderboard += 1;
    } else if ((request.postData() ?? '').includes('"collectionId":"custom_questions"')) {
      counts.questionQueries += 1;
    }
  });
  return counts;
}

/**
 * Records `count` free games as played today, straight into IndexedDB — the
 * write `daily-game-limit.spec.ts` makes, for its reason: so a test does not
 * have to play them. It attaches to the database the app has already opened,
 * so call it once the allowance has rendered a count.
 */
async function seedFreeGamesPlayed(page: Page, count: number): Promise<void> {
  const now = new Date();
  const date = [
    now.getFullYear(),
    `${now.getMonth() + 1}`.padStart(2, '0'),
    `${now.getDate()}`.padStart(2, '0'),
  ].join('-');
  await page.evaluate(
    (record) =>
      new Promise<void>((resolve, reject) => {
        const open = window.indexedDB.open('trivia-offline');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('daily-limit', 'readwrite');
          tx.objectStore('daily-limit').put({ id: 'today', ...record });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error as Error);
          };
        };
        open.onerror = () => reject(open.error as Error);
      }),
    { date, count },
  );
}

const START = 'start-quiz';

test.describe('a curated quiz, played from /quiz/:quizId (FEAT-024)', () => {
  test('plays its questions in the curator’s order, skips one it cannot play, and ranks nothing', async ({
    page,
    firebase,
  }) => {
    const runId = unique();
    const tag = runTag('quiz');
    // Named so the curator's order is neither the ids' order nor the seeding
    // order: a reader that sorted, or returned whatever the query did, would
    // play these differently.
    const [c, a, d, b] = ['c', 'a', 'd', 'b'].map((label) => questionFor(runId, tag, label));
    const pending = questionFor(runId, tag, 'pending', 'pending');
    await firebase.seedCustomQuestions([a, b, c, d, pending]);

    const quizId = `e2e-quiz-${runId}`;
    const title = `The e2e quiz ${runId}`;
    await firebase.seedQuiz({
      id: quizId,
      title,
      description: 'Four questions, in an order somebody chose.',
      questionIds: [c.id, a.id, pending.id, d.id, b.id],
      suggestedTimeLimit: 30,
    });

    const reads = countReads(page);
    await page.goto(`/quiz/${quizId}`);

    await expect(page.getByTestId('quiz-title')).toHaveText(title);
    await expect(page.getByTestId('quiz-description')).toHaveText(
      'Four questions, in an order somebody chose.',
    );
    await expect(page.getByTestId('quiz-question-count')).toHaveText(
      '4 questions, in the order they were chosen',
    );
    // Said before Start: the pending question is not played, and the page says
    // so rather than letting a five-question quiz quietly play four.
    await expect(page.getByTestId('quiz-unavailable')).toHaveText(
      '1 of its 5 questions cannot be played right now, so it plays the other 4.',
    );
    await expect(page.getByTestId('quiz-status')).toHaveText('Quiz ready: 4 questions.');

    // Bounded reads, all on arrival (`CLAUDE.md` §4.1): the quiz by its id,
    // then one query for every question it names — which the rules refuse
    // whole, because it names a question this reader may not read — and so
    // one get per id, of which the pending one is refused and skipped.
    // Counted once the page shows what the reads returned, so none can still
    // be in flight.
    expect(reads.quiz, 'reads of the quiz document').toBe(1);
    expect(reads.questionQueries, 'queries for the quiz’s questions').toBe(1);
    expect(reads.questionGets, 'per-question reads after the query was refused').toBe(5);

    // The suggestion pre-selects the picker and says it is a suggestion…
    await expect(page.getByTestId('quiz-time-limit-30')).toBeChecked();
    await expect(page.getByTestId('quiz-suggested-limit')).toHaveText(
      'Suggested for this quiz: 30 seconds.',
    );
    await expectRadiosAreGrouped(page);
    // …and never locks it: the player turns the countdown off (WCAG 2.2.1).
    await optionLabel(page, page.getByTestId('quiz-time-limit-unlimited')).click();
    await expect(page.getByTestId('quiz-time-limit-unlimited')).toBeChecked();

    await page.getByTestId(START).click();
    await waitForPlayRoute(page);

    // The limit the player picked, not the one the quiz suggested.
    await expect(page.getByTestId('question-timer')).toHaveCount(0);
    await expect(page.getByTestId('no-time-limit')).toContainText('No time limit');

    for (const question of [c, a, d, b]) {
      await expect(page.getByTestId('question-text')).toHaveText(question.question);
      await answerQuestion(page, question.correct_answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    // The quiz face, in place of the sign-in prompt an anonymous player is
    // otherwise shown: a quiz is not ranked, so there is nothing to sign in
    // and save.
    await expect(page.getByTestId('score-quiz')).toBeVisible();
    await expect(page.getByTestId('score-quiz')).toContainText(
      "Quizzes aren't ranked on a leaderboard.",
    );
    await expect(page.getByTestId('score-sign-in')).toBeHidden();
    await expect(page.getByTestId('score-save')).toBeHidden();
    // No board is shown, and none is read.
    await expect(page.getByTestId('leaderboard-card')).toHaveCount(0);
    expect(reads.leaderboard, 'leaderboard queries on a quiz’s results').toBe(0);
  });

  test('a quiz whose questions can all be read costs one query for them', async ({
    page,
    firebase,
  }) => {
    const runId = unique();
    const tag = runTag('quiz-reads');
    const questions = ['a', 'b'].map((label) => questionFor(runId, tag, label));
    await firebase.seedCustomQuestions(questions);
    const quizId = `e2e-reads-${runId}`;
    await firebase.seedQuiz({
      id: quizId,
      title: `Read once ${runId}`,
      questionIds: questions.map((question) => question.id),
    });

    const reads = countReads(page);
    await page.goto(`/quiz/${quizId}`);

    await expect(page.getByTestId('quiz-question-count')).toHaveText(
      '2 questions, in the order they were chosen',
    );
    await expect(page.getByTestId('quiz-unavailable')).toHaveCount(0);
    expect(reads.quiz, 'reads of the quiz document').toBe(1);
    expect(reads.questionQueries, 'queries for the quiz’s questions').toBe(1);
    expect(reads.questionGets, 'per-question reads').toBe(0);
  });

  test('an address with no published quiz behind it says so, inside the app', async ({
    page,
    firebase,
  }) => {
    const runId = unique();
    const tag = runTag('quiz-gone');
    const question = questionFor(runId, tag, 'only');
    await firebase.seedCustomQuestions([question]);
    const draftId = `e2e-draft-${runId}`;
    await firebase.seedQuiz({
      id: draftId,
      title: `A draft ${runId}`,
      questionIds: [question.id],
      isPublished: false,
    });

    // A draft and an address that names nothing read the same, on purpose:
    // telling them apart would tell a stranger which drafts exist.
    for (const quizId of [draftId, `e2e-missing-${runId}`]) {
      await page.goto(`/quiz/${quizId}`);

      await expect(page.getByTestId('quiz-not-found')).toBeVisible();
      await expect(page.getByTestId('quiz-title')).toHaveText('Quiz not found');
      await expect(page.getByTestId('quiz-status')).toHaveText('Quiz not found.');
      await expect(page.getByTestId(START)).toHaveCount(0);
      // Inside the shell — the top bar and its account chip are still there —
      // rather than a blank page.
      await expect(page.getByTestId('auth-menu-trigger')).toBeVisible();
    }

    await page.getByRole('link', { name: 'Play a random game', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('a quiz with nothing it can play says so instead of starting', async ({
    page,
    firebase,
  }) => {
    const runId = unique();
    const tag = runTag('quiz-empty');
    const pending = questionFor(runId, tag, 'pending', 'pending');
    await firebase.seedCustomQuestions([pending]);
    const quizId = `e2e-empty-${runId}`;
    const title = `Nothing playable ${runId}`;
    await firebase.seedQuiz({
      id: quizId,
      title,
      // One question waiting on review, one that was never there.
      questionIds: [pending.id, `quiz-${runId}-deleted`],
    });

    await page.goto(`/quiz/${quizId}`);

    await expect(page.getByTestId('quiz-title')).toHaveText(title);
    await expect(page.getByTestId('quiz-empty')).toContainText(
      "None of this quiz's questions can be played right now",
    );
    await expect(page.getByTestId(START)).toHaveCount(0);
  });

  test('a failed read offers a retry, and focus lands on the heading rather than on nothing', async ({
    page,
    firebase,
  }) => {
    const runId = unique();
    const tag = runTag('quiz-retry');
    const question = questionFor(runId, tag, 'only');
    await firebase.seedCustomQuestions([question]);
    const quizId = `e2e-retry-${runId}`;
    const title = `Read twice ${runId}`;
    await firebase.seedQuiz({ id: quizId, title, questionIds: [question.id] });

    // One handler with a flag rather than an unroute, for the reason
    // `profile-stats.spec.ts` gives: unrouting races the click that triggers
    // the next read.
    const quizDocument = new RegExp(`/documents/quizzes/${quizId}(\\?|$)`);
    let failing = true;
    let refused = 0;
    await page.route(quizDocument, async (route) => {
      if (failing && route.request().method() === 'GET') {
        refused += 1;
        await route.abort('failed');
        return;
      }
      await route.fallback();
    });

    await page.goto(`/quiz/${quizId}`);

    // "Could not be loaded", not "not found": a read that never answered has
    // established nothing about whether the quiz exists (`CLAUDE.md` §4.4).
    await expect(page.getByTestId('quiz-load-failed')).toContainText('Something went wrong');
    await expect(page.getByTestId('quiz-title')).toHaveText('This quiz could not be loaded');
    expect(refused, 'the refusal is what produced the failed state').toBeGreaterThan(0);

    failing = false;
    await page.getByTestId('quiz-retry').click();

    // The button that was pressed is gone; focus went to the heading first,
    // so it did not drop to <body> (`CLAUDE.md` §4.4, §4.5).
    await expect(page.getByTestId('quiz-title')).toHaveText(title);
    await expect(page.getByTestId('quiz-title')).toBeFocused();
    await expect(page.getByTestId(START)).toBeVisible();
  });

  /**
   * The day's last free game. Start spends it before `/play`'s chunk has
   * loaded, so the allowance reads zero while Start still says "Starting…" —
   * and the Pro offer, a far taller box, took Start's place under the pointer
   * for as long as the chunk took (`CLAUDE.md` §4.4). Held open here the way
   * the size test below holds it, so the window is measured, not caught.
   */
  test('Start keeps its box while it spends the day’s last free game', async ({
    page,
    firebase,
  }) => {
    const runId = unique();
    const tag = runTag('quiz-last-game');
    const questions = ['a', 'b'].map((label) => questionFor(runId, tag, label));
    await firebase.seedCustomQuestions(questions);
    const quizId = `e2e-last-game-${runId}`;
    await firebase.seedQuiz({
      id: quizId,
      title: `The last free game ${runId}`,
      questionIds: questions.map((question) => question.id),
    });

    await page.goto(`/quiz/${quizId}`);
    // A count on screen means the app has opened the database the seed writes to.
    await expect(page.getByTestId('quiz-daily-allowance')).toHaveText(
      '5 of 5 free games left today.',
    );
    await seedFreeGamesPlayed(page, 4);
    await page.reload();
    await expect(page.getByTestId('quiz-daily-allowance')).toHaveText(
      '1 of 5 free games left today.',
    );
    // The offer is optimistic until the entitlement is known, so wait for it:
    // the zero below is then the free tier's answer, not the window before it.
    await waitForAnonymousSession(page);

    const start = page.getByTestId(START);
    const startBox = await settledBox(start, 'Start, with one free game left');

    const playChunk = await holdRequests(page, (request) => request.resourceType() === 'script');
    await start.click();
    await playChunk.seen;
    // Spent, and saying so — the moment the offer used to arrive.
    await expect(page.getByTestId('quiz-daily-allowance')).toHaveText('No free games left today.');
    await expect(page.getByTestId('quiz-daily-limit-reached')).toHaveCount(0);
    await expect(start).toHaveText('Starting…');
    await expectBoxUnmoved(start, startBox, 'Start while it spends the last free game');

    playChunk.release();
    await waitForPlayRoute(page);
  });
});

/**
 * The quiz page keeps its size (`CLAUDE.md` §4.4), at the two viewports the
 * setup screen is measured at.
 *
 * The page is top-aligned rather than centred, so there is no centring slack
 * to hide a jump at a short viewport — a change in the card's height moves
 * only what is below it. What is measured is what the template promises: the
 * card's top does not move when the quiz arrives, nothing below the picker
 * moves when the limit changes, and Start keeps its box while it says
 * "Starting…".
 */
for (const viewport of [
  { width: 390, height: 1000 },
  { width: 1024, height: 900 },
]) {
  test.describe(`the quiz page at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test('nothing moves while it loads, while the limit changes, or while it starts', async ({
      page,
      firebase,
    }) => {
      const runId = unique();
      const tag = runTag('quiz-size');
      const questions = ['a', 'b', 'c'].map((label) => questionFor(runId, tag, label));
      await firebase.seedCustomQuestions(questions);
      const quizId = `e2e-size-${runId}`;
      await firebase.seedQuiz({
        id: quizId,
        title: `Measured ${runId}`,
        description: 'Three questions, measured at two sizes.',
        questionIds: questions.map((question) => question.id),
      });

      // Held while it loads, so the loading state can be measured rather than
      // caught in passing.
      const quizRead = await holdRequests(
        page,
        (request) =>
          request.method() === 'GET' &&
          new RegExp(`/documents/quizzes/${quizId}(\\?|$)`).test(request.url()),
      );
      await page.goto(`/quiz/${quizId}`);
      await quizRead.seen;

      const card = page.getByTestId('quiz-card');
      await expect(page.getByTestId('quiz-title')).toHaveText('Loading quiz…');
      await expect(page.getByTestId(START)).toHaveCount(0);
      const loadingTop = (await settledBox(card, 'the card while the quiz loads')).top;

      quizRead.release();
      await expect(page.getByTestId(START)).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));

      // The card grew once, downwards, to hold the quiz — its top did not move.
      const ready = await settledBox(card, 'the card once the quiz is in');
      expectUnmoved(ready.top, loadingTop, 'the card’s top as the quiz arrives');
      const start = page.getByTestId(START);
      const startBox = await settledBox(start, 'Start, at rest');

      // Every limit, and back: the note under the picker reserves the tallest
      // of its variants, so neither the card nor Start moves.
      for (const limit of ['30', 'unlimited', '15'] as const) {
        await optionLabel(page, page.getByTestId(`quiz-time-limit-${limit}`)).click();
        await expect(page.getByTestId(`quiz-time-limit-${limit}`)).toBeChecked();
        await expectBoxUnmoved(card, ready, `the quiz card after choosing ${limit}`);
        await expectBoxUnmoved(start, startBox, `Start after choosing ${limit}`);
      }

      // "Starting…" for as long as the play screen's chunk is held, which is
      // the window a slow connection would show it for.
      const playChunk = await holdRequests(page, (request) => request.resourceType() === 'script');
      await start.click();
      await playChunk.seen;
      await expect(start).toHaveText('Starting…');
      await expect(start).toBeDisabled();
      await expectBoxUnmoved(start, startBox, 'Start while it says "Starting…"');

      playChunk.release();
      await waitForPlayRoute(page);
    });
  });
}
