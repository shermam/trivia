import { expect, Page } from '@playwright/test';
import { QuestionCount, optionLabel, waitForPlayRoute } from './game';

/**
 * Isolation by topic (`FEAT-052`): how a spec plays a game drawn only from
 * questions it seeded itself, in a question bank every other worker in the run
 * is writing to as well — and, against `trivimind-dev`, a bank shared with
 * real contributors for good.
 *
 * **A tag nobody else has used is a slice of the bank nobody else owns.** The
 * community draw filters on the chosen topics in the query itself, as an
 * `array-contains-any` on `tags`, so a tag minted per test and written onto
 * every question the test seeds is matched by those questions and by nothing
 * else, however many other documents the bank holds. Nothing has to be stubbed
 * for it: the tag is typed into the setup screen's topic picker exactly as a
 * player would type one, and goes through the normaliser on the way.
 *
 * A plain support module rather than something exported from a spec, for the
 * reason `layout.ts` gives: a spec file's `test` calls run on import.
 */

/**
 * The stored shape of a tag, mirrored from `normalize-tag.util.ts` because
 * e2e specs compile under their own tsconfig and none of them reaches into
 * `src/`. A minted tag outside it would be normalised into a different string
 * on the way in, and the seeded questions would never match it.
 */
const TAG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_TAG_LENGTH = 32;

/**
 * A topic tag this test alone has used: `e2e-<slug>-<time><random>`.
 *
 * Base 36 rather than decimal, because a tag is at most 32 characters and a
 * millisecond timestamp in decimal spends thirteen of them; the slug says which
 * spec minted it, for whoever finds one in the review queue. Throws rather
 * than returning something the normaliser would rewrite, so a slug that is too
 * long fails here, naming itself, instead of as a game that draws nothing.
 */
export function runTag(slug: string): string {
  const tag = `e2e-${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  if (!TAG_SHAPE.test(tag) || tag.length > MAX_TAG_LENGTH) {
    throw new Error(`"${tag}" is not a tag the normaliser would store — shorten "${slug}".`);
  }
  return tag;
}

/**
 * Types each topic into the setup screen's picker, and waits for exactly
 * those chips.
 *
 * **The source has to be chosen first.** An Open Trivia game plays one of the
 * seed tags and nothing else, so a typed run tag is refused there, with the
 * reason, rather than added — the chip this waits for would never appear.
 */
export async function chooseTopics(page: Page, topics: readonly string[]): Promise<void> {
  const input = page.getByTestId('filter-tag-input');
  for (const topic of topics) {
    await input.fill(topic);
    await input.press('Enter');
  }
  await expect(page.getByTestId('filter-tag-selector').getByTestId('selected-tag')).toHaveText(
    topics.map((topic) => `#${topic}`),
  );
}

/**
 * Adds a topic on the contribute form — or, given `edit-`, in `/my-questions`'
 * edit dialog — by typing it as a contributor would, and waits for its chip.
 *
 * Every contribution needs one since topics replaced categories (`FEAT-052`):
 * the form refuses to submit without, and so does `firestore.rules`.
 */
export async function addQuestionTopic(page: Page, topic: string, idPrefix = ''): Promise<void> {
  const input = page.getByTestId(`${idPrefix}tag-input`);
  await input.fill(topic);
  await input.press('Enter');
  await expect(
    page
      .getByTestId(`${idPrefix}tag-selector`)
      .getByTestId('selected-tag')
      .filter({ hasText: `#${topic}` }),
  ).toHaveCount(1);
}

export interface TopicGameOptions {
  /** What the game is narrowed to — usually one {@link runTag}. */
  readonly topics: readonly string[];
  /** Defaults to five, the shortest game the setup screen offers. */
  readonly amount?: QuestionCount;
  /** Defaults to Custom, the source that draws from the bank alone. */
  readonly source?: 'Custom' | 'Mixed';
  /**
   * Play with no countdown — for a spec that walks several questions and is
   * not about the deadline, where a starved worker losing a question to a
   * timeout would fail an assertion about something else.
   */
  readonly noTimeLimit?: boolean;
}

/**
 * Sets up a topic-filtered game on the setup screen that is already showing,
 * without pressing Start — for a spec whose subject is what Start does.
 *
 * Everything is chosen every time, because "Play Again" returns to a freshly
 * constructed form whose count, source and topics are all back at their
 * defaults.
 */
export async function configureTopicGame(page: Page, options: TopicGameOptions): Promise<void> {
  await expect(page).toHaveURL(/\/$/);
  await page.locator('#amount').selectOption({ label: String(options.amount ?? 5) });
  await optionLabel(
    page,
    page.getByRole('radio', { name: options.source ?? 'Custom', exact: true }),
  ).click();
  // The picker takes its rules from the source — up to ten topics of any kind
  // here, one seed tag for Open Trivia — and they reach it on the next render,
  // not with the click. A run tag typed in the same instant is judged by the
  // old ones and refused, as an Open Trivia game refuses it; measured, on a
  // loaded runner, 50 ms after the click. So this waits for the picker to say
  // it takes ten before typing anything.
  await expect(page.getByTestId('filter-tag-feedback')).toContainText('of 10 chosen.');
  await chooseTopics(page, options.topics);
  if (options.noTimeLimit) {
    await optionLabel(page, page.getByRole('radio', { name: 'No limit', exact: true })).click();
  }
}

/**
 * Sets up a topic-filtered game, presses Start, and does not return until
 * `/play` is on screen.
 *
 * **`found` is how many questions the topics hold**, which the caller knows
 * because it seeded them. A spec's own slice is usually smaller than the
 * shortest game, and a topic-filtered draw that comes back short says so and
 * waits rather than starting (`FEAT-021`) — so this asserts the notice names
 * exactly that many and accepts its offer, rather than guessing which of the
 * two screens will come up. A count that disagrees with the seed fails here,
 * on the notice, which is where it is cheapest to read.
 */
export async function startTopicGame(
  page: Page,
  options: TopicGameOptions & { readonly found: number },
): Promise<void> {
  const amount = options.amount ?? 5;
  await configureTopicGame(page, options);
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();

  if (options.found < amount) {
    await expect(page.getByTestId('short-draw-notice')).toContainText(
      `Only ${options.found} of the ${amount} questions`,
    );
    await page
      .getByRole('button', { name: `Play ${options.found} Questions`, exact: true })
      .click();
  }
  await waitForPlayRoute(page);
}
