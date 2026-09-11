import { Locator, Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { stubOpenTrivia } from '../../support/open-trivia';

/**
 * The responsive top bar (`docs/app.md`).
 *
 * The unit spec covers the drawer's behaviour — `aria-expanded`, Escape, focus
 * in and back, the breakpoint teardown. None of that says anything about which
 * elements are *visible* at which width, because that is decided entirely by
 * Tailwind classes and jsdom does not do layout. This spec runs at real
 * viewports, which is the only place those classes mean anything.
 *
 * Since the drawer became an always-mounted overlay that slides rather than an
 * `@if` that appears, this is also the only place two of its guarantees can be
 * checked at all. jsdom parses `inert` and enforces none of it, so "closed
 * means unfocusable and untappable" is a browser-only assertion; and the slide
 * itself is a transform, which jsdom has no opinion about.
 *
 * The viewport is set with `test.use({ viewport })` per block rather than from
 * inside each test: it is a property of the browser context, so declaring it
 * means the context is *built* at that size and the first paint every test sees
 * is already the one it is about.
 */

const MOBILE = { width: 390, height: 780 };
/**
 * The narrowest width the app supports, and the one the 390px suite below was
 * quietly standing in for. `iPhone SE (1st gen)` is 320 CSS px, and so is any
 * desktop window dragged that narrow.
 */
const NARROW = { width: 320, height: 780 };
const DESKTOP = { width: 1024, height: 800 };

/** The brand link, which is also the only `href="/"` in the bar. */
function brand(page: Page): Locator {
  return page.locator('header a[href="/"]').first();
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
}

/**
 * A bounding rect read in the browser.
 *
 * `boundingBox()` would do for most of these, but it reports only `x`, `y`,
 * `width` and `height` — and half the assertions here are about an element's
 * **right** edge, which is the edge that runs into something else.
 */
function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const { x, y, width, height, right } = element.getBoundingClientRect();
    return { x, y, width, height, right };
  });
}

/**
 * The account chip, measured **after it has stopped growing**.
 *
 * The chip's "Sign in" label wipes into view by transitioning `max-width` from
 * `0` to a cap over 600ms (`top-bar.component.html`), so for the first third of
 * a second after auth resolves the chip is narrower than it will be — and
 * therefore starts further right. Every assertion here compares the chip's left
 * edge against something to its left, so a single early read is wrong in the
 * **passing** direction: a chip that will overlap the brand does not overlap it
 * yet, and the test says so.
 *
 * Two steps, and both are needed. The text anchor proves the label exists,
 * which is the moment the transition *starts* — not the moment it ends. The
 * poll then waits for two consecutive reads to agree, which is what "ended"
 * means here: the transition moves the edge every frame while it runs, and a
 * reader who has asked for reduced motion gets no transition at all and settles
 * on the first comparison.
 */
async function settledChipRect(page: Page): Promise<Rect> {
  const chip = page.getByTestId('auth-menu-trigger');
  await expect(chip, 'the chip is showing its sign-in label').toContainText('Sign in');

  let previous = await rectOf(chip);
  await expect
    .poll(
      async () => {
        const current = await rectOf(chip);
        const settled = current.x === previous.x && current.width === previous.width;
        previous = current;
        return settled;
      },
      { message: 'the account chip has finished animating its width' },
    )
    .toBe(true);
  return previous;
}

/** The layout viewport, which is what "centred" and "does not overflow" are about. */
function layoutViewport(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));
}

function expectWithin(actual: number, expected: number, tolerance: number, what: string): void {
  expect(Math.abs(actual - expected), what).toBeLessThanOrEqual(tolerance);
}

/**
 * The account chip's label region, measured for overflow.
 *
 * The label animates by transitioning `max-width` from `0` to a cap, so the cap
 * is a number the label has to stay under — and a label wider than its cap is
 * not clipped for the length of the animation, it is clipped **forever**.
 *
 * That makes the cap a silent failure by construction: "Sign in" would simply
 * render as "Sign i" and nothing else in the suite would notice. The cap is
 * deliberately tight (4rem against a 53.4px label) because the ratio of label
 * to cap is the fraction of the transition that is visible, so this is the
 * assertion that pays for choosing timing over slack.
 *
 * `scrollWidth` against `clientWidth` rather than a fixed number, so it keeps
 * working if the font, the copy or the root font size changes — which is the
 * whole point, since those are exactly what would move the label past the cap.
 */
