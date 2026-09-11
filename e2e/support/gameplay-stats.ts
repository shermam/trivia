import { expect } from '@playwright/test';
import { FirebaseBackend } from '../fixtures/firebase-backend';

/**
 * Waits for `users/{uid}` to appear, then returns it.
 *
 * **`recordGameResult` is fire-and-forget by design** — `/game-over` renders
 * from local state and must not wait on a cold start — so there is nothing in
 * the DOM that changes when the write lands, and no locator to hang an
 * assertion off. The write also races a cold path on its first use in a run: a
 * dynamic `firebase/functions` import plus the runtime-config fetch behind
 * `getApp()`, and then the callable itself.
 *
 * An Admin-SDK read is a plain `await`, not a retrying query, so an assertion
 * written against one reads the database exactly once — a race by construction,
 * and the same shape as the leaderboard skeleton flake (`ci-cd.md` §4.3). The
 * fix is to remove the transience rather than to retry an assertion that cannot
 * retry: `expect.poll` re-runs the *read*, which is the thing that has to
 * happen again.
 */
export async function waitForGameplayStats(
  firebase: FirebaseBackend,
  uid: string,
): Promise<Record<string, unknown>> {
  await expect
    .poll(async () => (await firebase.inspectAccountState({ uid })).gameplayStats !== null, {
      message:
        `users/${uid} never appeared. recordGameResult is fire-and-forget, so either it was ` +
        'never called, it was refused (anonymous or unsupported provider), or it failed.',
    })
    .toBe(true);

  return (await firebase.inspectAccountState({ uid })).gameplayStats!;
}
