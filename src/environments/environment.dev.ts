/**
 * The **`trivimind-dev` Firebase project** — a real deployment, and
 * deliberately as close to production as it can be while still being
 * distinguishable from it.
 *
 * Built through the `dev-project` configuration, which is the production
 * configuration plus this one substitution: same optimiser settings, same
 * budgets, same service worker, same `firebase.json` headers and CSP, same
 * `firestore.rules` and indexes. That is the point — a change validated here
 * has been validated against the thing that will run it. `useEmulators` is
 * false, so config comes from `/__/firebase/init.json` served by whichever
 * Hosting origin is serving the page, which is what lets one bundle work
 * against either project with no key in the repo.
 *
 * The single deviation is `environmentLabel`, and it is not cosmetic: with no
 * badge there is nothing on screen distinguishing a faithful copy from the
 * original, which is precisely the situation in which somebody tries a
 * destructive change on what they believe is dev.
 */
export const environment = {
  production: true,
  useEmulators: false,
  emulatorProjectId: '',
  environmentLabel: 'DEV',
  enableOfflinePrefetch: true,
};
