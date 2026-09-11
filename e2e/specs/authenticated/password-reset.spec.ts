import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { authMenu, openAuthMenu } from '../../support/auth';
import { stubOpenTrivia } from '../../support/open-trivia';

/**
 * Finding H1. An email/password user who forgot their password was locked out
 * permanently — of a paid subscription, if they had one — because the sign-in
 * form offered no reset at all.
 *
 * The second test is as important as the first: the confirmation message must
 * be *identical* whether or not the address has an account. A reset form that
 * answers differently for known and unknown addresses is an account-enumeration
 * oracle. The Admin-SDK read checks what actually reached Auth, so the two tests
 * together pin "same words outside, different actions inside".
 */
const NEUTRAL_CONFIRMATION = 'If an account exists for that email';

async function requestReset(page: Page, email: string): Promise<void> {
  await openAuthMenu(page);
  const panel = authMenu(page);
  await panel
    .getByRole('button', { name: 'Already have an account? Sign in', exact: true })
    .click();
  await panel.getByPlaceholder('Email', { exact: true }).fill(email);
  await panel.getByRole('button', { name: 'Forgot password?', exact: true }).click();
}

/**
 * The confirmation is rendered twice — once in the panel's permanent
 * `role="status"` region and once in the visible banner — so this asserts on
 * the panel containing it rather than on an element being it, which would be
 * two matches and a strict-mode failure.
 */
async function expectNeutralConfirmation(page: Page): Promise<void> {
  await expect(authMenu(page)).toContainText(NEUTRAL_CONFIRMATION);
}

test.describe('password reset (H1)', () => {
  test.beforeEach(async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');
  });

  test('sends a reset for an existing account, saying so neutrally', async ({ page, firebase }) => {
    const email = `reset-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    await firebase.createVerifiedUser({ email, password: 'correct horse battery staple' });

    await requestReset(page, email);

    await expectNeutralConfirmation(page);
    expect(await firebase.hasPendingPasswordReset(email)).toBe(true);
  });

  test('says exactly the same thing for an unknown address, and sends nothing', async ({
    page,
    firebase,
  }) => {
    const email = `nobody-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

    await requestReset(page, email);

    await expectNeutralConfirmation(page);
    expect(await firebase.hasPendingPasswordReset(email)).toBe(false);
  });
});
