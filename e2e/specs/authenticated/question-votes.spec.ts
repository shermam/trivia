import { readFile } from 'node:fs/promises';
import { Locator, Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { CustomQuestionSeed } from '../../fixtures/types';
import { authMenu, openAuthMenu, signInViaUi } from '../../support/auth';
import { answerQuestion, optionLabel, startGame, waitForPlayRoute } from '../../support/game';
import { drift } from '../../support/layout';
import { CORRECT_ANSWERS, stubExtraCategory, stubOpenTrivia } from '../../support/open-trivia';

/**
 * `FEAT-027` — a private like or dislike per community question, read only by
 * the player who cast it.
 *
 * **Every claim about a vote is checked against what Firestore holds**, read
 * back through the Admin SDK (`firebase.getQuestionVote` and friends). A
 * pressed button proves the tap and nothing else: the buttons move before the
 * write behind them lands, by design, so only the stored document says the
 * write happened, under the right id, in the shape the rules allow.
 *
 * **Emulator-only**, as everything under `authenticated/` is unless
 * `playwright.preview.config.ts` lists it: these tests seed questions and call
 * `exportAccountData` and `deleteAccount`, which a preview channel would run
 * against the real project's deployed functions. The guest's test lives here
 * too, for the first of those reasons.
 *
 * **Isolation is a category this test invented**, as in
 * `question-reporting.spec.ts`: the emulator is shared by every worker, and a
 * custom-source game draws from the whole bank, so each test seeds its own
 * questions under a category nobody else can pick.
 */

const password = 'Str0ngPassw0rd!';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** This test's own slice of the bank: two community questions, one category, nobody else's. */
function seedFor(label: string): {
  category: string;
  questions: (CustomQuestionSeed & { id: string })[];
} {
  const runId = unique();
  const category = `Votes ${label} ${runId}`;
  return {
    category,
    questions: [
      {
        id: `vote-q1-${runId}`,
        category,
        type: 'multiple',
        difficulty: 'easy',
        question: `Which planet is known as the red planet? (${runId})`,
        correct_answer: 'Mars',
        incorrect_answers: ['Venus', 'Jupiter', 'Mercury'],
      },
      {
        id: `vote-q2-${runId}`,
        category,
        type: 'boolean',
        difficulty: 'easy',
        question: `The Pacific is the largest ocean on Earth. (${runId})`,
        correct_answer: 'True',
        incorrect_answers: ['False'],
      },
    ],
  };
}

type Seed = ReturnType<typeof seedFor>;
type SeededQuestion = Seed['questions'][number];

/** Seeds the slice, picks its category and the custom source, and starts the game. */
async function startCustomGame(page: Page, seed: Seed): Promise<void> {
  // Stands in for a wait on the categories request, and does more: the
  // invented category has to be in the dropdown before it can be selected.
  await expect(page.locator('#category')).toContainText(seed.category);
  await page.locator('#amount').selectOption({ label: '5' });
  await page.locator('#category').selectOption(seed.category);
  await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();
  await waitForPlayRoute(page);
}

/**
 * The seeded question on screen, once it is one not yet answered.
 *
 * The bank serves the slice in an order the test does not control, so the
 * question is identified from the heading rather than by position — and read
 * through `expect.poll`, because the quiz holds an answered question for two
 * seconds before moving on and a single read can return the old one.
 */
async function nextQuestion(
  page: Page,
  seed: Seed,
  answered = new Set<string>(),
): Promise<SeededQuestion> {
  const heading = page.getByTestId('question-text');
  let found: SeededQuestion | undefined;
  await expect
    .poll(
      async () => {
        const text = ((await heading.textContent()) ?? '').trim();
        found = seed.questions.find((q) => q.question === text && !answered.has(q.id));
        return found !== undefined;
      },
      { message: 'a seeded question not yet answered is on screen' },
    )
    .toBe(true);
  answered.add(found!.id);
  return found!;
}

/** One recap row, found by the question it is about. */
function recapRow(page: Page, question: SeededQuestion): Locator {
  return page.getByTestId('recap-row').filter({ hasText: question.question });
}

/** A vote as stored, or `null` — the two fields a test usually means. */
async function storedVote(
  firebase: { getQuestionVote(id: string): Promise<{ questionId: string; value: number } | null> },
  id: string,
) {
  const vote = await firebase.getQuestionVote(id);
  return vote ? { questionId: vote.questionId, value: vote.value } : null;
}

test.describe('liking and disliking a community question (FEAT-027)', () => {
  test('a like cast after the reveal is stored under the player’s id, read back, then changed and removed', async ({
    page,
    firebase,
  }) => {
    const seed = seedFor('roundtrip');
    const email = `voter-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });
    await firebase.seedCustomQuestions(seed.questions);
    await stubOpenTrivia(page);
    await stubExtraCategory(page, seed.category);
    await page.goto('/');
    await signInViaUi(page, email, password);
    await startCustomGame(page, seed);

    const answered = new Set<string>();
    const first = await nextQuestion(page, seed, answered);
    const row = page.getByTestId('quiz-vote');

    // In the card before the reveal, and invisible: nothing to rate yet, and
    // nothing to move when the reveal shows it (`CLAUDE.md` §4.4).
    await expect(row).toHaveClass(/\binvisible\b/);
    await answerQuestion(page, first.correct_answer);
    await expect(row).not.toHaveClass(/\binvisible\b/);

    // The two seconds the result is on screen.
    await row.getByTestId('vote-like').click();
    await expect(row.getByTestId('vote-like')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('vote-status')).toHaveText(
      'Question 1: you liked this question.',
    );
    await expect
      .poll(() => storedVote(firebase, `${uid}_${first.id}`), {
        message: 'the like is stored under {uid}_{questionId}',
      })
      .toEqual({ questionId: first.id, value: 1 });

    const second = await nextQuestion(page, seed, answered);
    await answerQuestion(page, second.correct_answer);
    await expect(page).toHaveURL(/\/game-over$/);

    // A reload drops everything the tab knew, so what the recap shows next
    // comes from the one read — the caller's own ids, named in an IN, through
    // the real rules — rather than from the tap's own memory.
    await page.reload();
    await page.getByTestId('recap-toggle').click();
    await expect(recapRow(page, first).getByTestId('vote-like')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(recapRow(page, second).getByTestId('vote-like')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // A first vote from the recap, where there is no clock.
    await recapRow(page, second).getByTestId('vote-dislike').click();
    await expect(page.getByTestId('recap-vote-status')).toHaveText(
      'Question 2: you disliked this question.',
    );
    await expect
      .poll(() => storedVote(firebase, `${uid}_${second.id}`))
      .toEqual({ questionId: second.id, value: -1 });
    const firstVotedAt = (await firebase.getQuestionVote(`${uid}_${second.id}`))!.createdAt;

    // A change of mind moves the value and nothing else: the rules refuse an
    // update that touches `createdAt`, which stays the time of the first vote.
    await recapRow(page, second).getByTestId('vote-like').click();
    await expect(page.getByTestId('recap-vote-status')).toHaveText(
      'Question 2: you liked this question.',
    );
    await expect
      .poll(() => firebase.getQuestionVote(`${uid}_${second.id}`))
      .toMatchObject({ value: 1, createdAt: firstVotedAt });

    // Pressing the pressed button removes the vote outright.
    await recapRow(page, first).getByTestId('vote-like').click();
    await expect(page.getByTestId('recap-vote-status')).toHaveText(
      'Question 1: your vote was removed.',
    );
    await expect.poll(() => firebase.getQuestionVote(`${uid}_${first.id}`)).toBeNull();
    await expect(recapRow(page, first).getByTestId('vote-like')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  /**
   * The row is reserved, so the card does not move — at the only layer that
   * can see a box. Same reasoning, viewport and tolerance as the result
   * banner's test in `game-flow.spec.ts`: the card is vertically centred, so a
   * row arriving on the reveal would lift it by half its height, and below a
   * certain viewport height that measures zero whatever the code does.
   */
  test('neither the reveal nor a vote moves the question card', async ({ page, firebase }) => {
    await page.setViewportSize({ width: 1024, height: 1000 });
    const seed = seedFor('layout');
    const email = `voter-${unique()}@example.com`;
    await firebase.createVerifiedUser({ email, password });
    await firebase.seedCustomQuestions(seed.questions);
    await stubOpenTrivia(page);
    await stubExtraCategory(page, seed.category);
    await page.goto('/');
    await signInViaUi(page, email, password);
    await startCustomGame(page, seed);

    const question = await nextQuestion(page, seed);
    const card = page.getByTestId('question-card');
    await expect(page.getByTestId('quiz-vote')).toHaveCount(1);

    // Measured once two readings agree, so `before` cannot be a frame caught
    // mid-layout (`CLAUDE.md` §4.6).
    let before = { y: Number.NaN, height: Number.NaN };
    await expect
      .poll(async () => {
        const box = (await card.boundingBox())!;
        const settled = drift(box.y, before.y) === 0 && drift(box.height, before.height) === 0;
        before = { y: box.y, height: box.height };
        return settled;
      })
      .toBe(true);

    await answerQuestion(page, question.correct_answer);
    await page.getByTestId('quiz-vote').getByTestId('vote-like').click();
    await expect(page.getByTestId('quiz-vote').getByTestId('vote-like')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await expect
      .poll(
        async () => {
          const box = (await card.boundingBox())!;
          return { height: drift(box.height, before.height), top: drift(box.y, before.y) };
        },
        { message: 'the reveal and the vote must not resize or move the question card' },
      )
      .toEqual({ height: 0, top: 0 });
  });

  /**
   * Decision 1. The buttons are there for a guest — hiding them would hide the
   * feature from most of the traffic — and a tap writes nothing and opens the
   * sign-in menu. The round then waits for the menu, because moving on would
   * start the next question's clock behind a sign-in form.
   *
   * The wait is real time, for the reason `adjustable-timer.spec.ts` gives:
   * the subject is that a deadline does *not* fire, and faking the clock would
   * replace the one being tested.
   */
  test('a guest’s tap writes nothing, opens the sign-in menu, and the round waits for it', async ({
    page,
    firebase,
  }) => {
    const seed = seedFor('guest');
    await firebase.seedCustomQuestions(seed.questions);
    await stubOpenTrivia(page);
    await stubExtraCategory(page, seed.category);
    await page.goto('/');
    await startCustomGame(page, seed);

    const question = await nextQuestion(page, seed);
    await answerQuestion(page, question.correct_answer);
    const like = page.getByTestId('quiz-vote').getByTestId('vote-like');
    await like.click();

    await expect(authMenu(page)).toBeVisible();
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('vote-status')).toHaveText(
      'Question 1: sign in to like or dislike questions.',
    );

    // Well past the two-second pause: the same question, still answered, still
    // on screen.
    await page.waitForTimeout(3_500);
    await expect(page.getByTestId('question-text')).toHaveText(question.question);
    await expect(page).toHaveURL(/\/play$/);

    // Closing the menu lets the round go on.
    await page.keyboard.press('Escape');
    await expect(authMenu(page)).toHaveCount(0);
    await expect(page.getByTestId('question-text')).not.toHaveText(question.question);

    // Nothing was written for either question, by anybody. Read after the wait
    // above, so a write that was coming has had every chance to land.
    expect(await firebase.getQuestionVotesOn(seed.questions.map((q) => q.id))).toEqual([]);
  });

  /**
   * The stable-id constraint, in a real browser. An Open Trivia DB question's
   * id is minted per fetch, so a vote on one would be stored against an id
   * that never comes back.
   */
  test('offers no vote on an Open Trivia DB question', async ({ page }) => {
    await startGame(page, 5);

    await answerQuestion(page, CORRECT_ANSWERS[0]);
    // Anchored on the reveal having happened, so the absence below is about
    // the answered state rather than a screen that had not rendered yet.
    await expect(page.getByTestId('result-status')).toContainText('Correct');
    await expect(page.getByTestId('quiz-vote')).toHaveCount(0);
  });

  /**
   * The two sweeps the `{uid}_{questionId}` order exists for, against the
   * emulator's real id ordering. The neighbours are the point: each is the id
   * of a vote another account could own whose uid begins the way this one's
   * does, and a range one character too generous would export them to this
   * player and delete them with this account.
   */
  test('export returns the player’s votes, and deletion removes them and nobody else’s', async ({
    page,
    firebase,
  }) => {
    const seed = seedFor('sweep');
    const [q1, q2] = seed.questions;
    const email = `voter-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });
    await firebase.seedCustomQuestions(seed.questions);

    const neighbours = [
      `${uid}a_${q1.id}`,
      `${uid}0_${q1.id}`,
      `${uid}Z_${q1.id}`,
      `${uid.slice(0, -1)}_${q1.id}`,
    ];
    await firebase.seedQuestionVotes([
      { uid, questionId: q1.id, value: 1 },
      { uid, questionId: q2.id, value: -1 },
      ...neighbours.map((id) => ({ id, uid: 'neighbour', questionId: q1.id, value: 1 as const })),
    ]);

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);

    await openAuthMenu(page);
    // Armed before the click: the download can complete before the next
    // statement runs, and an event that has already fired is not waited for.
    const downloading = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByTestId('download-my-data').click();
    const download = await downloading;
    const exported = JSON.parse(await readFile(await download.path(), 'utf8')) as {
      questionVotes: { id: string; questionId: string; value: number; createdAt: number }[];
    };
    expect(
      exported.questionVotes.map(({ id, questionId, value }) => ({ id, questionId, value })),
    ).toEqual([
      { id: `${uid}_${q1.id}`, questionId: q1.id, value: 1 },
      { id: `${uid}_${q2.id}`, questionId: q2.id, value: -1 },
    ]);

    await page.getByTestId('delete-account').click();
    await page.getByTestId('confirm-delete-account').click();
    await expect(page.getByTestId('auth-menu-trigger')).toContainText('Sign in', {
      timeout: 30_000,
    });

    // Non-vacuous: the export above read both votes a moment ago.
    expect(await firebase.getQuestionVotesOf(uid)).toEqual([]);
    for (const id of neighbours) {
      expect(
        await firebase.getQuestionVote(id),
        `${id} is somebody else's and stays`,
      ).not.toBeNull();
    }
  });
});
