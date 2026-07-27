import { defineConfig } from 'cypress';
import { registerFirebaseEmulatorTasks } from './cypress/tasks/firebase-emulator-tasks';

/**
 * Must match `EMULATOR_CONFIG.projectId` in
 * `src/app/services/firebase-app.service.ts` — that's the project the app
 * connects to (via the `e2e` build config) when `useEmulators` is true, and
 * it's also the project the Firebase Emulator Suite is started against (see
 * the `emulators:*` / `e2e*` npm scripts). The "demo-" prefix keeps the
 * emulators fully offline, with no way to accidentally reach production.
 */
export const E2E_PROJECT_ID = 'demo-trivia-app-e2e';

export default defineConfig({
  e2e: {
    baseUrl: 'http://localhost:4200',
    supportFile: 'cypress/support/e2e.ts',
    specPattern: 'cypress/e2e/**/*.cy.ts',
    fixturesFolder: 'cypress/fixtures',
    video: false,
    defaultCommandTimeout: 12000,
    // The Firestore/Auth emulators (and the underlying JVM) occasionally add
    // a few seconds of latency under load — one automatic retry in `cypress
    // run` (CI/headless) absorbs that without hiding a real failure, since a
    // genuine bug fails again on the retry. Interactive `cypress open` never
    // retries, so nothing is hidden while actively developing a test.
    retries: {
      runMode: 1,
      openMode: 0,
    },
    setupNodeEvents(on) {
      registerFirebaseEmulatorTasks(on);
    },
  },
});
