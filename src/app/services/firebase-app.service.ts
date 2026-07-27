import { Injectable } from '@angular/core';
import type { FirebaseApp, FirebaseOptions } from 'firebase/app';

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
 * Single shared entry point for initializing the Firebase app. Firestore and
 * Auth both depend on this so `initializeApp` is only ever called once —
 * calling it twice with the same config throws.
 */
@Injectable({ providedIn: 'root' })
export class FirebaseAppService {
  private appPromise: Promise<FirebaseApp> | null = null;

  private async loadRuntimeConfig(): Promise<FirebaseOptions> {
    const response = await fetch(RUNTIME_CONFIG_URL);
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
