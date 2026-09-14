import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { CustomQuestionSeed } from '../../fixtures/types';
import { answerQuestion, optionLabel, waitForPlayRoute } from '../../support/game';
import { stubExtraCategory, stubOpenTrivia } from '../../support/open-trivia';

/**
 * `FEAT-021` — the setup screen's topic filter, end to end.
 *
 * **Why a real browser is needed at all.** The unit specs already pin the query
 * the service builds, the chips the picker produces and the config the screen
 * emits. What none of them can see is the three of those wired together
 * through a played round: a `ControlValueAccessor` that never writes back, a
 * `tags` key dropped between the form and `GameConfig`, or a clause that
 * reaches Firestore in a shape the real query engine refuses would all pass
 * every unit test in the repo and serve nobody a question.
 *
 * **Isolation on a shared emulator is the invented tag**, exactly as
 * `question-dedup.spec.ts` uses an invented category. Every worker in the run
 * writes to one bank, so an assertion about *which* questions a filter served
 * only means something if this test owns every question that can match it. A
 * tag carrying the run id does that on its own — and it is a stronger fence
 * than the category, because a tag filter also has to exclude the untagged
 * questions this spec seeds beside the tagged ones.
 *
 * **The index is not exercised here, and cannot be.** The Firestore emulator
 * serves any query without a composite index, so a green run says nothing about
 * `firestore.indexes.json` — see `docs/ci-cd.md` §4.3 and `AUDIT_REMEDIATION.md`
 * `D3`. `firestore-tests/indexes.spec.ts` pins the declaration; the deploy
 * builds it.
 */

const GAME_SIZE = 5;

interface Seed {
  category: string;
  /** The tag this run owns. Every question carrying it was seeded here. */
  tag: string;
  tagged: (CustomQuestionSeed & { id: string })[];
  untagged: (CustomQuestionSeed & { id: string })[];
}

function seedFor(): Seed {
  // Lower-case and hyphenated, because a tag is compared as stored: the filter
  // sends exactly what the normaliser produced, and a run id with an upper-case
  // letter in it would be a tag no question could ever carry.
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
  const tag = `e2e-topic-${runId}`;
  const category = `Tags ${runId}`;

  const question = (kind: string, index: number, tags?: string[]) => ({
    id: `tagfilter-${kind}-${index}-${runId}`,
    category,
    type: 'multiple' as const,
    difficulty: 'easy' as const,
    question: `${kind} question ${index} (${runId})?`,
    correct_answer: `Right ${kind} ${index}`,
    incorrect_answers: [
      `Wrong ${kind} ${index}a`,
      `Wrong ${kind} ${index}b`,
      `Wrong ${kind} ${index}c`,
    ],
    ...(tags ? { tags } : {}),
  });

  return {
    category,
    tag,
    tagged: Array.from({ length: GAME_SIZE }, (_, index) => question('Tagged', index, [tag])),
    // Seeded and never expected: these are what makes the filter observable.
    // Without them a filtered game and an unfiltered one would draw the same
    // documents, and the test would pass against a filter that does nothing.
    untagged: Array.from({ length: GAME_SIZE }, (_, index) => question('Untagged', index)),
  };
}

/**
 * Configures a Custom-source game over this run's own category, optionally
 * narrowed to its own tag, and presses Start.
 *
 * The topic picker is only offered for a source that has tags, so the source
 * radio is chosen **before** the topic — the reverse order would find a
 * disabled button.
 */
async function configureGame(
  page: Page,
  seed: Seed,
  options: { amount: number; withTag: boolean },
): Promise<void> {
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#category')).toContainText(seed.category);
  await page.locator('#amount').selectOption({ label: String(options.amount) });
  await page.locator('#category').selectOption(seed.category);
  await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
  // No countdown, for the reason `question-dedup.spec.ts` gives: this spec
  // walks several questions and a fifteen-second clock underneath them makes
  // the deadline the subject of a test about something else.
  await optionLabel(page, page.getByRole('radio', { name: 'No limit', exact: true })).click();

  if (options.withTag) {
    const input = page.getByTestId('filter-tag-input');
    await input.fill(seed.tag);
    await input.press('Enter');
    await expect(page.getByTestId('filter-tag-selector').getByTestId('selected-tag')).toHaveText([
      `#${seed.tag}`,
    ]);
  }
}

/**
 * The text of every question a game served, in the order it served them.
 *
 * The right answer comes from the **seed**, looked up by the question on
 * screen, rather than from reading the options: an answer button renders its
 * A/B/C/D badge inside itself, so its `textContent` is the label glued to the
 * answer and matching on the answer's own text finds nothing. Looking it up
 * also fails loudly on a question this spec did not seed, which is the failure
 * worth having on a shared emulator.
 */
async function playAndCollect(page: Page, seed: Seed, count: number): Promise<string[]> {
  const served: string[] = [];
  const all = [...seed.tagged, ...seed.untagged];
  const heading = page.getByTestId('question-text');

  for (let index = 0; index < count; index++) {
    await expect
      .poll(async () => served.includes((await heading.textContent())?.trim() ?? ''), {
        message: 'a question other than the ones already answered is on screen',
      })
      .toBe(false);

    const text = (await heading.textContent())?.trim() ?? '';
    const question = all.find((candidate) => candidate.question === text);
    if (!question) {
      throw new Error(`Served question "${text}" is not one of the seeded ones`);
    }
    served.push(text);
    await answerQuestion(page, question.correct_answer);
  }

  await expect(page).toHaveURL(/\/game-over$/);
  return served;
}

