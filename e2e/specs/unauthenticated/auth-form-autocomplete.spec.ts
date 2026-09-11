import { expect, test } from '../../fixtures/test';
import { authMenu, openAuthMenu } from '../../support/auth';
import { stubOpenTrivia } from '../../support/open-trivia';

/**
 * Finding G6. The auth form's `autocomplete` attributes turned out to be
 * mostly right already — the finding was phrased "needs confirming", and this
 * spec is that confirmation made permanent: `email` on the email input, and
 * `current-password`/`new-password` switched with the form's mode, which is
 * what lets a password manager offer the stored credential on sign-in but
 * generate a fresh one on sign-up. Without the tokens, WCAG 1.3.5 (Identify
 * Input Purpose) fails silently — Lighthouse and the template lint have no
 * audit for a *missing* autocomplete attribute.
 *
 * What the confirmation actually surfaced was the two *name* fields: the
 * profile display name and the game-over leaderboard name carried no token at
 * all. Both collect data about the user (the HTML `nickname` purpose); they
 * are asserted in profile.cy.ts and sign-in-save-score.cy.ts, since each
 * needs a real signed-in account to render.
 */
test.describe('auth form autocomplete (G6)', () => {
  test.beforeEach(async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');
    await openAuthMenu(page);
  });

  // The panel opens in *sign-up* mode ("Create an account"), so that is the
  // baseline each test starts from — asserting sign-in values first was this
  // spec's own first bug, caught by running it.
  test('identifies the email and password fields to a password manager', async ({ page }) => {
    const panel = authMenu(page);
    await expect(panel.locator('input[name=email]')).toHaveAttribute('autocomplete', 'email');
    await expect(panel.locator('input[name=password]')).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
  });

  test('switches the password purpose when the form switches mode', async ({ page }) => {
    const panel = authMenu(page);
    await panel
      .getByRole('button', { name: 'Already have an account? Sign in', exact: true })
      .click();
    await expect(panel.locator('input[name=password]')).toHaveAttribute(
      'autocomplete',
      'current-password',
    );

    // And back — the toggle is not one-way.
    await panel
      .getByRole('button', { name: "Don't have an account? Sign up", exact: true })
      .click();
    await expect(panel.locator('input[name=password]')).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
  });
});
