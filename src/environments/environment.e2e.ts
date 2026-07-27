/**
 * Used only by the `e2e` build/serve configuration (see angular.json + the
 * `e2e` npm scripts). Points the app at the local Firebase Emulator Suite
 * instead of the live `intellectura-3b26a` project, so Cypress runs never
 * touch production Auth/Firestore data.
 */
export const environment = {
  production: false,
  useEmulators: true,
};
