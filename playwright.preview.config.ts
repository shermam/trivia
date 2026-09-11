import { defineConfig } from '@playwright/test';
import { E2EWorkerOptions } from './e2e/fixtures/test';
import baseConfig from './playwright.config';

/**
 * The Playwright suite against a **real deployed Firebase Hosting preview
 * channel** instead of the local emulators — the counterpart of
 * `cypress.preview.config.ts`, driven by the `e2e-preview-playwright` job in
 * `.github/workflows/firebase-preview.yml`.
 *
 * Everything not listed below is inherited from `playwright.config.ts`: the
 * same workers, the same zero retries, the same timeouts, the same Chromium,
 * the same `data-cy` test-id attribute. One set of settings rather than two
 * that can disagree about what the suite is.
 *
 * `docs/ci-cd.md` §4.3 carries the rest — which specs run here, and why each
 * exclusion exists.
 */

/**
 * The deployed channel's URL, from the environment with no default, set by the
 * CI step that has just deployed it. Throwing beats leaving it `undefined`,
 * which Playwright would resolve every relative `goto('/')` against and report
 * as a URL parse error a few minutes into the run.
 */
const previewUrl = process.env['PREVIEW_URL'];
if (!previewUrl) {
  throw new Error(
    'PREVIEW_URL is not set. This config points the suite at a real deployed Hosting channel; ' +
      'there is no local server to fall back to. CI sets it from the deploy job’s output — for ' +
      'a local run, export the channel URL yourself.',
  );
}

export default defineConfig<object, E2EWorkerOptions>({
  ...baseConfig,

  /**
   * **No `webServer`.** The application under test is the deployed channel, and
   * starting a local dev server would quietly give the suite a second app to
   * talk to — one built with the `e2e` configuration and pointed at emulators
   * that are not running.
   */
  webServer: undefined,

  /**
   * The slice that is safe against a real, persistent, publicly-readable
   * project: all of `unauthenticated/` bar the two below, plus the two
   * authenticated specs whose entire footprint is accounts and rows the sweep
   * can delete. It is the scope `cypress.preview.config.ts` runs, spec for
   * spec.
   *
   * **What keeps the rest out is the same question asked three ways**, and it
   * is worth having the answers here rather than deriving them again:
   *
   * - Does it need an emulator-only endpoint? `sign-up-verify` reads a
   *   verification link and `password-reset` a reset code from the Auth
   *   emulator's testing-only `oobCodes` endpoint. Neither has a real-Auth
   *   equivalent short of a live mailbox.
   * - Does it drive a Cloud Function? Functions are not channel-scoped
   *   (`docs/ci-cd.md` §4.2a), so a preview build shares the project's
   *   *already-deployed* ones. `pricing` and `add-question-pro-gating` would
   *   hit the real `createCheckoutSession` — which either reaches real Stripe
   *   or silently no-ops depending on that deployment's own
   *   `STRIPE_MOCK_CHECKOUT` state, neither of which this suite should depend
   *   on — and `account-management` and `lifetime-stats` would call the real
   *   `deleteAccount`, `exportAccountData` and `recordGameResult`.
   * - Can the sweep find everything it writes? `review-queue` submits questions
   *   through the UI, which gives them Firestore auto-ids that reach no list,
   *   and `add-question-pro-gating` does the same.
   */
  testMatch: [
    '**/unauthenticated/**/*.spec.ts',
    // Between them: a verified account, a display name and a leaderboard row,
    // all keyed to uids this run minted and so all reachable by the sweep in
    // `e2e/fixtures/firebase-preview-target.ts`.
    '**/authenticated/sign-in-save-score.spec.ts',
    '**/authenticated/profile.spec.ts',
  ],

  /**
   * Replaces the base config's list, which exists to keep
   * `service-worker-oauth-origins.spec.ts` off the emulator. Here it is the one
   * spec that can actually run: it needs a real `ngsw-worker.js` and the real
   * `firebase.json` headers served with it, and a dev server has neither.
   */
  testIgnore: [
    /*
     * Emulator-only for two reasons. It asserts the written report through an
     * Admin-SDK read of `question_reports`, a collection no client may read by
     * rule — handing the preview suite console-level read access to real
     * users' reports is a bigger grant than a spec the emulator already covers
     * is worth. And its writes would outlive the run: a report is keyed by
     * nothing the sweep tracks, so every preview would leave real rows in the
     * owner's review queue.
     */
    '**/unauthenticated/question-reporting.spec.ts',
    /*
     * Excluded for a reason that has nothing to do with safety: it cannot work
     * here. Two of its tests force the entry script to 404, and `firebase.json`
     * serves hashed JS as `max-age=31536000, immutable` — so against a real
     * channel an earlier spec has already loaded the app and the browser
     * satisfies the script from its own HTTP cache. Nothing reaches the network
     * and the route never matches, which is exactly how the Cypress file failed
     * on its first CI run. That is a property of the deployment rather than
     * something the spec can be written around; the cost is that the preview
     * suite does not check the recovery notice is absent on a healthy boot,
     * which the emulator suite does.
     */
    '**/unauthenticated/boot-fallback.spec.ts',
  ],

  use: {
    ...baseConfig.use,

    baseURL: previewUrl,

    /**
     * Sends the `firebase` fixture at the real project named by
     * `FIREBASE_PREVIEW_PROJECT_ID` — which the target reads itself, refusing
     * to start without it and refusing production outright. The only thing
     * chosen here is *which of the two targets*; which project that target will
     * accept is not this file's to decide.
     */
    firebaseTarget: 'preview',
  },
});
