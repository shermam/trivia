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

const CORS_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
};
