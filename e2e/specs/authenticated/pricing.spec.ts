import { expect, test } from '../../fixtures/test';
import { authMenu, signInViaUi } from '../../support/auth';

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
    // both default to `false` before the first auth state resolves.
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
