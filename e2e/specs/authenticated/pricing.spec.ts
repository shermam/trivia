import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { expectRadiosAreGrouped } from '../../support/a11y';
import { authMenu, signInViaUi } from '../../support/auth';
import { optionLabel } from '../../support/game';
import { expectSameHeight, settledHeight } from '../../support/layout';

/**
 * Both halves of the catalog read: the `products` query, which runs against
 * the documents root, and the `prices` query under whichever product it found.
 *
 * Not anchored at the end, because the client appends its API key as a query
 * parameter.
 */
const CATALOG_QUERY = /\/documents(\/products\/[^/:]+)?:runQuery/;

/**
 * The viewport these measurements are taken at, and the width is the part that
 * matters. Above `sm` the two plans share a grid row with `items-stretch`, so
 * the shorter card is stretched to the taller one's height and a change inside
 * it moves nothing — a guard written there could pass while the card grew.
 * Below `sm` each card is its own row and its box is its own content, which is
 * the only place this can be measured honestly. The height is generous for the
 * reason `CLAUDE.md` §4.4 gives: a cramped viewport pins a layout and hides
 * the very shift the test is looking for.
 */
const MEASURING_VIEWPORT = { width: 390, height: 1000 };

/**
 * Holds the catalog read open, so the page's loading state can be measured
 * rather than raced.
 *
 * The response is fetched immediately and only its *delivery* is held, so the
 * released page is one round trip from rendering a price rather than starting
 * one. The count is returned because the intercept is load-bearing: an
 * intercept that silently stopped matching would leave the test measuring the
 * loaded state twice and passing by luck (`CLAUDE.md` §4.6).
 */
async function holdCatalogRead(page: Page) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = { queries: 0 };

  await page.route(CATALOG_QUERY, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    held.queries += 1;
    await released;
    await route.fulfill({ response });
  });

  return { release: () => release(), held };
}

/**
 * **Serial, and the `products` catalog is why.** Workers share one emulator
 * and `products` is a single global collection, so the currency tests below —
 * which seed a second price and then take it away again — decide what every
 * other test in this file sees while they are running. Nothing outside this
 * file reads the catalog's currencies, so the exclusivity only has to hold
 * here.
 */
test.describe.configure({ mode: 'serial' });

