import { test as base } from '@playwright/test';
import { AuthUidTracker, installAuthUidTracker } from '../support/auth-uid-tracker';
import { FirebaseBackend } from './firebase-backend';
import { emulatorTarget } from './firebase-target';

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
export const test = base.extend<{ authUids: AuthUidTracker }, { firebase: FirebaseBackend }>({
  firebase: [
    // Playwright reads the *source text* of this parameter to work out which
    // fixtures the function depends on, and rejects anything that is not a
    // destructuring pattern — so the empty pattern is required here rather
    // than stylistic, even though nothing is taken out of it.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const app = emulatorTarget.createAdminApp();
      const backend = new FirebaseBackend(emulatorTarget, app);
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
