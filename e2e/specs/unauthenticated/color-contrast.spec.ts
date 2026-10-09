import { expect, test } from '../../fixtures/test';
import { expectReadableText } from '../../support/contrast';
import { answerQuestion, startGame, waitForPlayRoute } from '../../support/game';
import { CORRECT_ANSWERS, questionsFixture } from '../../support/open-trivia';

/**
 * Text contrast on the screens Lighthouse never sees (`CLAUDE.md` §4.5).
 *
 * CI asserts Lighthouse's `color-contrast` audit on its own (`docs/ci-cd.md`
 * §4.4), and that audit loads `/` once, in a fresh profile, in the light
 * theme. So a screen that needs a game in progress, a finished round or the
 * dark theme is outside it by construction — and three failures sat there
 * unseen: the resume banner's Resume button at 3.65:1, the game-over card's
 * "/ 5" at 2.51:1 light and 3.34:1 dark, and the accuracy tile's "Great job!"
 * at 3.49:1 light. This spec plays its way to both screens, in both themes,
 * and measures every piece of text in the banner and in the score card from
 * the colours the browser actually painted (`e2e/support/contrast.ts`), so a
 * palette change that lets one of them slip fails here rather than nowhere.
 *
 * **The round lands in the tier that failed.** The accuracy tile wears its
 * tier's colour on a 12px label as well as on its figure, so where the round
 * lands decides what is measured: four answers of five is 80%, "Great job!",
 * the tier that was under the line. Each of the other three would cost a round
 * of its own, and is not replayed here.
 *
 * **The theme is the browser's, not a toggle.** With nothing stored,
 * `public/theme-init.js` follows `prefers-color-scheme` before the app boots,
 * so `colorScheme` puts each test in its theme from the first frame — and the
 * `dark` class on the root is asserted before anything is measured, so a test
 * that silently ran in the other theme would fail on that, not pass.
 */

/** The second question's first wrong option — the one answer of five this round gets wrong. */
const WRONG_ANSWER = questionsFixture.results[1].incorrect_answers[0];

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`text contrast in the ${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the resume banner, and the score card of a four-in-five round', async ({ page }) => {
      await startGame(page, 5);
      const root = page.locator('html');
      if (colorScheme === 'dark') {
        await expect(root).toHaveClass(/(^|\s)dark(\s|$)/);
      } else {
        await expect(root).not.toHaveClass(/(^|\s)dark(\s|$)/);
      }

      await answerQuestion(page, CORRECT_ANSWERS[0]);
      await expect(page.getByText('Question 2 / 5').first()).toBeVisible();

      // The top bar's logo is how a player abandons a round part-way, and the
      // banner is what they come back to.
      await page.locator('header a[href="/"]').first().click();
      const banner = page.getByTestId('resume-banner');
      await expect(banner).toBeVisible();
      await expectReadableText(
        banner,
        ['You have a game in progress — question 2 of 5.', 'Resume', 'Discard'],
        `the resume banner, ${colorScheme}`,
      );

      await page.getByTestId('resume-game').click();
      await waitForPlayRoute(page);
      await answerQuestion(page, WRONG_ANSWER);
      for (const answer of CORRECT_ANSWERS.slice(2)) {
        await answerQuestion(page, answer);
      }

      await expect(page).toHaveURL(/\/game-over$/);
      const summary = page.getByTestId('score-summary');
      await expect(summary).toContainText('Great job!');
      await expectReadableText(
        summary,
        ['80%', 'Great job!', '/ 5', 'correct answers', 'in a row'],
        `the score card, ${colorScheme}`,
      );
    });
  });
}
