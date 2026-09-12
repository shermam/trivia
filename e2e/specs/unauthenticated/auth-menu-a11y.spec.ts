import { expect, test } from '../../fixtures/test';
import { authMenu } from '../../support/auth';
import { answerQuestion, startGame } from '../../support/game';
import { CORRECT_ANSWERS, stubOpenTrivia } from '../../support/open-trivia';

/**
 * Findings G1 and G2. The auth menu is a button that shows and hides a panel,
 * and it told assistive tech none of that: no `aria-expanded`, so a screen
 * reader announced a plain button and never said whether the panel was open;
 * no `aria-controls`, so nothing connected the two; and no role on the panel.
 * Keyboard behaviour was missing to match — Escape did nothing, opening left
 * focus on the trigger (so reaching an already-visible panel meant tabbing
 * through the rest of the page), and closing dropped focus to `<body>`.
 *
 * None of this is detectable by tooling: Lighthouse scores accessibility 1.0
 * and ESLint's `templateAccessibility` set reports zero errors with every one
 * of these present — confirmed empirically in #38. So it is pinned here, in a
 * real browser, where focus and keys actually exist.
 */
test.describe('auth menu accessibility (G1, G2)', () => {
  test.beforeEach(async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');
  });

  test('describes the panel it controls', async ({ page }) => {
    const trigger = page.getByTestId('auth-menu-trigger');

    // `dialog`, not `menu`: the panel holds a form, text inputs and links, and
    // an ARIA menu would have a screen reader announce those as menu items.
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await trigger.click();

    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const panelId = await trigger.getAttribute('aria-controls');
    expect(panelId, 'aria-controls names the panel').toBeTruthy();

    const named = page.locator(`#${panelId}`);
    await expect(named, 'aria-controls resolves to an element').toHaveCount(1);
    await expect(named).toHaveAttribute('role', 'dialog');
    await expect(named).toHaveAttribute('aria-label', /.+/);
  });

  test('moves focus into the panel when it opens', async ({ page }) => {
    await page.getByTestId('auth-menu-trigger').click();

    // Not merely "something is focused" — focus must be on *this* panel, which
    // is what stops a keyboard user having to tab the whole page to reach it.
    // The `data-cy` matters as much as the role: there is a second
    // `role="dialog"` in the document now (the nav drawer, permanently mounted
    // and `inert`), so the role alone could pass on the wrong element.
    await expect(authMenu(page)).toBeFocused();
    await expect(authMenu(page)).toHaveAttribute('role', 'dialog');
  });

  test('closes on Escape and gives focus back to the trigger', async ({ page }) => {
    const trigger = page.getByTestId('auth-menu-trigger');
    await trigger.click();
    await expect(authMenu(page)).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(authMenu(page)).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
  });

  test('gives focus back when closed with the panel’s own close button', async ({ page }) => {
    const trigger = page.getByTestId('auth-menu-trigger');
    await trigger.click();
    await authMenu(page).getByRole('button', { name: 'Close', exact: true }).click();

    await expect(authMenu(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  // The menu is not only opened from the top bar: game-over's "Sign in to save
  // your score" opens the same panel. Focus has to return to whatever opened
  // it, not to the top bar, or closing teleports the user across the page.
  test('returns focus to the opener when the menu was opened from elsewhere', async ({ page }) => {
    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    // By data-cy, not by text: the top bar's own trigger also reads "Sign in"
    // for an anonymous visitor, and it comes first in the DOM.
    const opener = page.getByTestId('open-sign-in');
    await opener.click();
    await expect(authMenu(page)).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(authMenu(page)).toHaveCount(0);
    // Back to game-over's own button, not the top bar's trigger.
    await expect(opener).toBeFocused();
  });
});
