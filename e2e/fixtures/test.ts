import { test as base } from '@playwright/test';
import { AuthUidTracker, installAuthUidTracker } from '../support/auth-uid-tracker';
import { FirebaseBackend } from './firebase-backend';
import { previewTarget } from './firebase-preview-target';
import { FirebaseTarget, emulatorTarget } from './firebase-target';

/**
 * Which backend the `firebase` fixture writes to, named rather than passed.
 *
 * A Playwright config's `use` block is serialised to the worker processes, so
 * the thing a config can choose is a name; the target object itself, methods
 * and all, would not survive the trip. Naming it in the config rather than
 * reading an environment variable here keeps "which project does this run
 * write to" a property of the config that started the run — visible in
 * `playwright.preview.config.ts`, next to the base URL it belongs with.
 */
export type FirebaseTargetName = 'emulator' | 'preview';

/** Worker-scoped options a config may set in its `use` block. */
export interface E2EWorkerOptions {
  firebaseTarget: FirebaseTargetName;
}

const TARGETS: Record<FirebaseTargetName, FirebaseTarget> = {
  emulator: emulatorTarget,
  preview: previewTarget,
};

/**
 * The `test` every spec imports, carrying the `firebase` fixture.
 *
 * **Worker-scoped**, so one Admin app is initialised per worker process rather
 * than per test: `initializeApp` opens gRPC channels to Firestore and Auth,
 * and doing that 108 times to seed two documents each is pure cost. Playwright
 * tears the worker down after its last test, which is where the target's sweep
 * runs.
 *
 * Browser state is *not* shared and deliberately so: Playwright gives every
 * test a fresh `BrowserContext`, which means a fresh anonymous uid, fresh
 * cookies, fresh `localStorage` **and fresh IndexedDB**. That last one is what
 * Cypress had no equivalent for — `testIsolation` clears the first three and
 * there is no `cy.clearAllIndexedDb()` — so the app's saved in-progress game
 * and its daily-allowance counter leaked from one test into the next and had
 * to be deleted by hand from a `beforeEach` timed against the app's own open
 * connection. Here the isolation is a property of the context, so there is no
 * hook to place and no connection to race.
 */
export const test = base.extend<
  { authUids: AuthUidTracker },
  { firebase: FirebaseBackend } & E2EWorkerOptions
>({
  /**
   * The emulator unless a config says otherwise, so the default is the
   * throwaway backend and reaching the real project takes a deliberate line in
   * a config file rather than an omission.
   */
  firebaseTarget: ['emulator', { scope: 'worker', option: true }],

  firebase: [
    async ({ firebaseTarget }, use) => {
      const target = TARGETS[firebaseTarget];
      const app = target.createAdminApp();
      const backend = new FirebaseBackend(target, app);
      await use(backend);
      await backend.cleanup();
    },
    { scope: 'worker' },
  ],

  /**
   * Every uid the browser persists during a test, handed to the `firebase`
   * fixture when the test ends so the target's sweep can delete it.
   *
   * **Automatic**, because the uids that matter are the ones nothing asked
   * for: a page load signs in anonymously whether or not the test is about
   * auth, and against the real preview project those accounts are what
   * accumulates (finding C6). A fixture a spec had to remember to request
   * would be requested by the specs that already knew.
   *
   * It takes `context` rather than `page` so the install covers every page the
   * test opens, and because a context-level init script reaches the pages that
   * already exist as well as the ones created later.
   */
  authUids: [
    async ({ context, firebase }, use) => {
      const tracker = await installAuthUidTracker(context);
      await use(tracker);
      firebase.trackAuthUids(tracker.take());
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
