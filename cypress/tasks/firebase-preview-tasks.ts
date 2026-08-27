import { App, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { CustomQuestionSeed, LEADERBOARD_BOARDS, LeaderboardSeed, VerifiedUserSeed } from './types';

/**
 * The project these tasks write to, from the environment rather than from a
 * constant — and with **no default**, because there is no value it could
 * safely default to.
 *
 * It was `intellectura-3b26a`, hard-coded, which meant every PR seeded real
 * Auth users, real `custom_questions` documents and real leaderboard rows into
 * **production** and swept them afterwards on a best-effort basis. A default
 * would preserve exactly that failure mode: silently correct-looking, and
 * pointed at the wrong database. Throwing is the point.
 *
 * The production id is rejected outright rather than merely not defaulted to.
 * These tasks hold Admin-SDK credentials and bypass `firestore.rules`
 * entirely, so "someone set the variable to production" is a mistake worth
 * refusing rather than obeying.
 */
const PRODUCTION_PROJECT_ID = 'intellectura-3b26a';

function previewProjectId(): string {
  const projectId = process.env['FIREBASE_PREVIEW_PROJECT_ID'];
  if (!projectId) {
    throw new Error(
      'FIREBASE_PREVIEW_PROJECT_ID is not set. The preview tasks write to a real Firebase ' +
        'project with Admin-SDK credentials, so they will not guess which one. Set it in ' +
        '.github/workflows/firebase-preview.yml (or your shell, for a local run).',
    );
  }
  if (projectId === PRODUCTION_PROJECT_ID) {
    throw new Error(
      `FIREBASE_PREVIEW_PROJECT_ID is set to the production project (${PRODUCTION_PROJECT_ID}). ` +
        'These tasks seed and delete Auth users and Firestore documents directly, bypassing ' +
        'firestore.rules. Point them at trivimind-dev.',
    );
  }
  return projectId;
}

/**
 * Unlike firebase-emulator-tasks.ts, this file talks to a REAL project —
 * `FIRESTORE_EMULATOR_HOST`/`FIREBASE_AUTH_EMULATOR_HOST` are deliberately
 * never set here. Credentials come from `GOOGLE_APPLICATION_CREDENTIALS`
 * (the same deploy service-account key CI already writes to a temp file for
 * the Firestore rules/indexes deploy step), picked up automatically by the
 * Admin SDK's default credential lookup.
 */
function getAdminApp(): App {
  const existing = getApps()[0];
  if (existing) {
    return existing;
  }
  return initializeApp({ projectId: previewProjectId() });
}

/**
 * There's no clean-slate emulator to reset before each test here — this is
 * the real, persistent, public database. Every Auth uid and Firestore doc a
 * test creates (directly via a seed task, or indirectly by the app itself
 * signing someone in anonymously) is tracked in-process and swept up by
 * `finalCleanup`, called once per spec file from an `after()` hook in
 * cypress/support/e2e.preview.ts. Deletes are individually caught so one
 * already-missing doc/user never stops the rest of the sweep.
 */
const trackedAuthUids = new Set<string>();
const trackedLeaderboardUids = new Set<string>();
const trackedCustomQuestionIds = new Set<string>();

export function registerFirebasePreviewTasks(on: Cypress.PluginEvents): void {
  const app = getAdminApp();
  const auth = getAuth(app);
  const firestore = getFirestore(app);

  on('task', {
    async createVerifiedUser(seed: VerifiedUserSeed) {
      const user = await auth.createUser({
        email: seed.email,
        password: seed.password,
        displayName: seed.displayName,
        emailVerified: true,
      });
      trackedAuthUids.add(user.uid);
      return { uid: user.uid };
    },

    async seedCustomQuestions(questions: CustomQuestionSeed[]) {
      await Promise.all(
        questions.map((q, index) => {
          const { id, ...doc } = q;
          const seeded = { status: 'approved', ...doc };
          const docId = id ?? `preview-seed-${index}`;
          trackedCustomQuestionIds.add(docId);
          return firestore.collection('custom_questions').doc(docId).set(seeded);
        }),
      );
      return null;
    },

    async seedLeaderboardEntry(entry: LeaderboardSeed) {
      trackedLeaderboardUids.add(entry.uid);
      const board = entry.timeLimit ?? '15';
      await firestore
        .doc(`leaderboards/${board}/entries/${entry.uid}`)
        .set({ createdAt: Date.now(), ...entry, timeLimit: board });
      return null;
    },

    /** Records a uid (e.g. the app's own anonymous sign-in) for later cleanup, without writing anything. */
    /**
     * Takes every uid a test's browser persisted, not just the one it held at
     * the end — see `cypress/support/auth-uid-tracker.ts` (finding C6). Plural
     * because a single test legitimately produces several: a sign-out mints a
     * fresh anonymous account, and a sign-in can switch uid rather than link.
     */
    trackAuthUids(uids: string[]) {
      for (const uid of uids) {
        if (uid) {
          trackedAuthUids.add(uid);
        }
      }
      return null;
    },

    async finalCleanup() {
      const leaderboardUids = new Set([...trackedLeaderboardUids, ...trackedAuthUids]);

      await Promise.all([
        ...[...trackedAuthUids].map((uid) => auth.deleteUser(uid).catch(() => undefined)),
        // Every board, or a preview run leaves real rows behind on the two
        // this suite happens not to write to.
        ...[...leaderboardUids].flatMap((uid) =>
          LEADERBOARD_BOARDS.map((board) =>
            firestore
              .doc(`leaderboards/${board}/entries/${uid}`)
              .delete()
              .catch(() => undefined),
          ),
        ),
        ...[...trackedCustomQuestionIds].map((id) =>
          firestore
            .collection('custom_questions')
            .doc(id)
            .delete()
            .catch(() => undefined),
        ),
      ]);

      trackedAuthUids.clear();
      trackedLeaderboardUids.clear();
      trackedCustomQuestionIds.clear();
      return null;
    },
  });
}
