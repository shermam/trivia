import { expect, test } from '../../fixtures/test';
import { assertRadiosAreGrouped } from '../../support/a11y-assertions';
import { signInViaUi } from '../../support/auth';

test.describe('add-question Pro gating', () => {
  const password = 'correct horse battery staple';

  /**
   * Unique per test, not per file: workers share one emulator and there is no
   * `resetBackend()` between tests, so a fixed address would collide with the
   * account another worker (or this test's own previous run) already created.
   */
  const uniqueEmail = () =>
    `pro-gating-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  test('shows a free account a friendly upgrade prompt instead of the form', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    await firebase.createVerifiedUser({ email, password });
    await page.goto('/');
    await signInViaUi(page, email, password);
    await page.goto('/add-question');

    await expect(page.getByText("This one's for Pro members")).toBeVisible();
    await page.getByRole('button', { name: 'Upgrade to Pro', exact: true }).click();
    await expect(page).toHaveURL(/\/pricing$/);
  });

  test('lets a Pro account submit a question once subscribed', async ({ page, firebase }) => {
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({ email, password });
    await page.goto('/');
    await signInViaUi(page, email, password);

    // Stripe sends a real subscriber back to
    // `${origin}/pricing?checkout=success` (functions/src/checkout-sessions.ts),
    // so that is the page a new subscription first becomes visible on — and
    // this test goes there rather than staying put.
    //
    // It used to stay put *on purpose*: `SubscriptionService` held an
    // `onSnapshot` listener that saw the webhook's write whenever it landed,
    // wherever the user happened to be. That listener was one of the two things
    // keeping the 559 kB Firestore SDK in the bundle and is gone (`BACKLOG.md`
    // item 2). What replaces it is a read when the signed-in user changes, plus
    // a bounded poll on this exact page.
    await page.goto('/pricing?checkout=success');

    // Seeded *after* landing, so the subscription document arrives while the
    // page is already open. That is the race `awaitProActivation` exists for —
    // Stripe's redirect and our own `stripeWebhook` delivery run concurrently
    // and the redirect usually wins. Seeding before the visit would be answered
    // by the plain read-on-load and would never exercise the poll.
    await firebase.setProSubscription({ uid });

    // Fails unless the poll actually picks the subscription up: nothing else on
    // this page will notice it.
    await expect(page.getByText("You're subscribed")).toBeVisible();

    await page.goto('/add-question');
    await expect(page).toHaveURL(/\/add-question$/);

    // This screen carries the other two segmented pickers (Question Type and,
    // once a boolean question is chosen, Correct Answer), and it is only
    // reachable as Pro — so G4's sweep runs here rather than in the
    // unauthenticated spec.
    await assertRadiosAreGrouped(page);

    // Each of these retries until the Pro-gated form actually renders — i.e.
    // until the subscription read and the forced token refresh have landed, not
    // just until the doc write resolved.
    await page.locator('#category').fill('Science');
    await page.locator('#question').fill('What planet is known as the Red Planet?');
    await page.locator('#correctAnswer').fill('Mars');
    await page.getByPlaceholder('Incorrect answer 1', { exact: true }).fill('Venus');
    await page.getByPlaceholder('Incorrect answer 2', { exact: true }).fill('Jupiter');
    await page.getByPlaceholder('Incorrect answer 3', { exact: true }).fill('Saturn');
    await page.getByRole('button', { name: 'Add Question', exact: true }).click();

    // Not "added to the bank" any more (item 4c): a submission is stored and
    // queued for review, and the copy has to say so or the app is promising
    // something the rules refuse to do.
    await expect(
      page.getByText('Thanks! Your question has been submitted for review.'),
    ).toBeVisible();
    await expect(page.getByText('once a reviewer has approved it')).toBeVisible();
  });
});
