import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { stubOpenTrivia } from '../../support/open-trivia';

/**
 * The path, polled rather than read once: each of these routes is reached by a
 * real navigation and *then* redirected by a guard, so the first read is the
 * route that is about to be left. `expect.poll` retries until the redirect has
 * happened — and a guard that never fires still fails, because the only value
 * this can settle to is the one the test names.
 */
async function expectPathname(page: Page, pathname: string): Promise<void> {
  await expect
    .poll(() => new URL(page.url()).pathname, { message: `redirected to ${pathname}` })
    .toBe(pathname);
}

test.describe('route guards', () => {
  // The stub is not what is under test here — none of these tests starts a
  // game — but landing on `/` fetches the category list, and a run should
  // never depend on a third-party service being up.
  test.beforeEach(async ({ page }) => {
    await stubOpenTrivia(page);
  });

  test('redirects /play to / when there is no active question in memory', async ({ page }) => {
    await page.goto('/play');
    await expectPathname(page, '/');
  });

  test('redirects /game-over to / when there is no completed game in memory', async ({ page }) => {
    await page.goto('/game-over');
    await expectPathname(page, '/');
  });

  test('redirects unknown routes to /', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');
    await expectPathname(page, '/');
  });
});
