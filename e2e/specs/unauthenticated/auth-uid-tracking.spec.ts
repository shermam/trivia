import { expect, test } from '../../fixtures/test';
import { waitForAnonymousSession } from '../../support/auth';

/**
 * Finding C6. The preview target deletes the Auth accounts its tests create in
 * the **real** project. Finding them by reading the app's persisted uid once
 * per test is a sample, which only ever sees the uid a test happens to end
 * with. Every uid replaced along the way is left behind, and they accumulate:
 * 822 of the project's 829 Auth accounts were anonymous when this was
 * measured.
 *
 * This runs against the **emulator**, where there is nothing to clean up, for
 * one reason: it is the only place the mechanism can be exercised locally.
 * The preview suite runs solely in CI against a live project, so a fix verified
 * only there is a fix verified only by merging it — which is how C6 came to
 * exist in the first place. What is under test here is the tracker, not the
 * cleanup: a real browser, a real Firebase Auth, real `localStorage` writes.
 *
 * The tracker itself is an automatic fixture (`e2e/fixtures/test.ts`), so each
 * test starts from an empty buffer by construction rather than by draining one
 * in a hook — a test-scoped fixture is built fresh for every test.
 *
 * Every test here waits on `waitForAnonymousSession` before reading the
 * tracker, because a page renders long before the deferred bootstrap has
 * signed in: asserting straight after a navigation reads an empty buffer and
 * fails for a reason that has nothing to do with tracking.
 */

test.describe('auth uid tracking (C6)', () => {
  test('captures the ambient anonymous uid a plain visit creates', async ({ page, authUids }) => {
    await page.goto('/');
    await waitForAnonymousSession(page);

    expect(authUids.uids().length, 'uid from the first visit').toBeGreaterThanOrEqual(1);
  });

  // The regression test. Sampling at the end of a test sees only the *last*
  // uid; a session replaced mid-test — which is what a sign-out does, since it
  // mints a fresh anonymous account — was invisible and never deleted.
  test('captures a uid that is replaced mid-test, not just the final one', async ({
    page,
    authUids,
  }) => {
    await page.goto('/');
    await waitForAnonymousSession(page);

    const firstSession = authUids.uids();
    expect(firstSession.length, 'first session').toBeGreaterThanOrEqual(1);
    const firstUid = firstSession[firstSession.length - 1];

    // Drop the persisted session and reload: the app signs in anonymously
    // again and gets a different uid, exactly as a sign-out does.
    await page.evaluate(() => window.localStorage.clear());
    await page.goto('/');
    await waitForAnonymousSession(page);

    const uids = authUids.uids();
    expect(uids.length, 'both sessions are known').toBeGreaterThanOrEqual(2);
    expect(uids, 'the replaced uid was not forgotten').toContain(firstUid);
    expect(new Set(uids).size, 'the two sessions are distinct accounts').toBeGreaterThanOrEqual(2);
  });

  test('hands each uid to the cleanup exactly once', async ({ page, authUids, firebase }) => {
    await page.goto('/');
    await waitForAnonymousSession(page);

    const first = authUids.take();
    expect(first.length).toBeGreaterThanOrEqual(1);
    // Draining is what stops the sweep re-reporting the same uid on every
    // subsequent test.
    expect(authUids.take(), 'buffer is drained').toEqual([]);

    // Put back what the drain removed. The fixture's own teardown hands the
    // buffer to the sweep, and this test has just emptied it — against the
    // real preview project that would be an account created and then knowingly
    // left behind, which is the exact defect C6 is about.
    firebase.trackAuthUids(first);
  });
});
