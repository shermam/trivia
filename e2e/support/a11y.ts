import { expect, Page } from '@playwright/test';

/**
 * Shared accessibility assertions.
 *
 * A plain support module rather than something exported from a spec: a spec
 * file's `test` calls run on import, so a helper living in one would silently
 * re-register its own tests inside every spec that imported it.
 */

/**
 * Fails unless every radio on the page sits in a `role="radiogroup"` that has a
 * non-empty accessible name (finding G4).
 *
 * A sweep over every radio rather than assertions about three known ids, so it
 * also covers the segmented picker nobody has added yet — which is the way this
 * regresses.
 *
 * Each check is its own `expect`, and that is deliberate: an attribute
 * assertion chained onto another is how a check stops being about the element
 * it named (`CLAUDE.md` §4.6). Here every assertion re-resolves its own
 * locator and none of them moves the subject.
 */
export async function expectRadiosAreGrouped(page: Page): Promise<void> {
  const radios = page.locator('input[type="radio"]');
  const count = await radios.count();
  expect(count, 'radios on the page').toBeGreaterThan(0);

  for (let index = 0; index < count; index++) {
    const radio = radios.nth(index);
    const name =
      (await radio.getAttribute('value')) ??
      (await radio.getAttribute('name')) ??
      '(unnamed radio)';

    // The nearest enclosing radiogroup, which is what `closest()` means. XPath
    // rather than a CSS `:has()` walk upwards, because CSS has no ancestor
    // axis and Playwright's locators only ever descend.
    const group = radio.locator('xpath=ancestor::*[@role="radiogroup"][1]');
    await expect(group, `radio "${name}" is inside a [role="radiogroup"]`).toHaveCount(1);

    const labelledBy = await group.getAttribute('aria-labelledby');
    expect(labelledBy, `radiogroup around "${name}" has aria-labelledby`).toBeTruthy();

    // The id has to resolve to something with text, or the group is labelled by
    // nothing — which reads exactly like having no label at all.
    const label = page.locator(`#${labelledBy}`);
    await expect(label, `#${labelledBy} exists`).toHaveCount(1);
    await expect(label, `#${labelledBy} is not empty`).not.toHaveText('');
  }
}
