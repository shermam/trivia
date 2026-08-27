/**
 * Used only by the `e2e` build/serve configuration (see angular.json + the
 * `e2e` npm scripts). Points the app at the local Firebase Emulator Suite
 * instead of the live `intellectura-3b26a` project, so Cypress runs never
 * touch production Auth/Firestore data.
 */
export const environment = {
  production: false,
  useEmulators: true,
  emulatorProjectId: 'demo-trivia-app-e2e',
  // Empty on purpose: a badge here would change the top bar's width and
  // perturb the layout assertions in `mobile-nav.cy.ts`, and the Lighthouse
  // build substitutes this file too.
  environmentLabel: '',
  // Off here (unlike environment.ts/environment.development.ts): the background prefetch
  // fires its own opentdb.com/custom_questions requests on a timer independent of any
  // single test, so it can race Cypress's `cy.wait('@questions')` intercepts (see
  // stubOpenTrivia() in cypress/support/commands.ts) and steal a match meant for the
  // request a test actually triggered. Also keeps Lighthouse's audited page load free of
  // an extra background fetch it doesn't need (this file is reused by the `lighthouse`
  // build configuration too).
  enableOfflinePrefetch: false,
};
