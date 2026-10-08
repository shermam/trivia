import { Page } from '@playwright/test';
import questionsFixture from '../fixtures/open-trivia-questions.json';

/**
 * The recorded Open Trivia DB response every stubbed game is served from.
 * Re-exported rather than copied into the specs that need it, because the
 * scoring assertions are derived from this data — two copies would let a test
 * assert against answers the app was never shown.
 *
 * Every question in it is `General Knowledge`, one of the twenty-four names
 * the app's seed-tag table holds, so the adapter stamps each with
 * `#general-knowledge` (`FEAT-052`) — which is the topic a quiz card shows for
 * one, and what a spec reading that pill should expect.
 */
export { questionsFixture };

/** The correct answer to each fixture question, in order. */
export const CORRECT_ANSWERS = questionsFixture.results.map((q) => q.correct_answer);

/**
 * Serves Open Trivia DB's question endpoint from the fixture above, so a run
 * never depends on a third-party service being up or on what it feels like
 * returning.
 *
 * One route, matching any query string: `api.php`'s varies with the game's
 * configuration — the amount, the difficulty, and the `category` id a seed tag
 * turns into. A spec asserting on that id reads it off the request rather than
 * routing on it. The app requests nothing else from the host: the category
 * list it used to fetch from `api_category.php` became a table in the app.
 *
 * **`Access-Control-Allow-Origin` is not decoration.** Fulfilling a route
 * happens below the browser's CORS check rather than instead of it, so a
 * cross-origin response served without the header is refused exactly as the
 * real one would be — and the app then reports a question load failure that
 * reads like a stubbing mistake nowhere near the stub.
 */
export async function stubOpenTrivia(page: Page): Promise<void> {
  await page.route('https://opentdb.com/api.php*', (route) =>
    route.fulfill({ json: questionsFixture, headers: CORS_HEADERS }),
  );
}

const CORS_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
};
