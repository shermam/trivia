import { expect, Locator } from '@playwright/test';

/**
 * Which of the sentences stacked in one grid cell is showing.
 *
 * A plain support module rather than something exported from a spec: a spec
 * file's `test` calls run on import, so a helper living in one would silently
 * re-register its own tests inside every spec that imported it.
 */

/**
 * Fails unless, at one moment, the element named `shown` is visible inside
 * `cell` and every element named in `hidden` is not — the way to assert which
 * state a screen whose messages share one grid cell is in (`CLAUDE.md` §4.4).
 *
 * **One read of all of them, polled, rather than a `toBeVisible` and a
 * `toBeHidden` each retrying on its own** (`CLAUDE.md` §4.6). Before a
 * component's first binding pass no `invisible` class has been applied, so
 * every sentence in the cell reads as visible and a lone `toBeVisible` passes
 * before the state it names exists. And a state can move on by itself while a
 * matcher retries: a held read is aborted after ten seconds, so a sibling
 * wrongly showing during the wait hides again on the failed face, and a
 * second matcher passes against a moment the first never saw. Read together,
 * both halves have to be true of the same frame.
 *
 * Elements are named by their `data-cy`. Shown means what Playwright means by
 * visible: a box, and not hidden by `visibility` or `display` — `visibility`
 * being all that tells stacked sentences apart. A name not found in the cell
 * reads as absent, which matches neither.
 */
export async function expectShownAlone(
  cell: Locator,
  shown: string,
  hidden: readonly string[],
  what: string,
): Promise<void> {
  const names = [shown, ...hidden];
  await expect
    .poll(
      () =>
        cell.evaluate(
          (root, testIds) =>
            testIds.map((testId) => {
              const element = root.querySelector(`[data-cy="${testId}"]`);
              if (element === null) {
                return `${testId}: absent`;
              }
              const box = element.getBoundingClientRect();
              const visible =
                box.width > 0 &&
                box.height > 0 &&
                element.checkVisibility({ visibilityProperty: true });
              return `${testId}: ${visible ? 'shown' : 'hidden'}`;
            }),
          names,
        ),
      { message: `${what}: ${shown} shown and ${hidden.join(', ')} hidden, at one moment` },
    )
    .toEqual([`${shown}: shown`, ...hidden.map((testId) => `${testId}: hidden`)]);
}
