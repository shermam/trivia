import { Injectable } from '@angular/core';
import type { FirebaseApp, FirebaseOptions } from 'firebase/app';
import { environment } from '../../environments/environment';

/**
 * Reserved Firebase Hosting endpoint that returns the web app config for
 * whichever project is serving the current origin. Hosting generates it
 * automatically, so no Firebase config — not even the "safe to expose"
 * apiKey — ever needs to live in a committed environment file. It is also
 * what lets one bundle work against production or `trivimind-dev` unchanged.
 *
 * **Only reached when `useEmulators` is false**, which now excludes the
 * default dev server. It used to include it, and `src/proxy.conf.json`
 * forwarded the request to the *production* Hosting site — so `npm start`
 * initialised Firebase against the real project. That is `FEAT-012`, and the
 * fix is upstream of this constant: the `development` build sets
 * `useEmulators`, so the fetch never happens.
 */
const RUNTIME_CONFIG_URL = '/__/firebase/init.json';

/**
 * Every network call in the app carries a deadline for this reason, but this
 * fetch — the one thing everything else depends on via the shared
 * `appPromise` below — originally didn't: a stalled connection here (no HTTP
 * error, just a request that never settles) silently hung the entire app
 * forever, with nothing in the chain to ever surface it as a real error state.
 *
 * Unlike the Firestore calls, `fetch` can actually be cancelled, so this one
 * uses `AbortSignal.timeout` and the connection is torn down rather than left
 * running for a caller that has stopped listening.
 */
const RUNTIME_CONFIG_TIMEOUT_MS = 10_000;

/**
 * The Auth/Firestore emulators don't validate project credentials at all, so
 * under `environment.useEmulators` (the `e2e` and `development` builds) this
 * fake config is used instead of fetching runtime config — that fetch would
 * otherwise 404 (no Hosting emulator serving `ng serve`) or, worse, proxy to
 * the live production project. The "demo-" prefix is a Firebase convention
 * that keeps the emulators fully offline even if something here were ever
 * misconfigured.
 *
 * **The project id is per-environment, not a constant.** It was hard-coded to
 * the e2e project, which was right while e2e was the only thing running on
 * emulators. `npm start` runs on them too now (`FEAT-012`), and giving local
 * development its own id keeps an e2e run — which wipes state between specs —
 * from emptying the data you were developing against. Whichever it is, it has
 * to match the `--project` the emulators were started with: emulator data is
 * namespaced per project id, so a mismatch presents as an empty database
 * rather than as an error.
 */
function emulatorConfig(): FirebaseOptions {
  const projectId = environment.emulatorProjectId;
  return {
    apiKey: 'demo-api-key',
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
  };
}

/**
 * Single shared entry point for initializing the Firebase app. Firestore and
 * Auth both depend on this so `initializeApp` is only ever called once —
 * calling it twice with the same config throws.
 */
@Injectable({ providedIn: 'root' })
export class FirebaseAppService {
  private appPromise: Promise<FirebaseApp> | null = null;
  private configPromise: Promise<FirebaseOptions> | null = null;

  /**
   * The runtime config on its own, without initializing the Firebase app.
   *
   * `FirestoreRestClient` needs the `projectId` (it goes in every REST URL)
   * and the `apiKey`, but has no use for a `FirebaseApp` — REST is `fetch`.
   * Exposing the config separately keeps the SDK out of that path entirely.
   *
   * Memoized separately from `appPromise` so the config is fetched once
   * however it is reached first, and **cleared on rejection**: a cached
   * rejected promise turns one transient blip into a permanently broken
   * session (`CLAUDE.md` §4.4).
   */
  getConfig(): Promise<FirebaseOptions> {
    if (!this.configPromise) {
      this.configPromise = this.loadRuntimeConfig();
      this.configPromise.catch(() => {
        this.configPromise = null;
      });
    }
    return this.configPromise;
  }

  private async loadRuntimeConfig(): Promise<FirebaseOptions> {
    if (environment.useEmulators) {
      return emulatorConfig();
    }
    // `AbortSignal.timeout` genuinely aborts the request. Racing a promise
    // against a timer only stops *waiting* — the connection stays open and the
    // response is still downloaded and parsed for a caller that has already
    // given up.
    const response = await fetch(RUNTIME_CONFIG_URL, {
      signal: AbortSignal.timeout(RUNTIME_CONFIG_TIMEOUT_MS),
    });
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
      this.appPromise = Promise.all([import('firebase/app'), this.getConfig()]).then(
        ([{ initializeApp }, config]) => initializeApp(config),
      );
    }
    return this.appPromise;
  }
}
