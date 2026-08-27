/**
 * `npm start`. Substituted into the `development` build by `angular.json`.
 *
 * **This file existed and was never substituted.** The `development` build
 * configuration carried no `fileReplacements`, so `ng serve` — the default
 * configuration — loaded `environment.ts` instead: `production: true`,
 * `useEmulators: false`. A local dev server therefore fetched
 * `/__/firebase/init.json`, which `src/proxy.conf.json` forwarded to the live
 * Hosting site, and initialised Firebase against **production**. Every local
 * sign-in, every question submitted while poking at a feature, every score
 * saved, went to the real project (`FEAT-012`).
 *
 * `useEmulators: true` is what makes that impossible rather than merely
 * unlikely: `FirebaseAppService` short-circuits the runtime-config fetch
 * entirely when it is set, so there is no request left to point anywhere.
 */
export const environment = {
  production: false,
  useEmulators: true,
  /**
   * Must match the `--project` the emulators were started with — `npm start`
   * starts them itself, so the two are set together. Emulator data is
   * namespaced per project id, so a mismatch is not an error, it is an empty
   * database.
   *
   * Deliberately *not* the e2e project: the e2e suite wipes state between
   * specs, and sharing an id would let a test run empty the data you were
   * developing against. The `demo-` prefix is load-bearing beyond tidiness —
   * `isDemoProject()` keys the mock-checkout gate on it (audit A7), and the
   * emulators refuse to reach a real backend under it.
   */
  emulatorProjectId: 'demo-trivimind-local',
  environmentLabel: 'EMULATOR',
  enableOfflinePrefetch: true,
};
