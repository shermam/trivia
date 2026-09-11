import { expect, Locator, Page } from '@playwright/test';

/**
 * The auth dropdown's panel.
 *
 * Addressed by `data-cy`, never by `[role="dialog"]`: that selector was unique
 * only for as long as the auth menu was the only dialog in the document, and
 * permanently mounting the nav drawer — hidden and `inert`, so no *user* ever
 * sees two — broke it. Note which half broke, because it decides how much a
 * green run proves: a "does not exist" assertion became unsatisfiable and
 * failed loudly, while every "exists" assertion went on passing vacuously
 * against the wrong element (`CLAUDE.md` §4.6).
 */
export function authMenu(page: Page): Locator {
  return page.getByTestId('auth-menu-panel');
}

/** Opens the top-bar auth menu (only valid while it is closed). */
export async function openAuthMenu(page: Page): Promise<void> {
  await page.getByTestId('auth-menu-trigger').click();
}

// Scoped to the panel throughout: the setup screen's own form (and its
// `type=submit` "Start Game" button) is often still in the DOM behind the
// dropdown, so an unscoped submit-button query matches two elements.
async function fillEmailForm(panel: Locator, email: string, password: string): Promise<void> {
  await panel.getByPlaceholder('Email', { exact: true }).fill(email);
  await panel.getByPlaceholder('Password', { exact: true }).fill(password);
}

/**
 * Drives the real sign-in UI, switching the auth menu out of its default
 * sign-up mode first.
 */
export async function signInViaUi(page: Page, email: string, password: string): Promise<void> {
  await openAuthMenu(page);
  const panel = authMenu(page);
  await panel
    .getByRole('button', { name: 'Already have an account? Sign in', exact: true })
    .click();
  await fillEmailForm(panel, email, password);
  await panel.getByRole('button', { name: 'Sign in', exact: true }).click();
  // A successful sign-in closes the menu — wait for that rather than racing
  // the next command against the in-flight sign-in call.
  await expect(panel).toHaveCount(0);
}

/**
 * Drives the real sign-up UI. The auth menu opens in sign-up mode already, so
 * unlike `signInViaUi` there is no mode to switch out of first.
 */
export async function signUpViaUi(page: Page, email: string, password: string): Promise<void> {
  await openAuthMenu(page);
  const panel = authMenu(page);
  await fillEmailForm(panel, email, password);
  await panel.getByRole('button', { name: 'Sign up', exact: true }).click();
  // The menu stays open after sign-up, but the panel it shows next varies —
  // still anonymous on failure, an "awaiting verification" panel with no form
  // at all on success — so "Please wait…" disappearing is the one signal
  // common to every outcome. Wait for that rather than racing the caller's
  // next assertion against the in-flight call.
  await expect(panel).not.toContainText('Please wait');
}

/**
 * Opens the auth menu through game-over's own "Sign in" prompt rather than the
 * top bar, then signs in.
 *
 * That is the gesture a player actually makes at the end of a round, and the
 * opener matters to more than realism: closing the menu returns focus to
 * whatever opened it, and this button is hidden (not removed) by the very
 * sign-in that closes the menu — which is the case
 * `sign-in-save-score.spec.ts` asserts on.
 */
export async function signInFromGameOver(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.getByTestId('open-sign-in').click();
  const panel = authMenu(page);
  await panel
    .getByRole('button', { name: 'Already have an account? Sign in', exact: true })
    .click();
  await fillEmailForm(panel, email, password);
  await panel.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(panel).toHaveCount(0);
}
