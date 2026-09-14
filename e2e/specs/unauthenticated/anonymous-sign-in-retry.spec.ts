import { expect, test } from '../../fixtures/test';
import { waitForAnonymousSession } from '../../support/auth';

/**
 * The visitor whose first anonymous sign-in does not come back.
 *
 * `App` asks for a session once, on the first idle moment after paint, and
 * `ensureSignedIn()` swallows whatever comes back so that a player with no
 * network still gets a game (`app.md` §1.5). What used to follow from that is
 * that a single dropped, refused or over-long round trip left the tab with no
 * uid for the rest of its life — every game unsaveable, and nothing said so
 * until the player tried to save a score. The preview suite is where it
 * surfaced, because against the emulator that round trip is a millisecond and
 * never fails on its own.
 *
 * So this spec does not wait for a bad day: it **makes** the first
 * `accounts:signUp` fail and then asserts the session arrives anyway. That
 * puts the coverage on the emulator, where the failure is deterministic and
 * costs nothing, rather than on a real project where it was only ever
 * observable by luck.
 *
 * **`page.route` is load-bearing here and would not work everywhere.** With a
 * service worker registered, the worker re-issues what the page asked for and
 * the interception never sees it (`CLAUDE.md` §4.6). Nothing registers one
 * under `ng serve --configuration=e2e` — no `ngsw-worker.js` is even emitted —
 * so the abort really reaches the request. That is also why this file is
 * excluded from the preview slice by name in `playwright.preview.config.ts`.
 */

/** The Auth REST call that mints an anonymous account, emulator or not. */
const ANONYMOUS_SIGN_UP = /accounts:signUp/;

test.describe('a first anonymous sign-in that fails', () => {
  test('is retried, and the session arrives anyway', async ({ page }) => {
    let attempts = 0;
    await page.route(ANONYMOUS_SIGN_UP, (route) => {
      attempts += 1;
      // The first one only: a stub that refused everything would prove the
      // app keeps asking, not that it recovers.
      return attempts === 1 ? route.abort('failed') : route.fallback();
    });

    await page.goto('/');

    // The wait is the app's own two signals, budgeted for every deadline it
    // has (`e2e/support/auth.ts`) — which comfortably contains the retry
    // schedule's first step.
    await waitForAnonymousSession(page);

    // Counted rather than inferred: a route that silently stopped matching
    // would leave the assertion above passing against a first attempt that
    // was never interfered with, which is a test of nothing
    // (`ci-cd.md` §4.3).
    expect(attempts, 'sign-up attempts, the first of them refused').toBeGreaterThanOrEqual(2);
  });

  test('is the only thing retried — a session in hand ends the schedule', async ({ page }) => {
    let attempts = 0;
    await page.route(ANONYMOUS_SIGN_UP, (route) => {
      attempts += 1;
      return route.fallback();
    });

    await page.goto('/');
    await waitForAnonymousSession(page);

    // Three real seconds, because the claim is that something does **not**
    // happen and there is no event to wait on instead (`CLAUDE.md` §4.6) —
    // and because the first retry would be due two seconds after a failure,
    // so a window shorter than that could not tell a working app from one
    // that retries a success.
    await page.waitForTimeout(3_000);

    expect(attempts, 'one account, minted once').toBe(1);
  });
});
