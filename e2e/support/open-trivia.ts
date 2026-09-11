import { Page } from '@playwright/test';
import categoriesFixture from '../../cypress/fixtures/open-trivia-categories.json';
import questionsFixture from '../../cypress/fixtures/open-trivia-questions.json';

/**
 * The two Open Trivia DB fixtures, read from where the Cypress suite keeps
 * them so that both suites assert against **one** copy while both exist. They
 * move under `e2e/` when `cypress/` goes; duplicating them in the meantime
 * would let the two suites drift apart on the very data their scoring
 * assertions are derived from.
 */
export { questionsFixture };

/** The correct answer to each fixture question, in order. */
export const CORRECT_ANSWERS = questionsFixture.results.map((q) => q.correct_answer);

/**
 * Serves the Open Trivia DB endpoints from the fixtures above, so a run never
 * depends on a third-party service being up or on what it feels like
 * returning.
 *
 * Two routes rather than one pattern: `api_category.php` and `api.php` are
 * different responses, and `api.php` carries a query string that varies with
 * the game's configuration.
 *
 * **`Access-Control-Allow-Origin` is not decoration.** Fulfilling a route
 * happens below the browser's CORS check rather than instead of it, so a
 * cross-origin response served without the header is refused exactly as the
 * real one would be — and the app then reports a category/question load
 * failure that reads like a stubbing mistake nowhere near the stub.
 */
export async function stubOpenTrivia(page: Page): Promise<void> {
  await page.route('https://opentdb.com/api_category.php', (route) =>
    route.fulfill({ json: categoriesFixture, headers: CORS_HEADERS }),
  );
  await page.route('https://opentdb.com/api.php*', (route) =>
    route.fulfill({ json: questionsFixture, headers: CORS_HEADERS }),
  );
}

/**
 * Serves the category list with one extra name appended.
 *
 * The setup screen builds its Category dropdown from that response whatever
 * the question source is, so this is how a spec gets a **unique** category
 * into the picker — which is the only way to make a *custom*-source game
 * deterministic against a question bank every other worker is also writing to.
 * Call it after `stubOpenTrivia`: Playwright matches route handlers in reverse
 * registration order, so the later one wins.
 */
export async function stubExtraCategory(page: Page, name: string): Promise<void> {
  await page.route('https://opentdb.com/api_category.php', (route) =>
    route.fulfill({
      json: {
        trivia_categories: [
          ...categoriesFixture.trivia_categories,
          { id: EXTRA_CATEGORY_ID, name },
        ],
      },
      headers: CORS_HEADERS,
    }),
  );
}

/** Outside Open Trivia DB's own id range, so it can never collide with a real one. */
const EXTRA_CATEGORY_ID = 9000;

const CORS_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
};
