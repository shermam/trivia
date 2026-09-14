import { defineConfig } from '@playwright/test';
import { E2EWorkerOptions } from './e2e/fixtures/test';
import baseConfig from './playwright.config';

/**
 * The suite against a **real deployed Firebase Hosting preview channel**
 * instead of the local emulators, driven by the `e2e-preview` job (display
 * name `E2E (preview)`) in `.github/workflows/firebase-preview.yml`.
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
   * project: all of `unauthenticated/` bar the five below, plus the two
   * authenticated specs whose entire footprint is accounts and rows the sweep
   * can delete.
   *
   * **The unauthenticated half is opt-out**, and that asymmetry is deliberate
   * but worth knowing before adding a spec: a new file under
   * `unauthenticated/` reaches the real project on the next PR unless
   * `testIgnore` below names it, while a new one under `authenticated/` runs
   * nowhere near it until it is listed here. Opt-out is right for the
   * unauthenticated specs — they visit pages and play games, so the default
   * footprint is the anonymous account every page load mints, which the sweep
   * already tracks — but "the default is safe" is a claim about today's specs,
   * not a property of the glob. A new unauthenticated spec that seeds
   * something, or writes through a path no sweep list covers, has to be
   * excluded here in the same PR.
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
   * - Is its subject a `firestore.rules` bound? Rules are per project and a
   *   preview channel is Hosting only (`docs/ci-cd.md` §4.2a), so a channel
   *   runs whatever rules `main` last deployed. `streak-leaderboard` exists to
   *   prove a score sits inside the multiplier ceiling, so on any PR that moves
   *   that ceiling it would fail here for a reason that is expected — which is
   *   how a real signal becomes a red reviewers learn to ignore.
   *   `sign-in-save-score` covers the save path against the real project
   *   instead, with a score no multiplier touches.
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
   * Replaces the base config's list, which exists to keep the two
   * service-worker specs off the emulator. Here they are the two that can
   * actually run: `service-worker-oauth-origins.spec.ts` needs a real
   * `ngsw-worker.js` and the real `firebase.json` headers served with it, and
   * `service-worker-precache.spec.ts` needs the install a real `ngsw.json`
   * drives. A dev server has none of those.
   */
  testIgnore: [
    /*
     * Emulator-only because its premise is an interception, and an
     * interception is only reliable where no service worker can re-issue what
     * it refuses (`CLAUDE.md` §4.6). Nothing registers one on a deployed
     * channel today either, but that is an accident of `app.config.ts`'s
     * `navigator.webdriver` gate rather than a guarantee — the same reasoning
     * that keeps `offline-play` out below. It would also spend a deliberately
     * refused sign-up plus a retry against the real project's Auth on every
     * PR, to restate a result the emulator settles for nothing.
     */
    '**/unauthenticated/anonymous-sign-in-retry.spec.ts',
    /*
     * Emulator-only for two reasons. It asserts the written report through an
     * Admin-SDK read of `question_reports`, a collection only the appointed
     * reviewers may read — handing the preview suite console-level read access
     * to real users' reports is a bigger grant than a spec the emulator already
     * covers is worth. And its writes would outlive the run: a report is keyed
     * by nothing the sweep tracks, so every preview would leave real rows in
     * the owner's review queue.
     */
    '**/unauthenticated/question-reporting.spec.ts',
    /*
     * Excluded for a reason that has nothing to do with safety: it cannot work
     * here. Two of its tests force the entry script to 404, and `firebase.json`
     * serves hashed JS as `max-age=31536000, immutable` — so against a real
     * channel an earlier spec has already loaded the app and the browser
     * satisfies the script from its own HTTP cache. Nothing reaches the network
     * and the route never matches, which is exactly how this spec failed on
     * its first CI run here. That is a property of the deployment rather than
     * something the spec can be written around; the cost is that the preview
     * suite does not check the recovery notice is absent on a healthy boot,
     * which the emulator suite does.
     */
    '**/unauthenticated/boot-fallback.spec.ts',
    /*
     * Emulator-only because it buys nothing here and costs something. Its
     * subject is device-local IndexedDB — which questions this browser has
     * answered — and the emulator exercises that identically; the query shape
     * and rules it rides on are already covered against the real project by
     * `game-flow.spec.ts`'s custom-source game. Against `trivimind-dev` it
     * would instead put seven approved questions into the shared bank on every
     * PR and spend three full games of real Firestore reads restating a result
     * the emulator already has.
     */
    '**/unauthenticated/question-dedup.spec.ts',
    /*
     * Emulator-only because its premise is "there is no service worker", and
     * on a deployed channel that is true only by accident. The spec cuts the
     * network and expects the app's own Open Trivia request to fail — but
     * `context.setOffline(true)` does not reach a worker's fetches, so with one
     * registered the request is re-issued and succeeds, the offline pool is
     * never reached, and the assertion fails on a banner that had no reason to
     * appear. Nothing registers a worker here today (`app.config.ts` gates it
     * on `!navigator.webdriver`), which makes it pass for a reason no future
     * spec in this directory is obliged to preserve. `ci-cd.md` §4.3 records
     * the split; the precache half of the question is
     * `service-worker-precache.spec.ts`, which belongs here and only here.
     */
    '**/unauthenticated/offline-play.spec.ts',
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
