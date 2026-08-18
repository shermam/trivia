import './commands';
import { installAuthUidTracker } from './auth-uid-tracker';

// Installed here too, though this suite has nothing to clean up: the emulator
// is wiped per test. It is what lets `auth-uid-tracking.cy.ts` verify the
// mechanism the *preview* suite depends on, against a real browser and a real
// Firebase Auth, in a suite that can be run locally (finding C6).
Cypress.on('window:before:load', (win) => {
  installAuthUidTracker(win);
});

// Every spec starts from a clean emulator: no leftover Auth users or
// Firestore docs from a previous test, so tests never depend on run order.
//
// The emulator is only half of "clean", though. `resetBackend()` resets the
// *backend*; the browser keeps its own state, and Cypress's `testIsolation`
// clears cookies, localStorage and sessionStorage but has no IndexedDB
// equivalent — so the saved in-progress game outlived every test until
// `clearOfflineStorage()` was added. Both run before the first `cy.visit()`,
// which for the IndexedDB half is a requirement rather than a convention: see
// `offline-storage.ts`.
beforeEach(() => {
  cy.resetBackend();
  cy.clearOfflineStorage();
});
