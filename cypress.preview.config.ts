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
    fixturesFolder: 'cypress/fixtures',
    video: false,
    // Real network hops (Hosting CDN + production Auth/Firestore) instead of
    // localhost + emulator, so give a bit more headroom than the emulator
    // config's already-generous timeout/retry settings.
    defaultCommandTimeout: 20000,
    // No retries here, unlike cypress.config.ts: a retry re-runs the whole
    // test including `beforeEach`, but there's no `resetBackend()` wiping
    // the real project between attempts — a retried `createVerifiedUser`
    // call collides on the same email/uid the first attempt already
    // created, turning "flaky test" into a guaranteed second failure
    // ("email address already in use"). Fix flakiness at the source instead.
    retries: {
      runMode: 0,
      openMode: 0,
    },
    setupNodeEvents(on) {
      registerFirebasePreviewTasks(on);
    },
  },
});