async function expectSignInLabelUncut(page: Page): Promise<void> {
  const region = page.getByTestId('auth-menu-trigger').locator('span.overflow-hidden');
  // Both widths read in one browser round trip, and polled: the region opens
  // from `max-width: 0` over the page's first quarter-second, so two separate
  // one-shot reads could straddle the animation and compare a settled
  // `scrollWidth` against a mid-transition `clientWidth`. Reading them together
  // means every comparison is of one frame with itself; polling means the one
  // that decides is a settled frame. A label that is genuinely cut stays cut,
  // so no amount of retrying forgives it.
  //
  // `collapsed` is not decoration: signed out is the one state whose label is
  // supposed to be visible, and an overflow check against a zero-width region
  // passes vacuously.
  await expect
    .poll(
      async () => {
        const { scrollWidth, clientWidth } = await region.evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }));
        return { cut: scrollWidth > clientWidth, collapsed: clientWidth === 0 };
      },
      { message: 'the sign-in label must be fully visible inside its max-width cap' },
    )
    .toEqual({ cut: false, collapsed: false });
}

test.describe('the top bar on a phone', () => {
  test.use({ viewport: MOBILE });

  test.beforeEach(async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');
  });

  test('shows the hamburger and hides the inline links', async ({ page }) => {
    await expect(page.getByTestId('nav-menu-trigger')).toBeVisible();

    const pricing = page.locator('header a[href="/pricing"]');
    // Present and hidden, not merely absent: `toBeHidden()` is also satisfied
    // by an element that does not exist, which is a different bug wearing the
    // same result.
    await expect(pricing).toHaveCount(1);
    await expect(pricing).toBeHidden();
  });

  /**
   * The regression guard for a bug this actually had. The first attempt used
   * `grid-cols-[auto_1fr_auto]`, which centres the brand between the two side
   * items rather than in the bar — measured 21px off centre in a browser,
   * because the account chip is much wider than the hamburger. Only a
   * measurement catches that; it looks approximately right by eye.
   */
  test('centres the brand in the bar, not between its neighbours', async ({ page }) => {
    const rect = await rectOf(brand(page));
    // Against `clientWidth`, not the viewport width this block declares. A
    // classic scrollbar takes layout space, so the two differ by its width —
    // this first read 187.5 against an expected 195, which is exactly half a
    // 15px scrollbar and not an off-centre brand. `clientWidth` is the layout
    // viewport, which is what the grid centres within and therefore what
    // "centred" has to mean here.
    const { width } = await layoutViewport(page);
    expectWithin(rect.x + rect.width / 2, width / 2, 1, 'brand centre against the bar centre');
  });

  test('does not overflow horizontally', async ({ page }) => {
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, 'the page scrolls sideways').toBeLessThanOrEqual(
      overflow.clientWidth,
    );
  });

  /**
   * The account chip is the widest thing in the bar and the only part whose
   * width is user-controlled, so it is the one that can push into the brand.
   * A signed-in chip is covered in `authenticated/`; this pins the anonymous
   * one, which is the state every first-time visitor sees.
   */
  test('keeps the account chip clear of the brand', async ({ page }) => {
    const chip = await settledChipRect(page);
    const mark = await rectOf(brand(page));
    expect(mark.right, 'the brand running under the account chip').toBeLessThanOrEqual(chip.x);
  });

  /**
   * **The assertion this file was missing.** It measured the chip's width, its
   * overlap with the brand and the brand's centring — and never its height. So
   * "Sign in" wrapping to two lines inside the `minmax(0,1fr)` grid track,
   * rendering the chip 54px tall in a 64px bar, shipped green.
   *
   * A single line is 42px. 46 leaves room for a font-metric wobble and still
   * fails outright on a second line.
   */
  test('keeps the account chip to a single line', async ({ page }) => {
    const chip = (await page.getByTestId('auth-menu-trigger').boundingBox())!;
    expect(chip.height, 'account chip height').toBeLessThanOrEqual(46);
  });

  test('shows the whole sign-in label, uncut by the animation cap', async ({ page }) => {
    await expectSignInLabelUncut(page);
  });

  test('opens a drawer holding the links the bar dropped', async ({ page }) => {
    await page.getByTestId('nav-menu-trigger').click();

    await expect(page.getByTestId('nav-menu-panel')).toBeVisible();
    await expect(page.getByTestId('nav-menu-pricing-link')).toBeVisible();
    await expect(page.getByTestId('nav-menu-theme-toggle')).toBeVisible();
  });

  test('covers the full height of the viewport', async ({ page }) => {
    // `<header>` carries `backdrop-blur-md`, and a backdrop-filter ancestor
    // becomes the containing block for `position: fixed` descendants — so a
    // drawer rendered inside the header collapses to its 4rem box. It renders
    // outside for that reason, and this is what would notice if it moved back.
    await page.getByTestId('nav-menu-trigger').click();
    const panel = page.getByTestId('nav-menu-panel');
    await expect(panel).toBeVisible();
    const { height } = await layoutViewport(page);
    expectWithin((await panel.boundingBox())!.height, height, 2, 'drawer height');
  });

  test('navigates and closes when a drawer link is followed', async ({ page }) => {
    await page.getByTestId('nav-menu-trigger').click();
    await page.getByTestId('nav-menu-pricing-link').click();

    await expect(page).toHaveURL(/\/pricing$/);
    // Hidden, not gone: the drawer stays in the document so it can transition
    // on the way out. The assertion retries, so this also quietly requires the
    // exit to actually finish rather than leaving a permanently visible panel
    // over the page it just navigated to.
    await expect(page.getByTestId('nav-menu-panel')).toBeHidden();
  });

  test('closes on Escape and returns focus to the hamburger', async ({ page }) => {
    const trigger = page.getByTestId('nav-menu-trigger');
    await trigger.click();
    await expect(page.getByTestId('nav-menu-panel')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByTestId('nav-menu-panel')).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('closes when the backdrop is tapped', async ({ page }) => {
    await page.getByTestId('nav-menu-trigger').click();
    await tapBackdropRightEdge(page);

    await expect(page.getByTestId('nav-menu-panel')).toBeHidden();
  });

  /**
   * The drawer is in the DOM on every page load now, closed. Everything that
   * makes "closed" mean closed — no tab stop, nothing in the accessibility
   * tree, nothing hit-tested — rides on `inert` and `pointer-events-none`, and
   * jsdom enforces neither, so this is the only place it can be checked.
   */
  test('leaves nothing tappable behind while it is closed', async ({ page }) => {
    await expect(page.getByTestId('nav-menu-overlay')).toHaveAttribute('inert', '');

    const swallowed = await page.evaluate(() => {
      const overlay = document.querySelector('[data-cy="nav-menu-overlay"]');
      const hit = document.elementFromPoint(20, document.documentElement.clientHeight / 2);
      return overlay?.contains(hit) ?? null;
    });
    expect(swallowed, 'the closed drawer swallowing a tap').toBe(false);
  });

  /**
   * **The reason this design was chosen over `animate.leave`.** Angular's
   * version defers the DOM removal but tears the view down synchronously, so
   * for the length of the exit there is a drawer on screen whose `(click)`
   * handlers are already gone — visible, focusable, and covering the viewport.
   *
   * Here `inert` and `pointer-events-none` land with the signal rather than
   * with the animation. Measured in Chromium with a `MutationObserver`: both
   * are on **4.2ms** after the click, with the panel still at x=0 and the
   * backdrop still at full opacity — the exit has not started moving anything
   * yet.
   *
   * **What this assertion pins is the contract, not that number.** A retrying
   * assertion would be satisfied just as well if `inert` only arrived when the
   * animation ended, and the version that would catch it — asserting `inert`
   * while the panel is still visible — is a race against the 250ms exit that
   * would go flaky the first time CI was slow. So: the contract here, the
   * timing by measurement, and the mechanism written down where it is easy to
   * break.
   */
  test('stops intercepting when it is dismissed', async ({ page }) => {
    await page.getByTestId('nav-menu-trigger').click();
    await tapBackdropRightEdge(page);

    // Two assertions on the same element, each re-resolving its own locator so
    // neither can move the subject out from under the other — which is what
    // `should('have.attr', name)` did in Cypress, where the chained
    // `have.class` ran against the attribute's string value and failed with
    // "neither a DOM object nor a jQuery object" (`CLAUDE.md` §4.6).
    const overlay = page.getByTestId('nav-menu-overlay');
    await expect(overlay, 'dismissed drawer still interactive').toHaveAttribute('inert', '');
    await expect(overlay, 'dismissed drawer still taking pointer events').toHaveClass(
      /pointer-events-none/,
    );
  });

  /**
   * **The backdrop dims the whole viewport, not just the strip beside the
   * panel.** It used to be a `flex-1` sibling covering only what the panel did
   * not, which looks identical while the drawer is open and is obviously wrong
   * the moment it closes: the panel slides left off bare, undimmed page and
   * the dim ends in a hard vertical line travelling across the screen.
   *
   * Asserted against the layout viewport rather than the declared one, for the
   * same reason the brand-centring test above is — a classic scrollbar takes
   * layout width.
   */
  test('dims the whole viewport, not just the part the panel misses', async ({ page }) => {
    await page.getByTestId('nav-menu-trigger').click();

    const backdrop = page.getByTestId('nav-menu-backdrop');
    await expect(backdrop).toBeVisible();
    const rect = await rectOf(backdrop);
    const viewport = await layoutViewport(page);

    expectWithin(rect.x, 0, 1, 'backdrop starting to the right of the panel');
    expectWithin(rect.width, viewport.width, 1, 'backdrop narrower than the viewport');
    expectWithin(rect.height, viewport.height, 1, 'backdrop shorter than the viewport');
  });

  /**
   * The slide itself. Closed, the panel is parked entirely off the left edge by
   * `-translate-x-full`; open, it rests against it.
   *
   * Measured rather than asserted on the class, because `-translate-x-full`
   * only parks the panel off-screen if the panel is the thing being translated
   * and its width is what "full" resolves against — a wrapper picking up the
   * class instead would read as present and move nothing.
   */
  test('parks the panel off the left edge until it is opened', async ({ page }) => {
    const panel = page.getByTestId('nav-menu-panel');
    // `at most 1` rather than `at most 0`: `-translate-x-full` is exactly minus
    // the panel's own width, so the right edge lands on 0 by construction —
    // and a rect built from two floats that cancel is exactly the place not to
    // demand an exact zero. One pixel of slack still fails by 287 if the panel
    // is not parked.
    expect((await rectOf(panel)).right, 'closed panel still on screen').toBeLessThanOrEqual(1);

    await page.getByTestId('nav-menu-trigger').click();
    await expect(panel).toBeVisible();

    await expect
      .poll(async () => Math.abs((await rectOf(panel)).x), {
        message: 'open panel not at the left edge',
      })
      .toBeLessThanOrEqual(1);
  });

  /**
   * **Focus-on-open is what the always-mounted drawer actually broke, twice.**
   * The panel sits in a subtree that is `inert` and `visibility: hidden` until
   * the drawer opens, and `focus()` on an element in either state is a silent
   * no-op — so opening it now depends on both of those being genuinely gone by
   * the time focus moves, which they were not:
   *
   * 1. A plain `effect()` runs *before* its bindings reach the DOM. It had
   *    always run in the wrong order; a `viewChild` resolving late used to
   *    force a second run once the DOM was right, and making the panel
   *    permanent removed that accident. Fixed with `afterRenderEffect`.
   * 2. With the `visibility` transition applied in both directions, the first
   *    frame after opening sits at progress 0 where `visibility` still computes
   *    to `hidden`. Fixed by transitioning it only on the way out.
   *
   * Both failed *silently*, and neither is visible to the unit spec, which
   * asserts the same thing and passes either way because jsdom enforces
   * neither attribute. This is the assertion with teeth.
   */
  test('moves focus into the panel on open, past the inert it just dropped', async ({ page }) => {
    await page.getByTestId('nav-menu-trigger').click();

    await expect(page.getByTestId('nav-menu-panel')).toBeFocused();
  });
});

