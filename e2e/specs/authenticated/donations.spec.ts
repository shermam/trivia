import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { expectRadiosAreGrouped } from '../../support/a11y';
import { signInViaUi } from '../../support/auth';
import { optionLabel, startGame } from '../../support/game';

/**
 * FEAT-013 — the one-time donation path, end to end against the emulated
 * `createDonationSession`. Only the Stripe API call inside it is mocked
 * (`STRIPE_MOCK_CHECKOUT`, see `.env.demo-trivia-app-e2e`), so this exercises
 * the real write → trigger → catalog validation → write-back → redirect round
 * trip, exactly as `pricing.spec.ts` does for Pro.
 *
 * **In `authenticated/` although most of it runs signed out.** The directory
 * decides whether a spec reaches the real preview project, and this one seeds
 * a donation product into the shared, publicly-readable `products` collection
 * — which is fine against an emulator that is thrown away and is not fine
 * against a real project (`playwright.preview.config.ts` explains the
 * asymmetry).
 *
 * **Serial, and the catalog is why.** `products` is one global collection, so
 * a test that takes a currency away decides what every other test in this file
 * sees while it runs.
 */
test.describe.configure({ mode: 'serial' });

/**
 * The dialog can be reached from two places, and both are covered — but the
 * footer's CTA is the one a reader actually uses, so it is the default route
 * in.
 */
async function openDonationDialog(page: Page): Promise<void> {
  await page.getByTestId('donate-cta').click();
  await expect(page.getByTestId('donation-dialog')).toBeVisible();
}

