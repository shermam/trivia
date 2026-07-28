import { App, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { CustomQuestionSeed, LeaderboardSeed, VerifiedUserSeed } from './types';

const PROJECT_ID = 'intellectura-3b26a';

/**
 * Unlike firebase-emulator-tasks.ts, this file talks to the REAL project —
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
  return initializeApp({ projectId: PROJECT_ID });
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
          const docId = id ?? `preview-seed-${index}`;
          trackedCustomQuestionIds.add(docId);
          return firestore.collection('custom_questions').doc(docId).set(doc);
        }),
      );
      return null;
    },

    async seedLeaderboardEntry(entry: LeaderboardSeed) {
      trackedLeaderboardUids.add(entry.uid);
      await firestore
        .collection('leaderboard')
        .doc(entry.uid)
        .set({ createdAt: Date.now(), ...entry });
      return null;
    },

    /** Records a uid (e.g. the app's own anonymous sign-in) for later cleanup, without writing anything. */
    trackAuthUid(uid: string) {
      if (uid) {
        trackedAuthUids.add(uid);
      }
      return null;
    },

    async finalCleanup() {
      const leaderboardUids = new Set([...trackedLeaderboardUids, ...trackedAuthUids]);

      await Promise.all([
        ...[...trackedAuthUids].map((uid) => auth.deleteUser(uid).catch(() => undefined)),
        ...[...leaderboardUids].map((uid) =>
          firestore
            .collection('leaderboard')
            .doc(uid)
            .delete()
            .catch(() => undefined),
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
