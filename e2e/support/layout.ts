import { expect, Locator } from '@playwright/test';

/**
 * Shared layout measurement, for the guardrail in `CLAUDE.md` §4.4: a
 * component keeps the same size across its state changes.
 *
 * A plain support module rather than something exported from a spec: a spec
 * file's `test` calls run on import, so a helper living in one would silently
 * re-register its own tests inside every spec that imported it.
 */

/**
 * The pixel tolerance every layout assertion using this module applies.
 *
 * Sub-pixel, because these tests are about a box moving and a box staying put:
 * anything looser would pass through the 43px and 508px jumps they exist to
 * catch, and anything tighter would fail on fractional layout rounding.
 * Anything larger than the tolerance is returned as-is, so a failure names the
 * jump rather than merely reporting that there was one.
 */
export function drift(actual: number, expected: number): number {
  const delta = actual - expected;
  return Math.abs(delta) <= 0.5 ? 0 : delta;
}

/** A single comparison, for a measurement already gated on a settled state. */
export function expectUnmoved(actual: number, expected: number, what: string): void {
  expect(drift(actual, expected), `${what} (${actual} vs ${expected})`).toBe(0);
}

/**
 * The height of a box, once two consecutive readings agree on it.
 *
 * The first measurement of a before/after pair is the awkward one:
 * `boundingBox()` resolves once against whatever the DOM happened to be at
 * that instant (`CLAUDE.md` §4.6), and there is no matcher to read it through,
 * because the value it should hold is precisely what the test does not know
 * yet. Polling until two readings agree is the retrying form of "measure it
 * when it has stopped moving" — the loop cannot settle mid-layout, and the
 * number it returns is one a second reading has already confirmed.
 *
 * It is not a substitute for gating on the state under test: settling says the
 * box has stopped changing, not that it is showing what the test is about.
 * Assert the state first, then measure.
 */
export async function settledHeight(box: Locator, what: string): Promise<number> {
  let previous = Number.NaN;
  let settled = Number.NaN;

  await expect
    .poll(
      async () => {
        const height = (await box.boundingBox())?.height ?? Number.NaN;
        const agrees = height > 0 && drift(height, previous) === 0;
        previous = height;
        if (agrees) {
          settled = height;
        }
        return agrees;
      },
      { message: `${what} settling to a stable height` },
    )
    .toBe(true);

  return settled;
}

/**
 * Fails unless a box is still exactly as tall as it was, however long the
 * state change it just went through takes to finish rendering.
 *
 * Polled rather than read once: the arrival of a new state is a render the
 * runner does not synchronise with, so a single measurement can land on a
 * frame mid-layout and fail for a jump that never reaches a reader's eye. A
 * jump that *does* is not forgiven by polling — the only value this can settle
 * to is the height it started at.
 */
export async function expectSameHeight(box: Locator, height: number, what: string): Promise<void> {
  await expect
    .poll(async () => drift((await box.boundingBox())?.height ?? Number.NaN, height), {
      message: `${what} (expected to stay ${height}px)`,
    })
    .toBe(0);
}