test.describe('the setup screen topic filter', () => {
  test('plays only the questions carrying the chosen topic', async ({ page, firebase }) => {
    const seed = seedFor();
    await firebase.seedCustomQuestions([...seed.tagged, ...seed.untagged]);
    await stubOpenTrivia(page);
    await stubExtraCategory(page, seed.category);
    await page.goto('/');

    await configureGame(page, seed, { amount: GAME_SIZE, withTag: true });
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await waitForPlayRoute(page);

    const served = await playAndCollect(page, seed, GAME_SIZE);

    // Every one tagged, and none of the five untagged questions sitting in the
    // same category — which is what an `array-contains-any` clause buys and a
    // client-side filter over the same read would not.
    expect(served.every((text) => text.startsWith('Tagged question'))).toBe(true);
    expect(new Set(served).size).toBe(GAME_SIZE);
  });

  /**
   * The additive half, and the one whose regression would be catastrophic
   * rather than annoying: the bank is almost entirely untagged, so a clause
   * that leaked into the default draw would empty every custom game in the app
   * rather than narrowing it.
   */
  test('serves untagged questions when no topic is chosen', async ({ page, firebase }) => {
    const seed = seedFor();
    await firebase.seedCustomQuestions([...seed.tagged, ...seed.untagged]);
    await stubOpenTrivia(page);
    await stubExtraCategory(page, seed.category);
    await page.goto('/');

    await configureGame(page, seed, { amount: 2 * GAME_SIZE, withTag: false });
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await waitForPlayRoute(page);

    const served = await playAndCollect(page, seed, 2 * GAME_SIZE);

    expect(served.some((text) => text.startsWith('Untagged question'))).toBe(true);
    expect(served).toHaveLength(2 * GAME_SIZE);
  });

  /**
   * Asking for more than the topic has says how many were found and waits. The
   * bank being mostly untagged makes this the *expected* outcome of a narrow
   * filter rather than an unlucky one, so a player who is not told has been
   * misled by omission.
   */
  test('says how many were found when the topic has fewer than were asked for', async ({
    page,
    firebase,
  }) => {
    const seed = seedFor();
    await firebase.seedCustomQuestions([...seed.tagged, ...seed.untagged]);
    await stubOpenTrivia(page);
    await stubExtraCategory(page, seed.category);
    await page.goto('/');

    await configureGame(page, seed, { amount: 2 * GAME_SIZE, withTag: true });
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();

    const notice = page.getByTestId('short-draw-notice');
    await expect(notice).toContainText(`Only ${GAME_SIZE} of the ${2 * GAME_SIZE} questions`);
    // Still on the setup screen: the game has not started behind the notice.
    await expect(page).toHaveURL(/\/$/);

    // ...and the second press plays what was found, without drawing again.
    await page.getByRole('button', { name: `Play ${GAME_SIZE} Questions`, exact: true }).click();
    await waitForPlayRoute(page);

    const served = await playAndCollect(page, seed, GAME_SIZE);
    expect(served.every((text) => text.startsWith('Tagged question'))).toBe(true);
  });

  /**
   * Only the community bank carries tags, so the picker is put out of reach for
   * an Open Trivia DB game rather than accepted and quietly ignored. Asserted
   * on the real disabled attribute and the real sentence, because "greyed out"
   * with no reason is a dead end for the reader.
   */
  test('is unavailable for an Open Trivia game, and says why', async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');

    await expect(page.getByTestId('filter-tag-input')).toBeDisabled();
    await expect(page.getByTestId('filter-tag-feedback')).toContainText(
      'Only community questions carry topics',
    );

    await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();

    await expect(page.getByTestId('filter-tag-input')).toBeEnabled();
  });

  /**
   * The picker keeps the same height as chips are added — which nothing below a
   * real browser can see (`CLAUDE.md` §4.4: jsdom has no layout). Measured
   * around the *whole* control rather than the chip row, because the failure
   * this prevents is the Start button moving down the screen while the reader
   * is choosing topics.
   */
  test('does not resize as topics are added', async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');
    await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();

    const selector = page.getByTestId('filter-tag-selector');
    const before = await selector.boundingBox();

    const input = page.getByTestId('filter-tag-input');
    for (const topic of ['alpha-topic', 'beta-topic', 'gamma-topic', 'delta-topic']) {
      await input.fill(topic);
      await input.press('Enter');
    }
    await expect(selector.getByTestId('selected-tag')).toHaveCount(4);

    // Polled rather than read once: a layout frame can land after the last
    // chip renders, and a single `boundingBox()` is a race rather than an
    // assertion (`CLAUDE.md` §4.6).
    await expect
      .poll(async () => Math.round((await selector.boundingBox())!.height))
      .toBe(Math.round(before!.height));
  });
});
