/**
 * Used only by the `e2e` build/serve configuration (see angular.json + the
 * `e2e` npm scripts). Points the app at the local Firebase Emulator Suite
 * instead of the live `intellectura-3b26a` project, so the Playwright suite
 * never touches production Auth/Firestore data.
 */
export const environment = {
  production: false,
  useEmulators: true,
  emulatorProjectId: 'demo-trivia-app-e2e',
  // Empty on purpose: a badge here would change the top bar's width and
  // perturb the layout assertions in `mobile-nav.spec.ts`, and the Lighthouse
  // build substitutes this file too.
  environmentLabel: '',
  // Off here (unlike environment.ts/environment.development.ts): the background prefetch
  // fires its own opentdb.com/custom_questions requests on a timer independent of any
  // single test, so the traffic a spec sees stops being only the traffic it triggered:
  // the stubs (stubOpenTrivia() in e2e/support/open-trivia.ts) answer the prefetch's
  // requests as readily as a test's own, and the pool it fills lands in the same
  // IndexedDB database `e2e/support/offline-storage.ts` reads a saved game back out of.
  // Also keeps Lighthouse's audited page load free of an extra background fetch it doesn't
  // need (this file is reused by the `lighthouse` build configuration too).
  enableOfflinePrefetch: false,
};