/**
 * **The same bar at 320px, because 390 was hiding a real defect.**
 *
 * `keeps the account chip clear of the brand` has been in this file all along
 * and passed throughout — at 390, where the brand clears the chip by 23px. At
 * 320 it did not clear it at all: measured on production, the brand's right
 * edge reached 220.34 against a chip starting at 208.64, so the wordmark
 * "Trivimind" rendered **underneath** the account button by 11.7px. The chip
 * in question is the signed-out one, the widest state, which is what a
 * first-time visitor sees.
 *
 * The arithmetic is why one viewport could not stand in for the other. The
 * brand is centred in the *bar*, so its right edge is `W/2 + brandWidth/2`,
 * while the chip is right-aligned at `W - padding - chipWidth`. Clearance is
 * therefore `W/2 - 171.7` — a function of the viewport that goes negative
 * below ~343px and grows from there. A single wide-enough width can never
 * fail, and tells you nothing about the widths that can.
 */
test.describe('the top bar at its narrowest', () => {
  test.use({ viewport: NARROW });

  test.beforeEach(async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');
  });

  test('keeps the account chip clear of the brand', async ({ page }) => {
    const chip = await settledChipRect(page);
    const mark = await rectOf(brand(page));
    expect(mark.right, 'the brand running under the account chip').toBeLessThanOrEqual(chip.x);
  });

  /**
   * The brand shrinks here rather than disappearing, and both halves of that
   * matter: something has to give at this width, and what was chosen to give
   * was size, not the name or the chip's "Sign in" label.
   */
  test('still shows the whole wordmark', async ({ page }) => {
    await expect(brand(page)).toBeVisible();
    await expect(brand(page)).toContainText('Trivimind');
  });

  test('does not overflow horizontally', async ({ page }) => {
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, 'the page scrolls sideways').toBeLessThanOrEqual(
      overflow.clientWidth,
    );
  });

  test('centres the brand in the bar', async ({ page }) => {
    const rect = await rectOf(brand(page));
    const { width } = await layoutViewport(page);
    expectWithin(rect.x + rect.width / 2, width / 2, 1, 'brand centre against the bar centre');
  });

  test('keeps the account chip to a single line', async ({ page }) => {
    const chip = (await page.getByTestId('auth-menu-trigger').boundingBox())!;
    expect(chip.height, 'account chip height').toBeLessThanOrEqual(46);
  });
});

