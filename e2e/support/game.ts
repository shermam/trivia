import { expect, Locator, Page } from '@playwright/test';
import { stubOpenTrivia } from './open-trivia';

/** The question counts the setup screen offers. */
export type QuestionCount = 5 | 10 | 15 | 20 | 25;

/**
 * Stubs Open Trivia DB, visits `/`, picks `amount`, starts the game, and does
 * not return until `/play` is genuinely on screen.
 */
export async function startGame(page: Page, amount: QuestionCount = 5): Promise<void> {
  await stubOpenTrivia(page);
  await page.goto('/');
  await selectQuestionCount(page, amount);
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();
  await waitForPlayRoute(page);
}

/**
 * Picks the number of questions **by its label, not by its value**.
 *
 * The options are bound with `[ngValue]` rather than `[value]`, because the
 * control is a `FormControl<number>` and only `ngValue` keeps it one (B11).
 * The price of that is that Angular writes a synthetic DOM value — `"0: 5"` —
 * so `selectOption('5')`, which matches on value, silently matches nothing.
 * The visible label is the stable thing here.
 */
async function selectQuestionCount(page: Page, amount: QuestionCount): Promise<void> {
  await page.locator('#amount').selectOption({ label: String(amount) });
}

/**
 * Waits until the quiz loop is genuinely on screen.
 *
 * **Both halves are load-bearing, and the second one is the one that is easy
 * to leave out.** The questions response is what `GameControllerService
 * .startGame()` awaits *before* it navigates, so a helper that stopped at
 * "the request came back" would return while the app is still on the setup
 * screen with the lazy `/play` chunk unfetched. A caller whose next assertion
 * was a negative one would then pass against `/` and test nothing — which is
 * exactly how a "no flag button on an Open Trivia question" assertion came to
 * be green against a screen that has no flag button under any circumstances.
 * The URL alone is not enough either: it can commit a tick before the outlet
 * paints, and the question text cannot appear until the component has
 * rendered.
 */
export async function waitForPlayRoute(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/play$/);
  await expect(page.getByTestId('question-text')).toBeVisible();
}

/**
 * Clicks the answer whose text is exactly this, on the active quiz question.
 *
 * **Scoped to `[data-cy=answer-option]`, and that scoping is the whole
 * helper.** The Cypress original was a substring match that silently took the
 * first hit in DOM order, and the top bar sits above the quiz: a signed-in
 * account chip renders the display name or email inside its trigger button, so
 * against an address like `stats-1787954295926-k3x@example.com` "answer 4"
 * clicked the account chip and opened the auth menu.
 *
 * The reason it went undiagnosed is worth more than the fix. The countdown
 * **hid** it: the question nobody answered timed out, auto-advanced as wrong,
 * and the game finished 4/5 — so the symptom was a score short by one, which
 * reads as a scoring bug and got investigated as a slow runner for two rounds.
 * Only removing the deadline made it fail loudly, on the *next* question, as
 * "cannot find 'True'".
 *
 * An exact match would not have made that particular mistake, but it would
 * still have matched a same-named button anywhere on the page. Address what
 * you click by `data-cy` (`CLAUDE.md` §4.6) — hence the test-id scope here,
 * with the text matched exactly against the option's own label span rather
 * than as a substring of the whole button (whose text also carries its A/B/C/D
 * badge).
 */
export function answerOption(page: Page, answerText: string): Locator {
  return page
    .getByTestId('answer-option')
    .filter({ has: page.getByText(answerText, { exact: true }) });
}

export async function answerQuestion(page: Page, answerText: string): Promise<void> {
  await answerOption(page, answerText).click();
}

/**
 * The visible `<label>` that owns one of the setup screen's segmented-picker
 * radios.
 *
 * The radios themselves are `sr-only` — a 1×1 clipped box — so they are what a
 * screen reader reads and what `getByRole('radio')` addresses, but they are
 * not what anybody clicks: a pointer at that box lands on the label. Clicking
 * the label is both the real gesture and the one that needs no `force`, which
 * matters because `force` skips exactly the check that would notice a control
 * becoming genuinely unclickable.
 */
export function optionLabel(page: Page, radio: Locator): Locator {
  return page.locator('label').filter({ has: radio });
}

/**
 * Starts another game without revisiting the page — for replaying within one
 * test, where the app is already loaded and back on `/`.
 *
 * The Open Trivia stub belongs to the page rather than to the visit: a
 * `page.route` handler outlives every navigation in the test, so the caller's
 * earlier `stubOpenTrivia` (or `startGame`) still serves this game's
 * questions.
 */
export async function startNewGame(page: Page, amount: QuestionCount = 5): Promise<void> {
  await expect(page).toHaveURL(/\/$/);
  await selectQuestionCount(page, amount);
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();
  await waitForPlayRoute(page);
}
