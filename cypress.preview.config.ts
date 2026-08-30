import { defineConfig } from 'cypress';
import { registerFirebasePreviewTasks } from './cypress/tasks/firebase-preview-tasks';

/**
 * Runs a safety-scoped slice of the e2e suite against a real deployed
 * Firebase Hosting preview channel (see .github/workflows/firebase-preview.yml)
 * instead of the local Emulator Suite (cypress.config.ts) — `baseUrl` comes
 * from the `PREVIEW_URL` env var, set by the CI step that just deployed the
 * channel.
 *
 * Excludes cypress/e2e/authenticated/sign-up-verify.cy.ts: it reads a
 * verification link off the Auth emulator's testing-only `oobCodes` REST
 * endpoint, which has no real-Auth equivalent (there's no live mailbox to
 * check here) — that spec only runs against the emulator.
 */
export default defineConfig({
  e2e: {
    baseUrl: process.env['PREVIEW_URL'],
    supportFile: 'cypress/support/e2e.preview.ts',
    specPattern: [
      'cypress/e2e/unauthenticated/**/*.cy.ts',
      'cypress/e2e/authenticated/sign-in-save-score.cy.ts',
      'cypress/e2e/authenticated/profile.cy.ts',
    ],
    // `question-reporting.cy.ts` is emulator-only, for the same
    // shared-real-backend reason `pricing.cy.ts` is left out of the list
    // above — and one more. It asserts the written report through
    // `getQuestionReports`, an Admin-SDK read of a collection **no client
    // may read by rule**; the preview task file deliberately doesn't
    // implement it, since handing the preview suite console-level read
    // access to real users' reports is a bigger grant than a spec the
    // emulator already covers is worth. Its writes would also survive the
    // run: `finalCleanup` sweeps uids and seeded docs, not reports, so each
    // preview would leave real rows in the owner's review queue.
    // `boot-fallback.cy.ts` is emulator-only for a reason that has nothing to
    // do with safety: it cannot work here. Two of its three tests force the
    // entry script to 404 with `cy.intercept`, and `firebase.json` serves
    // `**/*.@(js|css)` as `max-age=31536000, immutable` — so by the time this
    // spec runs, an earlier spec has already loaded the app and the browser
    // satisfies the script from its own HTTP cache. Nothing reaches the
    // network, the intercept never matches, and `cy.wait` fails with "No
    // request ever occurred". That is exactly how it failed on the first CI
    // run of the file, and it is a property of the deployment rather than
    // something the spec can be written around. The cost is that the preview
    // suite does not check the notice is absent on a healthy boot; the
    // emulator suite does.
    excludeSpecPattern: [
      'cypress/e2e/unauthenticated/question-reporting.cy.ts',
      'cypress/e2e/unauthenticated/boot-fallback.cy.ts',
    ],
    fixturesFolder: 'cypress/fixtures',
    video: false,
    // Real network hops (Hosting CDN + production Auth/Firestore) instead of
    // localhost + emulator, so give a bit more headroom than the emulator
    // config's already-generous timeout/retry settings.
    defaultCommandTimeout: 20000,
    // A retry re-runs the whole test including `beforeEach`, and there's no
    // `resetBackend()` wiping the real project between attempts — so every
    // identity/doc a test creates must be safe to create again on retry
    // (see the per-invocation-unique emails in sign-in-save-score.cy.ts and
    // profile.cy.ts). With that guaranteed, retries are worth keeping here:
    // real production network conditions produce real one-off flakiness the
    // emulator never does.
    retries: {
      runMode: 1,
      openMode: 0,
    },
    setupNodeEvents(on) {
      registerFirebasePreviewTasks(on);
    },
  },
});
