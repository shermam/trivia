import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { CustomQuestionSeed } from '../../fixtures/types';
import { answerQuestion, optionLabel, waitForPlayRoute } from '../../support/game';
import { stubExtraCategory, stubOpenTrivia } from '../../support/open-trivia';

/**
 * `FEAT-034` — the draw does not serve a question this device has already
 * answered, and does not shorten the game to avoid one either.
 *
 * **Nothing below a real browser can see this.** The seen-set is IndexedDB,
 * the marks are written from the quiz as questions resolve, and the property
 * under test is about the *second* game a browser plays — so it needs a
 * persistent browser context and a real question bank. The unit specs cover
 * the selection and the storage; what only this can check is that the two are
 * actually wired to each other through a played round.
 *
 * **Seven questions and five-question games, on purpose.** Seven is small
 * enough that the second game cannot be all-new — two unseen and three
 * repeats is the arithmetic — which makes both halves of the rule observable
 * in one run: the unseen come first, and the shortfall is filled with the
 * least-recently-seen rather than by serving a three-question game.
 *
 * **The test seeds its own category and that is the whole of its isolation.**
 * The emulator is shared by every worker, so the bank has to hold exactly this
 * test's seven questions for the assertion to mean anything. The category
 * dropdown is built from the stubbed Open Trivia response and its value goes
 * straight into the `custom_questions` query, so inventing a category and
 * picking it is the whole mechanism (`stubExtraCategory`).
 *
 * **The seen-set being per device is not asserted here**, and does not need to
 * be: nothing in it is keyed by account, and `test-isolation.spec.ts` already
 * pins that a fresh browser context is a fresh IndexedDB. Replaying these
 * three games in a second context to watch them not deduplicate would cost
 * another minute of runtime to restate that.
 */

const BANK_SIZE = 7;
const GAME_SIZE = 5;

interface Seed {
  category: string;
  questions: (CustomQuestionSeed & { id: string })[];
}

function seedFor(): Seed {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const category = `Dedup ${runId}`;
  return {
    category,
    questions: Array.from({ length: BANK_SIZE }, (_, index) => ({
      id: `dedup-q${index}-${runId}`,
      category,
      type: 'multiple' as const,
      difficulty: 'easy' as const,
      // The wording is the identity a player would recognise a repeat by, and
      // it is what this spec matches on — so each one has to be distinct.
      question: `Dedup question ${index} (${runId})?`,
      correct_answer: `Right ${index}`,
      incorrect_answers: [`Wrong ${index}a`, `Wrong ${index}b`, `Wrong ${index}c`],
    })),
  };
}

/**
 * Configures and starts a five-question game over this test's own category,
 * from `/`.
 *
 * Re-selected on every game rather than once, because "Play Again" returns to
 * a freshly constructed setup form: the category, the source and the count are
 * all back at their defaults, and a game started without re-picking them would
 * be a five-question Open Trivia game that happens to pass the count
 * assertion.
 */
async function startSeededGame(page: Page, seed: Seed): Promise<void> {
  await expect(page).toHaveURL(/\/$/);
  // Stands in for a wait on the categories request, and does more: the
  // invented category has to be in the dropdown before it can be selected.
  await expect(page.locator('#category')).toContainText(seed.category);
  await page.locator('#amount').selectOption({ label: String(GAME_SIZE) });
  await page.locator('#category').selectOption(seed.category);
  await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
  // Played with **no time limit on purpose**. This spec walks fifteen
  // questions across three rounds, and a fifteen-second countdown running
  // underneath every one of them makes the deadline the subject of a test
  // about something else: a starved worker loses a question to a timeout, the
  // quiz auto-advances, and the failure lands on a later assertion about which
  // questions were served (`docs/ci-cd.md` §4.3 records the same trade for
  // `streak-multipliers.spec.ts`). A timeout marks a question seen exactly as
  // an answer does, so nothing about the feature goes untested by removing it.
  await optionLabel(page, page.getByRole('radio', { name: 'No limit', exact: true })).click();
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();
  await waitForPlayRoute(page);
}

/**
 * Plays a whole game, answering every question correctly, and returns the
 * questions served **in the order they were answered**.
 *
 * The order is the point: `seenAt` is stamped as each question resolves, so
 * the order of this list is exactly the least-recently-seen order the next
 * game's top-up will draw in.
 *
 * Two mechanics, both inherited from `question-reporting.spec.ts` and both
 * load-bearing. The heading is read through `[data-cy=question-text]`, which
 * does not exist on `/game-over` — so a loop that overruns fails saying so
 * rather than reading some other heading. And the wait is for the heading to
 * have *moved on*: the quiz holds an answered question on screen for two
 * seconds, so reading it straight after a click can return the one just
 * answered.
 */
async function playGame(page: Page, seed: Seed): Promise<string[]> {
  const served: string[] = [];
  const heading = page.getByTestId('question-text');

  for (let index = 0; index < GAME_SIZE; index++) {
    await expect
      .poll(async () => served.includes((await heading.textContent())?.trim() ?? ''), {
        message: `a question other than the ${served.length} already answered is on screen`,
      })
      .toBe(false);

    const text = (await heading.textContent())?.trim() ?? '';
    const question = seed.questions.find((candidate) => candidate.question === text);
    if (!question) {
      throw new Error(`Served question "${text}" is not one of the seeded ones`);
    }
    served.push(text);
    await answerQuestion(page, question.correct_answer);
  }

  await expect(page).toHaveURL(/\/game-over$/);
  await expect(page.getByText('Game Over!').first()).toBeVisible();
  return served;
}

async function playAgain(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Play Again', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('Question deduplication (FEAT-034)', () => {
  test('prefers unseen questions, then the least-recently-seen, and never shortens the game', async ({
    page,
    firebase,
  }) => {
    const seed = seedFor();
    await firebase.seedCustomQuestions(seed.questions);
    await stubOpenTrivia(page);
    await stubExtraCategory(page, seed.category);
    await page.goto('/');

    // Game one: nothing has been answered on this device, so the draw is the
    // plain one and any five of the seven are fair.
    await startSeededGame(page, seed);
    const first = await playGame(page, seed);
    expect(first).toHaveLength(GAME_SIZE);
    expect(new Set(first).size).toBe(GAME_SIZE);

    await playAgain(page);

    // Game two is the whole feature. Two of the seven have never been served,
    // so both must appear; the remaining three slots go to the three answered
    // *earliest* in game one, not to whichever three the bank happened to
    // return.
    await startSeededGame(page, seed);
    const second = await playGame(page, seed);

    const unseenAfterFirst = seed.questions
      .map((question) => question.question)
      .filter((text) => !first.includes(text));
    expect(unseenAfterFirst).toHaveLength(BANK_SIZE - GAME_SIZE);
    expect([...second].sort()).toEqual(
      [...unseenAfterFirst, ...first.slice(0, GAME_SIZE - unseenAfterFirst.length)].sort(),
    );

    await playAgain(page);

    // Game three: every question in the bank has now been answered. The draw
    // still has to hand over five of them — falling back to the oldest is what
    // keeps a small bank playable, and a game that came back short or empty
    // would be worse than no deduplication at all.
    await startSeededGame(page, seed);
    const third = await playGame(page, seed);
    expect(third).toHaveLength(GAME_SIZE);
    expect(new Set(third).size).toBe(GAME_SIZE);
  });
});
