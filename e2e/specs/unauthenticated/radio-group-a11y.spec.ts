import { expect, test } from '../../fixtures/test';
import { expectRadiosAreGrouped } from '../../support/a11y';
import { stubOpenTrivia } from '../../support/open-trivia';

/**
 * Finding G4. The segmented pickers are built from real `<input type="radio">`
 * elements hidden with `sr-only`, so each option was already announced with its
 * own name — what was missing was the *group*. The visible caption above each
 * box is a plain `<span>`, which labels nothing, so a screen reader said
 * "Open Trivia, radio button, 1 of 3" and never mentioned **Question Source**.
 *
 * Written as a sweep over every radio on the page rather than as three
 * assertions about three known ids, so it also covers the segmented picker
 * nobody has added yet — which is the way this regresses.
 */
test.describe('segmented radio groups (G4)', () => {
  test('labels the question-source picker on the setup screen', async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');
    // Stands in for Cypress's `cy.wait('@categories')`: the dropdown is built
    // from the stubbed response, so a stubbed name appearing in it means the
    // setup *screen* is really rendered, which is the screen this test names.
    // The sweep below waits for the radios itself, so this is not what keeps it
    // from running against a blank page — it is what stops the test passing on
    // some other screen that happens to have radios on it.
    await expect(page.locator('#category')).toContainText('General Knowledge');

    await expectRadiosAreGrouped(page);

    // And the group's name is the caption the sighted user reads.
    const firstGroup = page.locator('[role="radiogroup"]').first();
    const labelledBy = await firstGroup.getAttribute('aria-labelledby');
    await expect(page.locator(`#${labelledBy}`)).toHaveText('Question Source');
  });
});
