import { expect, Locator, Page } from '@playwright/test';

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

/** Where an element is, in document coordinates — see {@link documentBox}. */
export interface DocumentBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * One reading of an element's box in **document** coordinates.
 *
 * Document rather than viewport coordinates, because a click that scrolls a
 * control into view would otherwise read as the layout moving. One read, so
 * never an assertion on its own (`CLAUDE.md` §4.6): take it through
 * {@link settledBox} or {@link expectBoxUnmoved}.
 */
export function documentBox(element: Locator): Promise<DocumentBox> {
  return element.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
      height: rect.height,
    };
  });
}

/** The furthest any edge of a box moved, after {@link drift}'s sub-pixel tolerance. */
export function largestShift(before: DocumentBox, after: DocumentBox): number {
  return Math.max(
    ...(['top', 'left', 'width', 'height'] as const).map((edge) =>
      Math.abs(drift(after[edge], before[edge])),
    ),
  );
}

/**
 * {@link documentBox} once two consecutive readings agree — the baseline of a
 * before/after pair, read the way {@link settledHeight} reads a height, so it
 * cannot be a frame caught mid-layout. Assert the state first, then measure.
 */
export async function settledBox(element: Locator, what: string): Promise<DocumentBox> {
  let previous: DocumentBox | null = null;
  let settled: DocumentBox | null = null;

  await expect
    .poll(
      async () => {
        const box = await documentBox(element);
        const agrees = previous !== null && box.height > 0 && largestShift(previous, box) === 0;
        previous = box;
        if (agrees) {
          settled = box;
        }
        return agrees;
      },
      { message: `${what} settling to a stable box` },
    )
    .toBe(true);

  return settled!;
}

/**
 * Fails unless an element is exactly where it was and exactly as big, once
 * whatever just changed has finished rendering. Polled for the reason
 * {@link expectSameHeight} is: the only value it can settle to is the box it
 * started with.
 */
export async function expectBoxUnmoved(
  element: Locator,
  box: DocumentBox,
  what: string,
): Promise<void> {
  await expect
    .poll(async () => largestShift(box, await documentBox(element)), {
      message: `${what} (expected to stay at ${JSON.stringify(box)})`,
    })
    .toBe(0);
}

/**
 * Fails unless an element's content fits its own box — `scrollWidth` no wider
 * than `clientWidth` — so none of its text is cut off or spills past it.
 *
 * The check a text assertion cannot make: `toHaveText` reads the DOM, which
 * holds the whole string whether or not the box shows it, so a line that
 * `truncate` clips to "…· run 20" still has the text a test asked for. Polled
 * rather than read once (`CLAUDE.md` §4.6): a width read mid-layout would fail
 * for a frame no reader saw, or pass on one before the text arrived.
 */
export async function expectUnclipped(element: Locator, what: string): Promise<void> {
  await expect
    .poll(() => element.evaluate((node) => node.scrollWidth - node.clientWidth), {
      message: `${what} (its content wider than its box, in pixels)`,
    })
    .toBeLessThanOrEqual(0);
}

/**
 * Fails unless the page is no wider than its window — the document's
 * `scrollWidth` at most `window.innerWidth` — so nothing on it scrolls the
 * whole page sideways.
 *
 * The page rather than one element, because what a reader meets is the page
 * scrolling, whichever element is too wide. Polled rather than read once
 * (`CLAUDE.md` §4.6), so a frame caught mid-layout cannot fail it for a width
 * no reader saw — and the only value it can settle to is a page that fits.
 * Assert the state under test first: a page read before its content has
 * rendered fits trivially. A failure reports how many pixels too wide the
 * page is.
 */
export async function expectNoSidewaysScroll(page: Page, what: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), {
      message: `${what} (the page wider than its window, in pixels)`,
    })
    .toBeLessThanOrEqual(0);
}