test.describe('donations', () => {
  const password = 'correct horse battery staple';

  /**
   * Unique per test, not per file: workers share one emulator and there is no
   * `resetBackend()` between tests, so a fixed address would collide with the
   * account another worker (or this test's own previous run) already created.
   */
  const uniqueEmail = () =>
    `donation-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  test.beforeEach(async ({ firebase }) => {
    await firebase.seedDonationProduct();
  });

  test('offers the catalog’s own amounts, cheapest first, in a labelled radiogroup', async ({
    page,
  }) => {
    await page.goto('/');
    await openDonationDialog(page);

    // The amounts are the seeded ones — 200/500/1000 in cents — rendered by
    // `Intl.NumberFormat` rather than written into the template.
    await expect(page.getByTestId('donation-amounts').getByRole('radio')).toHaveCount(3);
    // Sweeps every radio on the page, the dialog's included: a group without an
    // accessible name conveys nothing (finding G4).
    await expectRadiosAreGrouped(page);
    await expect(page.getByTestId('donation-amount-price_test_coffee_small')).toHaveAttribute(
      'value',
      'price_test_coffee_small',
    );
    await expect(
      optionLabel(page, page.getByTestId('donation-amount-price_test_coffee_small')),
    ).toHaveText('$2.00');
    await expect(
      optionLabel(page, page.getByTestId('donation-amount-price_test_coffee_large')),
    ).toHaveText('$10.00');

    // The middle amount is checked, so the group is never rendered with
    // nothing selected.
    await expect(page.getByTestId('donation-amount-price_test_coffee_medium')).toBeChecked();
    await expect(page.getByRole('button', { name: 'Donate $5.00', exact: true })).toBeVisible();
  });

  test('warns a signed-out visitor that the donation cannot be credited', async ({ page }) => {
    await page.goto('/');
    await openDonationDialog(page);

    await expect(page.getByTestId('donation-guest-notice')).toContainText(
      "won't be recorded against an account",
    );
  });

  test('says nothing of the sort to a signed-in reader', async ({ page, firebase }) => {
    const email = uniqueEmail();
    await firebase.createVerifiedUser({ email, password });
    await page.goto('/');
    await signInViaUi(page, email, password);
    await openDonationDialog(page);

    await expect(page.getByTestId('donation-guest-notice')).toHaveCount(0);
  });

  /*
   * The whole round trip, and the assertion that matters is the *price id* in
   * the document the client wrote: the redirect target is the same mock URL
   * whichever amount was chosen, so the screen cannot tell them apart
   * (`CLAUDE.md` §4.6).
   */
  test('creates a real donation session via the emulated Cloud Function and redirects', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({ email, password });
    await page.goto('/');
    await signInViaUi(page, email, password);
    await openDonationDialog(page);

    await optionLabel(page, page.getByTestId('donation-amount-price_test_coffee_large')).click();
    await page.getByRole('button', { name: 'Donate $10.00', exact: true }).click();

    // Anchored at the start of the hash, not matched loosely over the whole
    // URL: the claim is that the app navigated to the mock donation target and
    // nothing else.
    await expect
      .poll(() => new URL(page.url()).hash, { message: 'the mock donation redirect target' })
      .toMatch(/^#mock-donation-session-/);

    const sessions = await firebase.getDonationSessions(uid);
    expect(sessions.map((session) => session.price)).toEqual(['price_test_coffee_large']);
    // The volume cap lives in the document ID (`{window}-{slot}`), and it is
    // counted per subcollection — donations must not spend Pro's ten.
    expect(sessions[0].id).toMatch(/^\d+-\d$/);
    expect(await firebase.getCheckoutSessions(uid)).toHaveLength(0);
  });

  // An anonymous visitor is the common donor — every page load signs one in —
  // and `firestore.rules` allows the write deliberately.
  test('lets a signed-out visitor donate all the same', async ({ page }) => {
    await page.goto('/');
    await openDonationDialog(page);

    await page.getByRole('button', { name: 'Donate $5.00', exact: true }).click();

    await expect
      .poll(() => new URL(page.url()).hash, { message: 'the mock donation redirect target' })
      .toMatch(/^#mock-donation-session-/);
  });

  /*
   * Coming back from Stripe. The mock URL carries the same `?donation=success`
   * a real `success_url` does, so the banner this asserts on is the one a real
   * donor sees.
   */
  test('thanks the donor on the way back, and lets them dismiss it', async ({ page }) => {
    await page.goto('/');
    await openDonationDialog(page);
    await page.getByRole('button', { name: 'Donate $5.00', exact: true }).click();

    await expect(page.getByTestId('donation-success')).toContainText('Thank you');

    await page.getByTestId('dismiss-donation-status').click();

    await expect(page.getByTestId('donation-success')).toHaveCount(0);
    // The query parameter goes with it, so a reload does not thank them twice.
    await expect
      .poll(() => new URL(page.url()).search, { message: 'the query string after dismissing' })
      .toBe('');
  });

  test('says nothing was charged when the donation is cancelled', async ({ page }) => {
    await page.goto('/?donation=cancelled');

    await expect(page.getByTestId('donation-cancelled')).toContainText('nothing was charged');
  });

  test('offers a currency switch once the catalog carries two, and charges the chosen one', async ({
    page,
    firebase,
  }) => {
    await firebase.seedDonationPrice({
      id: 'price_test_coffee_brl_medium',
      currency: 'brl',
      unitAmount: 2500,
    });
    try {
      const email = uniqueEmail();
      const { uid } = await firebase.createVerifiedUser({ email, password });
      await page.goto('/');
      await signInViaUi(page, email, password);
      await openDonationDialog(page);

      // Its own test-id prefix, because the pricing page's switch answers to
      // `currency-*` and both can be on screen at once.
      await expect(page.getByTestId('donation-currency-choice')).toBeVisible();
      await optionLabel(page, page.getByTestId('donation-currency-brl')).click();
      await expect(page.getByTestId('donation-currency-brl')).toBeChecked();

      // One BRL price is seeded, so it is the only amount the row can offer.
      await expect(page.getByTestId('donation-amounts').getByRole('radio')).toHaveCount(1);
      await page.getByTestId('donate').click();

      await expect
        .poll(async () => (await firebase.getDonationSessions(uid))[0]?.price, {
          message: 'the price id the donation session carries',
        })
        .toBe('price_test_coffee_brl_medium');
    } finally {
      // The catalog is global to the emulator: leave it as it was found.
      await firebase.removeDonationPrice('price_test_coffee_brl_medium');
    }
  });

  /*
   * The zero-distraction rule for an active quiz round (`FEAT-013` §1). Both
   * routes in are excluded, because the exclusion is about the screen rather
   * than about which control it is reached from.
   */
  test('offers no way to donate during a quiz round', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('donate-cta')).toBeVisible();

    // Navigates to `/` itself, stubbing Open Trivia on the way.
    await startGame(page);

    await expect(page.getByTestId('donate-cta')).toHaveCount(0);
    await page.getByTestId('auth-menu-trigger').click();
    await expect(page.getByTestId('auth-menu-donate')).toHaveCount(0);
  });

  test('opens the same dialog from the account menu', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('auth-menu-trigger').click();
    await page.getByTestId('auth-menu-donate').click();

    // The menu closes on the way: two `role="dialog"` panels open at once is
    // not a state to leave a screen reader in.
    await expect(page.getByTestId('donation-dialog')).toBeVisible();
    await expect(page.getByTestId('auth-menu-panel')).toHaveCount(0);
  });

  /*
   * The dialog's own accessibility contract (`CLAUDE.md` §4.5), and the half
   * jsdom cannot see: focus moving in, Tab staying in, Escape closing, and
   * focus coming back to the trigger.
   */
  test('traps focus while it is open and returns it to the trigger', async ({ page }) => {
    await page.goto('/');
    await openDonationDialog(page);

    await expect(page.getByTestId('donation-dialog')).toBeFocused();

    // Shift+Tab from the dialog itself must land inside it, not on the page
    // behind — the direction Angular's `keydown.tab` binding never sees.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('donation-dialog').locator(':focus')).toHaveCount(1);

    await page.keyboard.press('Escape');

    await expect(page.getByTestId('donation-dialog')).toHaveCount(0);
    await expect(page.getByTestId('donate-cta')).toBeFocused();
  });

  /*
   * What a deployment looks like before the donation Product has been created
   * in the Stripe Dashboard. The CTA still opens, nothing throws, and the
   * dialog says so — the honest degradation the catalog convention depends on.
   *
   * The catalog is really taken away rather than stubbed at the network, so
   * this exercises the client's own query against an empty `products`
   * collection. It is safe because this file is serial and is the only one
   * that reads the donation product; the `beforeEach` above puts it back.
   */
  test('degrades honestly while the Stripe catalog holds no donation price', async ({
    page,
    firebase,
  }) => {
    await firebase.removeDonationProduct();

    await page.goto('/');
    await openDonationDialog(page);

    await expect(page.getByTestId('donation-unavailable')).toContainText(
      "Donations aren't available right now",
    );
    await expect(page.getByTestId('donate')).toHaveCount(0);
  });
});
