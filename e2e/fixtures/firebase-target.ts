import { App, getApps, initializeApp } from 'firebase-admin/app';

/**
 * Everything one Playwright worker brought into existence, handed to the
 * target's sweep at the end of the run.
 *
 * The emulator target ignores it. It exists because the preview target cannot:
 * against a real project there is no wipe, so cleanup is "delete exactly what
 * was created", and that list has to be kept as it is created rather than
 * reconstructed afterwards.
 */
export interface CreatedState {
  readonly authUids: ReadonlySet<string>;
  readonly customQuestionIds: ReadonlySet<string>;
}

/**
 * Which backend the `firebase` fixture writes to.
 *
 * There are two, and they differ in more than a project id: one is a throwaway
 * emulator no human will ever look at, the other is a real, persistent,
 * publicly-readable Firebase project. Everything that difference implies —
 * where credentials come from, whether a blanket wipe is acceptable, what has
 * to be swept afterwards — belongs behind this interface, so the fixture and
 * every spec above it are written once and run against either.
 */
export interface FirebaseTarget {
  /** For error messages, and for the Auth emulator's REST endpoints. */
  readonly projectId: string;

  /**
   * The Admin app for this target, credentials and all. Admin credentials
   * bypass `firestore.rules` entirely, which is exactly what is needed to seed
   * `custom_questions` (clients may not write it) and to mint an
   * already-verified user.
   */
  createAdminApp(): App;

  /** Called once per Playwright worker, after its last test. */
  cleanup(app: App, created: CreatedState): Promise<void>;
}

/**
 * The emulator's project id.
 *
 * Must match `EMULATOR_CONFIG.projectId` in
 * `src/app/services/firebase-app.service.ts` — that is the project the app
 * connects to (via the `e2e` build config) when `useEmulators` is true, and it
 * is also the project the Firebase Emulator Suite is started against (see the
 * `pw:e2e` npm script). The `demo-` prefix keeps the emulators fully offline,
 * and `isDemoProject()` in `functions/` keys the mock-checkout gate on it, so
 * the prefix is load-bearing rather than cosmetic. `npm run env:verify` checks
 * that this file never names the production project.
 */
const EMULATOR_PROJECT_ID = 'demo-trivia-app-e2e';

const AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

/**
 * The local Firebase Emulator Suite.
 *
 * The Admin SDK talks to the emulators rather than to Google purely because
 * these two env vars are set before `initializeApp` runs. That is the whole
 * safety mechanism, which is why it lives here next to the `demo-` project id
 * rather than in a shell script somebody could forget to export.
 */
export const emulatorTarget: FirebaseTarget = {
  projectId: EMULATOR_PROJECT_ID,

  createAdminApp(): App {
    process.env['FIREBASE_AUTH_EMULATOR_HOST'] = AUTH_EMULATOR_HOST;
    process.env['FIRESTORE_EMULATOR_HOST'] = FIRESTORE_EMULATOR_HOST;

    const existing = getApps()[0];
    if (existing) {
      return existing;
    }
    return initializeApp({ projectId: EMULATOR_PROJECT_ID });
  },

  cleanup(): Promise<void> {
    // Nothing to sweep: `firebase emulators:exec` discards the whole database
    // when the run ends, users and documents alike.
    return Promise.resolve();
  },
};
