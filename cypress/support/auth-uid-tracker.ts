/**
 * Records **every** Firebase uid a test's browser ever persists, not just the
 * one it happens to hold at the end.
 *
 * Finding C6. The preview suite cleans up after itself by reading the app's
 * `firebase:authUser:*` localStorage entry in an `afterEach` and deleting that
 * uid. That is a *sample*, and it misses every uid a test replaces along the
 * way — most obviously a sign-out, which mints a fresh anonymous account (C3)
 * and leaves the previous one untracked, but equally a sign-in that switches
 * uid rather than linking. Those accounts were then left behind in the real
 * project: 822 of its 829 Auth accounts were anonymous when this was measured,
 * accumulating fastest on the days with the most CI runs.
 *
 * Wrapping `localStorage.setItem` instead of sampling it turns the question
 * from "what is the uid now" into "what uids has there ever been", which is the
 * one the cleanup actually needs to answer. Firebase's `browserLocalPersistence`
 * writes the user record on every auth state change, so every uid passes
 * through here exactly once.
 *
 * Installed from `window:before:load` so it is in place before any app code
 * runs. It only observes: the original `setItem` is always called.
 */

const FIREBASE_AUTH_KEY_PREFIX = 'firebase:authUser:';

/**
 * Kept on a global rather than in module scope, because module scope is not
 * shared where it needs to be: Cypress bundles the support file and each spec
 * separately, so a plain module-level `Set` gives the installer and the reader
 * *different* instances — the wrapper records uids into one and the cleanup
 * reads an empty other. Confirmed by observation, not guessed: the tracker was
 * demonstrably intercepting writes while every assertion still saw zero uids.
 *
 * A global also survives the several windows a single test can load
 * (`cy.visit()`, `cy.reload()`), which is exactly the case being tracked.
 */
const STORE_KEY = '__triviaTrackedAuthUids';

function seen(): Set<string> {
  const scope = globalThis as typeof globalThis & { [STORE_KEY]?: Set<string> };
  scope[STORE_KEY] ??= new Set<string>();
  return scope[STORE_KEY];
}

/** Marks a prototype as already wrapped, so a second install is a no-op. */
const INSTALLED_FLAG = '__triviaAuthUidTrackerInstalled';

/**
 * Wraps `Storage.prototype.setItem` for this window so every persisted uid is
 * recorded.
 *
 * **The prototype, not the `localStorage` instance.** Assigning
 * `localStorage.setItem = fn` looks equivalent and is not: `Storage` exposes a
 * named-property setter, so in the Cypress-controlled window that assignment
 * stores the function *as a storage entry called `setItem`* instead of shadowing
 * the method. The observable result is a corrupted store — `Object.keys(
 * localStorage)` returns `['setItem']` and the app's own writes never land, so
 * the very uid this is meant to capture is never persisted at all. Caught by
 * instrumenting a failing run rather than by reading the code, because both
 * forms behave identically in an ordinary page.
 */
export function installAuthUidTracker(win: Window): void {
  const storagePrototype = win.Storage?.prototype as
    (Storage & { [INSTALLED_FLAG]?: boolean }) | undefined;
  if (!storagePrototype || storagePrototype[INSTALLED_FLAG]) {
    return;
  }

  const originalSetItem = storagePrototype.setItem;
  storagePrototype.setItem = function (this: Storage, key: string, value: string) {
    // Recorded before delegating, so a throwing `setItem` (quota, disabled
    // storage) still leaves the uid known to the cleanup.
    if (key.startsWith(FIREBASE_AUTH_KEY_PREFIX)) {
      rememberUidFrom(value);
    }
    return originalSetItem.call(this, key, value);
  };
  storagePrototype[INSTALLED_FLAG] = true;
}

/**
 * Also catches the uid already persisted when a window loads — a reload
 * restores the session from storage without writing it again, so `setItem`
 * alone would never see it.
 */
export function rememberExistingUid(win: Window): void {
  for (const key of Object.keys(win.localStorage)) {
    if (key.startsWith(FIREBASE_AUTH_KEY_PREFIX)) {
      rememberUidFrom(win.localStorage.getItem(key));
    }
  }
}

function rememberUidFrom(value: string | null): void {
  if (!value) {
    return;
  }
  try {
    const uid = (JSON.parse(value) as { uid?: unknown }).uid;
    if (typeof uid === 'string' && uid.length > 0) {
      seen().add(uid);
    }
  } catch {
    // Not the shape we expect — a corrupt or future Firebase record. Nothing
    // to clean up from it, and throwing here would fail an unrelated test.
  }
}

/** Every uid seen so far. */
export function trackedAuthUids(): string[] {
  return [...seen()];
}

/** Returns everything seen so far and clears the buffer, so uids are reported once. */
export function takeTrackedAuthUids(): string[] {
  const uids = [...seen()];
  seen().clear();
  return uids;
}
