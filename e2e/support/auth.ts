import { expect, Locator, Page } from '@playwright/test';

/**
 * How long a visit may take to persist an anonymous Firebase session.
 *
 * **Derived from the application's own deadlines rather than guessed from a
 * runner.** Nothing on `/` awaits auth, so the session arrives at the end of a
 * chain the app schedules late on purpose (`app.md` §1.5): `App`'s constructor
 * defers `ensureSignedIn()` to `afterNextRender` and then to an idle callback
 * bounded at **2s**; `AuthService.getAuth()` dynamically imports
 * `firebase/auth` (129 kB raw, plus the 31 kB shared chunk under it) and
 * `FirebaseAppService` fetches `/__/firebase/init.json`, which it aborts after
 * **10s**; and `signInAnonymously()` is then a round trip `AuthService` gives
 * up on after **10s**. That is 22s of the app's own bounds plus two chunk
 * fetches before anything has gone wrong — so the 20s `expect` timeout in
 * `playwright.config.ts` is shorter than the window the application itself
 * allows, which is why waiting on this under the default failed against real
 * Firebase Auth and never once against the emulator, where the round trip is a
 * millisecond.
 *
 * 60s covers those bounds with room for the fetches, and still fails in
 * bounded time when the session genuinely never lands: `ensureSignedIn()`
 * catches its own timeout and nothing on `/` calls it again, so a backend that
 * does not answer leaves no session for any deadline to find.
 */
const ANONYMOUS_SESSION_TIMEOUT_MS = 60_000;

/**
 * Waits until this visit has signed in anonymously and persisted the session.
 *
 * **Observes the bootstrap rather than triggering it**, because the ambient
 * session is the subject: every page load mints one with no gesture, that is
 * what the preview sweep has to clean up (`ci-cd.md` §4.3), and it is what
 * `test-isolation.spec.ts` asserts is not shared between tests. Opening the
 * auth menu would start the same bootstrap (`AuthMenuStateService`) and prove
 * something weaker — that a gesture signs in.
 *
 * Two waits rather than one, because they fail for different reasons and a
 * single poll on the stored record cannot say which happened. `aria-busy` on
 * the account chip is `!authService.authReady()` (`top-bar.component.html`),
 * so it clearing is the app's own signal that the deferred import, the
 * runtime-config fetch and the first `onAuthStateChanged` have all happened;
 * what remains after that is the `signInAnonymously()` round trip, and the
 * only thing that marks *that* is the `firebase:authUser:*` record
 * `browserLocalPersistence` writes — the same channel `auth-uid-tracker.ts`
 * listens on.
 *
 * The chip is anchored with a visibility check first: `not.toHaveAttribute` is
 * satisfied by an element that is not there at all, so on its own it would
 * pass against a page that has not rendered yet (`ci-cd.md` §4.3).
 */
export async function waitForAnonymousSession(page: Page): Promise<void> {
  // One budget across both waits rather than one each, so a failure is
  // reported by the wait that ran out of it instead of by the 120s test
  // timeout swallowing them both. Floored rather than allowed to reach zero,
  // because Playwright reads `timeout: 0` as *no* timeout — an exhausted
  // budget would hang the test instead of failing it.
  const deadline = Date.now() + ANONYMOUS_SESSION_TIMEOUT_MS;
  const remaining = () => Math.max(1_000, deadline - Date.now());

  const chip = page.getByTestId('auth-menu-trigger');
  await expect(chip, 'the top bar is rendered').toBeVisible({ timeout: remaining() });
  await expect(chip, 'the deferred auth bootstrap has delivered a first state').not.toHaveAttribute(
    'aria-busy',
    'true',
    { timeout: remaining() },
  );

  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Object.keys(window.localStorage).some((key) => key.startsWith('firebase:authUser:')),
        ),
      { message: 'Firebase has persisted an anonymous session', timeout: remaining() },
    )
    .toBe(true);
}

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
