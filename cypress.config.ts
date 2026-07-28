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
    // Deliberately above the app's own 15s per-question countdown
    // (QUESTION_DURATION_SECONDS in quiz-loop.component.ts): on a
    // CPU-constrained CI runner (Firestore's JVM emulator + the Angular dev
    // server + headless Chrome all sharing a couple of shared vCPUs),
    // Cypress's own command execution can occasionally get starved for
    // several seconds. The answer button stays clickable for the full 15s
    // regardless, so a timeout below that just means Cypress giving up
    // early on a button that was never actually gone.
    defaultCommandTimeout: 20000,
    // Retries as a secondary safety net for the rarer case that CI slowness
    // eats into the full 15s countdown itself. `cypress open` never
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
