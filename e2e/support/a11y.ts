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
 *
 * **The sweep waits for the radios rather than sampling them.** `count()` is a
 * one-shot query with no retry, so on a screen that renders after a round trip
 * — `/add-question` waits on a subscription read and a forced token refresh
 * before the Pro-gated form exists at all — it returned `0` and failed on
 * "radios on the page" before the thing under test had rendered. A retrying
 * `not.toHaveCount(0)` in front of it makes the helper sound at every call
 * site, rather than making each caller remember an anchor.
 */
export async function expectRadiosAreGrouped(page: Page): Promise<void> {
  const radios = page.locator('input[type="radio"]');
  await expect(radios, 'radios on the page').not.toHaveCount(0);
  const count = await radios.count();

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
    expect(labelledBy?.trim(), `radiogroup around "${name}" has aria-labelledby`).toBeTruthy();

    // Every id has to resolve to something with text, or the group is labelled
    // by nothing — which reads exactly like having no label at all. The
    // attribute is a list of ids, and a group can be named by more than one:
    // the avatar picker names each set's rows by the set's heading and the
    // row's label together ("Bold Shape"), so each is checked on its own.
    for (const id of (labelledBy ?? '').split(/\s+/).filter(Boolean)) {
      const label = page.locator(`[id="${id}"]`);
      await expect(label, `#${id} exists`).toHaveCount(1);
      await expect(label, `#${id} is not empty`).not.toHaveText('');
    }
  }
}
