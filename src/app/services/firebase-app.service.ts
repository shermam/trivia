import { Injectable } from '@angular/core';
import type { FirebaseApp, FirebaseOptions } from 'firebase/app';
import { environment } from '../../environments/environment';
import { withTimeout } from '../utils/with-timeout.util';

/**
 * Reserved Firebase Hosting endpoint that returns the web app config for
 * whichever project is serving the current origin. In production this is
 * generated automatically by Hosting; in dev it's proxied to the live
 * Hosting site (see src/proxy.conf.json). This means no Firebase config —
 * not even the "safe to expose" apiKey — ever needs to live in a committed
 * environment file.
 */
const RUNTIME_CONFIG_URL = '/__/firebase/init.json';

/**
 * Every other network call in the app (Firestore reads, anonymous sign-in)
 * is wrapped in `withTimeout` for exactly this reason, but this fetch — the
 * one thing everything else depends on via the shared `appPromise` below —
 * originally wasn't: a stalled connection here (no HTTP error, just a
 * request that never settles) silently hung the entire app forever, with no
 * timeout anywhere in the chain to ever surface it as a real error state.
 */
const RUNTIME_CONFIG_TIMEOUT_MS = 10_000;

/**
 * The Auth/Firestore emulators don't validate project credentials at all, so
 * under `environment.useEmulators` (see the `e2e` build config + Cypress)
 * this fake config is used instead of fetching runtime config — that fetch
 * would otherwise 404 (no Hosting emulator serving `ng serve`) or, worse,
 * proxy to the live production project. The "demo-" prefix is a Firebase
 * convention that keeps the emulators fully offline even if something here
 * were ever misconfigured.
 */
const EMULATOR_CONFIG: FirebaseOptions = {
  apiKey: 'demo-api-key',
  authDomain: 'demo-trivia-app-e2e.firebaseapp.com',
  projectId: 'demo-trivia-app-e2e',
};

/**
 * Single shared entry point for initializing the Firebase app. Firestore and
 * Auth both depend on this so `initializeApp` is only ever called once —
 * calling it twice with the same config throws.
 */
@Injectable({ providedIn: 'root' })
export class FirebaseAppService {
  private appPromise: Promise<FirebaseApp> | null = null;

  private async loadRuntimeConfig(): Promise<FirebaseOptions> {
    if (environment.useEmulators) {
      return EMULATOR_CONFIG;
    }
    const response = await withTimeout(fetch(RUNTIME_CONFIG_URL), RUNTIME_CONFIG_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Failed to load Firebase config from ${RUNTIME_CONFIG_URL}`);
    }
    return response.json();
  }

  /**
   * Lazily loads the Firebase SDK, fetches the runtime config, and initializes
   * Firebase exactly once. The SDK is dynamically imported (instead of a
   * top-level import) so it isn't bundled into the initial route chunk —
   * most users never touch auth, custom questions, or the leaderboard.
   */
  getApp(): Promise<FirebaseApp> {
    if (!this.appPromise) {
      this.appPromise = Promise.all([import('firebase/app'), this.loadRuntimeConfig()]).then(
        ([{ initializeApp }, config]) => initializeApp(config),
      );
    }
    return this.appPromise;
  }
}
