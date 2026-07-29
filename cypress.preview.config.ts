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
      // TEMPORARY diagnostic spec — see cypress/e2e-preview-diagnostic/network.cy.ts.
      'cypress/e2e-preview-diagnostic/**/*.cy.ts',
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

      // Diagnostic finding: fetch() to Google-operated hosts (Firebase
      // Hosting, identitytoolkit.googleapis.com) hangs forever inside
      // Cypress's Electron browser in this CI runner, while a plain curl
      // from the same runner succeeds in <0.5s and an unrelated third-party
      // host (opentdb.com) fetches fine from the same browser. Disabling
      // QUIC alone didn't fix it. DNS resolution confirmed the actual
      // pattern: the hanging hosts are dual-stack (both A and AAAA/IPv6
      // records), while opentdb.com is IPv4-only — this runner's IPv6 route
      // silently black-holes instead of failing fast, defeating Chromium's
      // own Happy-Eyeballs fallback to IPv4. Forcing IPv4-only avoids the
      // black hole entirely.
      on('before:browser:launch', (browser, launchOptions) => {
        if (browser.family === 'chromium') {
          launchOptions.args.push('--disable-ipv6', '--disable-quic');
        }
        return launchOptions;
      });
    },
  },
});
