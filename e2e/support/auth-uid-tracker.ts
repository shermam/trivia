import { BrowserContext } from '@playwright/test';

/**
 * Records **every** Firebase uid a test's browser ever persists, not just the
 * one it happens to hold at the end.
 *
 * Finding C6. The preview target cleans up after itself by deleting the Auth
 * accounts its tests created, and most of those accounts are not created by any
 * seeding call: every page load signs in anonymously, so the uids that actually
 * accumulate are the ambient ones. Reading the app's `firebase:authUser:*`
 * entry once per test is a *sample*, and it misses every uid a test replaces
 * along the way — most obviously a sign-out, which mints a fresh anonymous
 * account (C3), but equally a sign-in that switches uid rather than linking.
 * Those accounts were left behind in the real project: 822 of its 829 Auth
 * accounts were anonymous when this was measured, accumulating fastest on the
 * days with the most CI runs.
 *
 * Wrapping `setItem` instead of sampling it turns the question from "what is
 * the uid now" into "what uids have there ever been", which is the one the
 * cleanup actually needs to answer. Firebase's `browserLocalPersistence`
 * (`AuthService.getAuth()` asks for it by name) writes the user record on every
 * auth state change, so every uid passes through here.
 */

const FIREBASE_AUTH_KEY_PREFIX = 'firebase:authUser:';

/**
 * The name the page-side wrapper reports through.
 *
 * A Playwright binding rather than a browser global the test reads back
 * afterwards, and the difference matters: a global lives in the page's
 * JavaScript context, which is destroyed and rebuilt on every navigation — so
 * a uid recorded before a reload would be gone by the time anything asked for
 * it, which is precisely the case being tracked. The binding delivers each uid
 * to Node as it is written, where it outlives any number of documents.
 */
const REPORT_BINDING = '__triviaReportAuthUid';

/** Marks the prototype as already wrapped, so a second install is a no-op. */
const INSTALLED_FLAG = '__triviaAuthUidTrackerInstalled';

export interface AuthUidTracker {
  /** Every uid seen so far. */
  uids(): string[];
  /** Returns everything seen so far and clears the buffer, so uids are reported once. */
  take(): string[];
}

/**
 * Installs the tracker on every document this context will ever load.
 *
 * `addInitScript` is the Playwright equivalent of Cypress's
 * `window:before:load`: it runs before any application code, on the first
 * navigation and on every one after it, in each page of the context. It only
 * observes — the original `setItem` is always called.
 */
export async function installAuthUidTracker(context: BrowserContext): Promise<AuthUidTracker> {
  const seen = new Set<string>();

  await context.exposeFunction(REPORT_BINDING, (uid: string) => {
    if (typeof uid === 'string' && uid.length > 0) {
      seen.add(uid);
    }
  });

  await context.addInitScript(
    ({ prefix, binding, installedFlag }) => {
      const report = (value: string | null): void => {
        if (!value) {
          return;
        }
        try {
          const uid = (JSON.parse(value) as { uid?: unknown }).uid;
          if (typeof uid === 'string' && uid.length > 0) {
            const send = (window as unknown as Record<string, unknown>)[binding];
            if (typeof send === 'function') {
              (send as (value: string) => void)(uid);
            }
          }
        } catch {
          // Not the shape we expect — a corrupt or future Firebase record.
          // Nothing to clean up from it, and throwing here would fail an
          // unrelated test.
        }
      };

      // The uid already persisted when this document loads. A reload restores
      // the session from storage without writing it again, so the `setItem`
      // wrapper below would never see it.
      try {
        for (const key of Object.keys(window.localStorage)) {
          if (key.startsWith(prefix)) {
            report(window.localStorage.getItem(key));
          }
        }
      } catch {
        // An opaque origin has no storage to read, and nothing was persisted
        // there to clean up either.
      }

      /**
       * **The prototype, not the `localStorage` instance.** Assigning
       * `localStorage.setItem = fn` looks equivalent and is not: `Storage` has
       * a named-property setter, so that assignment stores the function *as a
       * storage entry called `setItem`* instead of shadowing the method. The
       * observable result is a corrupted store — `Object.keys(localStorage)`
       * returns `['setItem']` and the app's own writes never land, so the very
       * uid this exists to capture is never persisted at all. Caught by
       * instrumenting a failing run rather than by reading the code, because
       * both forms behave identically in an ordinary page.
       */
      const storagePrototype = window.Storage?.prototype as
        (Storage & Record<string, unknown>) | undefined;
      if (!storagePrototype || storagePrototype[installedFlag]) {
        return;
      }

      const originalSetItem = storagePrototype.setItem;
      storagePrototype.setItem = function (this: Storage, key: string, value: string) {
        // Recorded before delegating, so a throwing `setItem` (quota, disabled
        // storage) still leaves the uid known to the cleanup.
        if (typeof key === 'string' && key.startsWith(prefix)) {
          report(value);
        }
        return originalSetItem.call(this, key, value);
      };
      storagePrototype[installedFlag] = true;
    },
    { prefix: FIREBASE_AUTH_KEY_PREFIX, binding: REPORT_BINDING, installedFlag: INSTALLED_FLAG },
  );

  return {
    uids: () => [...seen],
    take: () => {
      const uids = [...seen];
      seen.clear();
      return uids;
    },
  };
}
