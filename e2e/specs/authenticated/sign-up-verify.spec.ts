import { expect, test } from '../../fixtures/test';
import { authMenu, openAuthMenu, signInViaUi, signUpViaUi } from '../../support/auth';

test.describe('email sign-up and verification', () => {
  const password = 'correct horse battery staple';

  /**
   * Unique per test, not per file: workers share one emulator and there is no
   * `resetBackend()` between tests, so a fixed address would collide with the
   * account another worker (or this test's own previous run) already created.
   */
  const uniqueEmail = () =>
    `signup-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  test('requires verifying the email before treating the account as fully authenticated', async ({
    page,
    request,
    firebase,
  }) => {
    const email = uniqueEmail();
    await page.goto('/');
    await signUpViaUi(page, email, password);

    // Signed in (uid upgraded from anonymous), but not yet verified.
    //
    // `toContainText` on the panel rather than a locator per message: each of
    // these is rendered twice, once in the panel's permanent `role="status"`
    // region and once in the visible banner, so a locator would match two
    // elements and fail strict mode for a reason that has nothing to do with
    // the app.
    const panel = authMenu(page);
    await expect(panel).toContainText(
      "Account created! We've sent a verification link to your email.",
    );
    await expect(panel).toContainText('Verify your email');
    await expect(
      panel.getByRole('button', { name: 'Resend verification email', exact: true }),
    ).toBeVisible();

    // The Auth emulator's out-of-band link, followed from Node rather than by
    // navigating the page: opening it in the tab would tear down the session
    // this test is about, and the link is a plain HTTP endpoint with nothing to
    // render.
    const link = await firebase.getVerificationLink(email);
    expect((await request.get(link)).ok(), 'the verification link was accepted').toBe(true);

    // Sign out and back in to pick up the now-verified account from the server.
    await panel.getByRole('button', { name: 'Sign out', exact: true }).click();
    // `signOut()` only closes the dropdown after its async re-anonymous-sign-in
    // resolves (AuthService.signOut -> ensureSignedIn) — without waiting for
    // that here, `signInViaUi`'s own `openAuthMenu()` can race it and click the
    // trigger button while the still-open dropdown is rendering behind it.
    await expect(panel).toHaveCount(0);
    await signInViaUi(page, email, password);

    // The chip carries the account rather than the sign-in affordance now.
    // Asserted on its text through its `data-cy` rather than by looking for a
    // button named "Sign in": the chip is always in the document and only its
    // contents change (`CLAUDE.md` §4.6).
    await expect(page.getByTestId('auth-menu-trigger')).not.toContainText('Sign in');
    await openAuthMenu(page);
    await expect(authMenu(page)).toContainText('Your profile');
    await expect(authMenu(page)).toContainText('Verified');
  });

  test('rejects email-alias sign-ups client-side', async ({ page }) => {
    await page.goto('/');
    await openAuthMenu(page);
    const panel = authMenu(page);
    await panel.getByPlaceholder('Email', { exact: true }).fill('someone+tag@example.com');
    await panel.getByPlaceholder('Password', { exact: true }).fill(password);
    await panel.getByRole('button', { name: 'Sign up', exact: true }).click();

    await expect(panel).toContainText(/email aliases.*aren't allowed/i);
  });
});
