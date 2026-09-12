import { expect, test } from '../../fixtures/test';
import { stubOpenTrivia } from '../../support/open-trivia';

test.describe('embed mode', () => {
  // Neither test starts a game; the stub is only so that a run never depends
  // on a third-party service being up.
  test.beforeEach(async ({ page }) => {
    await stubOpenTrivia(page);
  });

  test('shows the top bar by default', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('header')).toHaveCount(1);
  });

  test('hides the top bar when ?embed=1 is present', async ({ page }) => {
    await page.goto('/?embed=1');

    // The positive anchors come first, and that ordering is the test: a count
    // of zero is satisfied by a page that has not rendered yet, so a "no
    // header" assertion made before anything is on screen passes against the
    // very regression it guards (`docs/ci-cd.md` §4.3). These also say the
    // game itself stays fully usable with no top bar.
    await expect(page.getByRole('heading', { name: 'Trivimind', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Game', exact: true })).toBeVisible();
    await expect(page.locator('header')).toHaveCount(0);
  });
});