test.describe('pricing / Stripe checkout', () => {
  const password = 'correct horse battery staple';

  /**
   * Unique per test, not per file: workers share one emulator and there is no
   * `resetBackend()` between tests, so a fixed address would collide with the
   * account another worker (or this test's own previous run) already created.
   */
  const uniqueEmail = () =>
    `pricing-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  test.beforeEach(async ({ firebase }) => {
    await firebase.seedProProduct();
  });

  test('prompts an anonymous visitor to sign in instead of starting checkout', async ({ page }) => {
    await page.goto('/pricing');
    await page.getByRole('button', { name: 'Sign in to subscribe', exact: true }).click();

    await expect(authMenu(page)).toBeVisible();
  });

  // The amount is read from the mirrored catalog, not written into the
  // template — `seedProProduct` seeds 99 cents of USD, and this is what proves
  // the page renders *that* rather than a literal that happens to agree.
  test('quotes the catalog’s own price, with no currency choice to make', async ({ page }) => {
    await page.goto('/pricing');

    await expect(page.getByTestId('pro-price')).toHaveText('$0.99');
    await expect(page.getByTestId('pro-currency')).toHaveText('USD');
    await expect(page.getByTestId('currency-choice')).toHaveCount(0);
  });

  /**
   * The Pro card is exactly as tall before the catalog answers as after
   * (`CLAUDE.md` §4.4).
   *
   * Two rows on this card are filled by a network read: the amount, and the
   * currency cell beside it. Both are rendered from first paint — a dash and a
   * non-breaking space — so that what arrives fills a box rather than creating
   * one. The failure this stops is the Subscribe button sliding down under a
   * reader who is already reaching for it, at the one moment they are looking
   * at the price rather than at the button.
   *
   * Nothing automated sees this without a real layout: jsdom has no boxes, and
   * Lighthouse only ever loads `/`.
   */
  test('does not resize the Pro card when the catalog lands', async ({ page }) => {
    await page.setViewportSize(MEASURING_VIEWPORT);
    const catalog = await holdCatalogRead(page);

    await page.goto('/pricing');

    // Measured in the loading state, which lasts exactly as long as this test
    // needs it to.
    const card = page.getByTestId('pro-card');
    await expect(page.getByTestId('pro-price')).toHaveText('—');
    const whileLoading = await settledHeight(card, 'the Pro card while the catalog loads');

    catalog.release();
    await expect(page.getByTestId('pro-price')).toHaveText('$0.99');

    expect(catalog.held.queries, 'catalog queries held open by the intercept').toBeGreaterThan(0);
    await expectSameHeight(card, whileLoading, 'the Pro card when the price arrives');
  });

  test('creates a real checkout session via the emulated Cloud Function and redirects to Stripe', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    await firebase.createVerifiedUser({ email, password });
    await page.goto('/');
    await signInViaUi(page, email, password);
    await page.goto('/pricing');

    // `createCheckoutSession` (functions/src/checkout-sessions.ts) runs for
    // real here, against the Functions emulator — it's only the Stripe API
    // call inside it that's mocked (STRIPE_MOCK_CHECKOUT, see
    // .env.demo-trivia-app-e2e), so this exercises the full write → trigger
    // → write-back → listener → `window.location.assign` round trip for
    // real, all the way through. Nothing is stubbed: Location.assign/href
    // are non-configurable/read-only in a real browser, so rather than fight
    // that, the mock URL itself (see checkout-sessions.ts) is a same-origin,
    // hash-only target — a harmless in-page navigation.
    //
    // Addressing the button by its full label also doubles as a wait for
    // PricingComponent's own `authReady()` gate: the same button reads
    // "Loading…" until then, so this locator cannot resolve early. Without
    // that, a click landing in the brief pre-auth window would misfire the
    // "verify your email" branch, since `isAnonymous`/`isFullyAuthenticated`
    // both default to `false` before the first auth state resolves. It now
    // waits on the catalog read as well, for the same reason: the label says
    // "Subscribe" alone until the price has landed.
    await page.getByRole('button', { name: 'Subscribe — $0.99/mo', exact: true }).click();

    // Anchored at the start of the **hash**, not matched loosely anywhere in
    // the URL: the claim is that the app navigated to the mock checkout target
    // and nothing else, and an unanchored match over the whole URL would also
    // be satisfied by that string turning up in a path or a query parameter.
    await expect
      .poll(() => new URL(page.url()).hash, { message: 'the mock checkout redirect target' })
      .toMatch(/^#mock-checkout-session-/);
  });

  test('shows the Pro badge once subscribed and hides the Subscribe button', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({ email, password });
    await page.goto('/');
    await signInViaUi(page, email, password);
    await firebase.setProSubscription({ uid });

    await page.goto('/pricing');
    await expect(page.getByText("You're subscribed")).toBeVisible();
    await expect(page.getByRole('button', { name: /Subscribe/ })).toHaveCount(0);
  });
});

/**
 * Selling Pro in more than one currency.
 *
 * The reason this is not cosmetic: this Stripe account is registered in
 * Brazil, a Brazilian-issued card can only be charged in BRL, and Adaptive
 * Pricing does not help because it localises prices only for buyers *outside*
 * the merchant's own country. So a Brazilian buyer offered the USD price does
 * not see an odd number — they see a declined card. What has to be true is
 * that the choice reaches the **price ID** the session document carries, and
 * that is invisible from the screen (the mock redirect is the same either
 * way), so it is asserted against the document itself.
 */
test.describe('pricing / choosing a currency', () => {
  const password = 'correct horse battery staple';
  const BRL_PRICE_ID = 'price_test_pro_brl';

  const uniqueEmail = () =>
    `currency-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  test.beforeEach(async ({ firebase }) => {
    await firebase.seedProProduct();
    await firebase.seedProPrice({ id: BRL_PRICE_ID, currency: 'brl', unitAmount: 590 });
  });

  // The catalog is global to the emulator, so leaving the second price behind
  // would hand every later test a currency control it does not expect.
  test.afterEach(async ({ firebase }) => {
    await firebase.removeProPrice(BRL_PRICE_ID);
  });

  test('offers the currencies the catalog carries, and re-quotes on the one chosen', async ({
    page,
  }) => {
    await page.goto('/pricing');

    // An en-US browser (Playwright's default) opens on the dollar price.
    await expect(page.getByTestId('pro-price')).toHaveText('$0.99');
    await expect(page.getByTestId('currency-choice')).toBeVisible();

    // Same radiogroup contract as the setup screen's pickers (finding G4) —
    // swept generically, so a third currency would be covered too.
    await expectRadiosAreGrouped(page);

    // The radio is `sr-only`; the label is the real gesture. See `optionLabel`.
    await optionLabel(page, page.getByTestId('currency-brl')).click();

    await expect(page.getByTestId('currency-brl')).toBeChecked();
    await expect(page.getByTestId('pro-price')).toHaveText(/^R\$\s5,90$/);
  });

  test('checks out against the price of the currency the reader picked', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({ email, password });
    await page.goto('/');
    await signInViaUi(page, email, password);
    await page.goto('/pricing');

    await optionLabel(page, page.getByTestId('currency-brl')).click();
    await page.getByRole('button', { name: /^Subscribe — R\$\s5,90\/mo$/ }).click();

    await expect
      .poll(() => new URL(page.url()).hash, { message: 'the mock checkout redirect target' })
      .toMatch(/^#mock-checkout-session-/);

    // The whole feature, asserted where it is actually decided. The screen
    // cannot show which price was sent, so the session document is read back
    // through the Admin SDK.
    await expect
      .poll(async () => (await firebase.getCheckoutSessions(uid)).map((s) => s.price), {
        message: 'the price ID the checkout session carries',
      })
      .toEqual([BRL_PRICE_ID]);
  });

  /**
   * The same height guarantee as the single-currency card, across the two
   * state changes only a second currency can produce (`CLAUDE.md` §4.4).
   *
   * The currency cell is the interesting one: while the catalog is loading it
   * is a plain pill, and a second currency turns it into a two-option
   * radiogroup. Those are different elements, so their heights agree only
   * because they are built from the same box with the same padding around the
   * same fixed-size cells — a property that holds by construction today and is
   * one class edit away from not holding at all.
   *
   * Switching currency is measured too, because the amounts are not the same
   * width and `R$ 5,90` is a longer string than `$0.99`: the row must absorb
   * that without wrapping, and a wrap here is a line the whole card grows by.
   */
  test('keeps the Pro card the same height as the currency control arrives and changes', async ({
    page,
  }) => {
    await page.setViewportSize(MEASURING_VIEWPORT);
    const catalog = await holdCatalogRead(page);

    await page.goto('/pricing');

    const card = page.getByTestId('pro-card');
    await expect(page.getByTestId('pro-price')).toHaveText('—');
    const whileLoading = await settledHeight(card, 'the Pro card while the catalog loads');

    catalog.release();
    await expect(page.getByTestId('currency-choice')).toBeVisible();
    await expect(page.getByTestId('pro-price')).toHaveText('$0.99');

    expect(catalog.held.queries, 'catalog queries held open by the intercept').toBeGreaterThan(0);
    await expectSameHeight(card, whileLoading, 'the Pro card when the currency control arrives');

    await optionLabel(page, page.getByTestId('currency-brl')).click();
    await expect(page.getByTestId('pro-price')).toHaveText(/^R\$\s5,90$/);
    await expectSameHeight(card, whileLoading, 'the Pro card quoted in BRL');

    await optionLabel(page, page.getByTestId('currency-usd')).click();
    await expect(page.getByTestId('pro-price')).toHaveText('$0.99');
    await expectSameHeight(card, whileLoading, 'the Pro card quoted back in USD');
  });

  /**
   * A Brazilian browser gets the Brazilian price without touching anything —
   * which is the point, since the reader who most needs BRL is the one least
   * likely to go looking for a currency control.
   *
   * `test.use({ locale })` sets the context's `navigator.language(s)`, which
   * is exactly the signal `defaultProCurrency` reads.
   */
  test.describe('a Brazilian browser', () => {
    test.use({ locale: 'pt-BR' });

    test('opens on the Brazilian price', async ({ page }) => {
      await page.goto('/pricing');

      await expect(page.getByTestId('currency-brl')).toBeChecked();
      await expect(page.getByTestId('pro-price')).toHaveText(/^R\$\s5,90$/);
    });
  });
});
