import { expect, test } from '../../fixtures/test';
import { answerOption, answerQuestion, startGame } from '../../support/game';
import { seedOfflineQuestions } from '../../support/offline-storage';
import { CORRECT_ANSWERS } from '../../support/open-trivia';

/**
 * A player whose connection drops mid-session can still finish a round: the
 * question fetch fails, `TriviaService.getQuestions()` falls back to the
 * IndexedDB pool, and the quiz says so rather than pretending (`app.md` §1.8).
 *
 * **Why a first round online, before the network is cut.** `/play` and
 * `/game-over` are lazy routes, so their chunks arrive over the network the
 * first time each is reached. On a deployed build the service worker has
 * already precached them (`service-worker-precache.spec.ts`); under
 * `ng serve --configuration=e2e` there is no worker at all, so the only way to
 * have them is to have loaded them. Playing one full round first puts both in
 * the module registry, which is also exactly the state the user this test is
 * about is in — somebody who was already playing when the signal went.
 *
 * **The Open Trivia stub has to be revoked, not just ignored.** `page.route`
 * fulfils without touching the network, so a stub registered for the first
 * round would go on answering the second one perfectly while the test believed
 * it had cut the connection. Playwright matches handlers in reverse
 * registration order, so a later aborting handler is what actually takes the
 * network away from the app.
 */
test.describe('Playing with the network gone', () => {
  const ROUND = 5;

  test('falls back to the offline pool, says so, and finishes the round', async ({
    page,
    context,
  }) => {
    // Round one, online: loads the `/play` and `/game-over` chunks, and leaves
    // the app back on `/` ready to start again.
    await startGame(page, ROUND);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);
    await page.getByRole('button', { name: 'Play Again', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);

    await seedOfflineQuestions(page, ROUND);

    // Both halves of taking the network away: the app's own requests fail, and
    // so would anything else the page tried.
    await page.route('https://opentdb.com/**', (route) => route.abort('internetdisconnected'));
    await context.setOffline(true);

    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await expect(page).toHaveURL(/\/play$/);
    await expect(page.getByTestId('question-text')).toBeVisible();

    // The banner is raised only when the fetch actually threw and the pool
    // answered — so it is the assertion that distinguishes a round served from
    // storage from one that quietly succeeded over the network.
    await expect(
      page.getByText("You're offline — these questions are from your saved offline pool."),
    ).toBeVisible();

    for (let i = 0; i < ROUND; i++) {
      // Every seeded question labels its correct option `Right`, so the round
      // is answerable without knowing the order the pool shuffled into. The
      // click waits out the result pause on its own: the previous question's
      // button is disabled while the banner shows, and Playwright re-resolves
      // the locator until an enabled one is there.
      await answerOption(page, 'Right').click();
    }

    await expect(page).toHaveURL(/\/game-over$/);
    // The correct-answer count rather than the points tile: points are a
    // function of `FEAT-004`'s multipliers, which this spec has no business
    // asserting. Whitespace-tolerant because the `<span>` holding the total
    // sits on its own line, and `toHaveText` does not normalize a pattern
    // (`CLAUDE.md` §4.6).
    await expect(page.getByTestId('correct-answers')).toHaveText(
      new RegExp(`^\\s*${ROUND}\\s*/\\s*${ROUND}\\s*$`),
    );
  });
});