test.describe('the top bar on a wide screen', () => {
  test.use({ viewport: DESKTOP });

  test.beforeEach(async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');
  });

  test('shows the links inline and no hamburger', async ({ page }) => {
    await expect(page.locator('header a[href="/pricing"]')).toBeVisible();

    const hamburger = page.getByTestId('nav-menu-trigger');
    await expect(hamburger).toHaveCount(1);
    await expect(hamburger).toBeHidden();
  });

  /**
   * The same cap guard as on a phone, at the width where it used not to apply.
   *
   * The label region was uncapped above `sm` until the chip stopped showing a
   * display name; now every viewport shares one rule and one 4rem cap, so the
   * clipping risk exists here too and is checked here too.
   */
  test('shows the whole sign-in label, uncut by the animation cap', async ({ page }) => {
    await expectSignInLabelUncut(page);
  });

  test('keeps the brand on the left, where it has always been', async ({ page }) => {
    const rect = await rectOf(brand(page));
    expect(rect.x, 'brand pushed in from the left edge').toBeLessThan(DESKTOP.width / 4);
  });
});

/**
 * Dismisses the drawer by tapping the backdrop's **right edge**, not its centre
 * and not with a forced click.
 *
 * The backdrop covers the whole viewport — it has to, or the dim ends in a hard
 * line at the panel's edge as the panel slides out — so its centre is genuinely
 * underneath the panel, and a click aimed there is correctly refused as
 * intercepted. Aiming at the right edge is a real click at a point that really
 * is exposed; forcing would have suppressed the check instead of the overlap,
 * on the one element whose entire job is to be tappable.
 */
async function tapBackdropRightEdge(page: Page): Promise<void> {
  const backdrop = page.getByTestId('nav-menu-backdrop');
  const box = (await backdrop.boundingBox())!;
  await backdrop.click({ position: { x: box.width - 2, y: box.height / 2 } });
}
