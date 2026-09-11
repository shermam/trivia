import { expect, Page } from '@playwright/test';

/**
 * Shared accessibility assertions.
 *
 * A plain support module rather than something exported from a spec: importing
 * from a spec file executes its `test` registrations too, so the helper's own
 * tests would silently re-run inside every spec that imported it.
 */

/**
 * Fails unless every radio on the page sits in a `role="radiogroup"` that has a
 * non-empty accessible name (finding G4).
 *
 * A sweep over every radio rather than assertions about three known ids, so it
 * also covers the segmented picker nobody has added yet — which is the way this
 * regresses.
 *
 * One `evaluate` for the whole sweep rather than a locator per radio: the
 * question is about the shape of the rendered document at a single moment, and
 * walking it in the page is both one round trip and immune to a re-render
 * landing between the radios and their groups.
 */
export async function assertRadiosAreGrouped(page: Page): Promise<void> {
  await expect(page.locator('input[type="radio"]')).not.toHaveCount(0);

  const findings = await page.evaluate(() =>
    [...document.querySelectorAll('input[type="radio"]')].map((radio) => {
      const name = radio.getAttribute('value') ?? radio.getAttribute('name') ?? '(unnamed radio)';
      const group = radio.closest('[role="radiogroup"]');
      const labelledBy = group?.getAttribute('aria-labelledby') ?? null;
      const label = labelledBy ? document.getElementById(labelledBy) : null;
      return {
        name,
        grouped: group !== null,
        labelledBy,
        // The id has to resolve to something with text, or the group is
        // labelled by nothing — which reads exactly like having no label at
        // all.
        labelText: label?.textContent ?? null,
      };
    }),
  );

  for (const finding of findings) {
    expect(finding.grouped, `radio "${finding.name}" is inside a [role="radiogroup"]`).toBe(true);
    expect(
      finding.labelledBy,
      `radiogroup around "${finding.name}" has aria-labelledby`,
    ).toBeTruthy();
    expect(
      finding.labelText,
      `aria-labelledby="${finding.labelledBy}" around "${finding.name}" resolves to an element`,
    ).not.toBeNull();
    expect(
      finding.labelText?.trim(),
      `the label for the radiogroup around "${finding.name}" has text`,
    ).not.toBe('');
  }
}
