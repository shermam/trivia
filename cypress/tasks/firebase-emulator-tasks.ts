import { App, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { CollectionReference, getFirestore } from 'firebase-admin/firestore';
import { E2E_PROJECT_ID } from '../../cypress.config';
import {
  AccountStateQuery,
  CustomQuestionSeed,
  LeaderboardSeed,
  ProSubscriptionSeed,
  QuestionReportRecord,
  VerifiedUserSeed,
} from './types';
import { LEADERBOARD_BOARDS } from './types';

const AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

/**
 * The Admin SDK talks to the emulators (not production) purely because these
 * env vars are set before `initializeApp` runs — never touch these tasks
 * outside a local/CI emulator session. Admin credentials bypass
 * `firestore.rules` entirely, which is exactly what's needed to seed
 * `custom_questions` (client-writes are disabled by rule) and to reset state
 * between specs.
 */
function getAdminApp(): App {
  process.env['FIREBASE_AUTH_EMULATOR_HOST'] = AUTH_EMULATOR_HOST;
  process.env['FIRESTORE_EMULATOR_HOST'] = FIRESTORE_EMULATOR_HOST;

  const existing = getApps()[0];
  if (existing) {
    return existing;
  }
  return initializeApp({ projectId: E2E_PROJECT_ID });
}

async function deleteCollection(collection: CollectionReference): Promise<void> {
  const snapshot = await collection.listDocuments();
  await Promise.all(snapshot.map((doc) => doc.delete()));
}

interface OobCode {
  email: string;
  requestType: string;
  oobLink: string;
}

/**
 * The Auth emulator never sends real email — instead it exposes pending
 * "out-of-band" action codes (verify-email, password-reset, ...) over a
 * testing-only REST endpoint. Fetching the most recent VERIFY_EMAIL link for
 * an address is the documented way to drive the real email-verification flow
 * end-to-end without a mailbox.
 */
async function fetchVerificationLink(email: string): Promise<string> {
  const response = await fetch(
    `http://${AUTH_EMULATOR_HOST}/emulator/v1/projects/${E2E_PROJECT_ID}/oobCodes`,
  );
  const { oobCodes } = (await response.json()) as { oobCodes: OobCode[] };
  const match = [...oobCodes]
    .reverse()
    .find((code) => code.email === email && code.requestType === 'VERIFY_EMAIL');
  if (!match) {
    throw new Error(`No pending email-verification code found for ${email}`);
  }
  return match.oobLink;
}

export function registerFirebaseEmulatorTasks(on: Cypress.PluginEvents): void {
  const app = getAdminApp();
  const auth = getAuth(app);
  const firestore = getFirestore(app);

  on('task', {
    async resetBackend() {
      const [{ users }] = await Promise.all([auth.listUsers(1000)]);
      await Promise.all([
        users.length ? auth.deleteUsers(users.map((u) => u.uid)) : Promise.resolve(),
        deleteCollection(firestore.collection('leaderboard')),
        // One per board (G7). `recursiveDelete` on `leaderboards` would not
        // reach them: the board documents themselves are never created, and a
        // recursive delete starts from documents that exist.
        ...LEADERBOARD_BOARDS.map((board) =>
          deleteCollection(firestore.collection(`leaderboards/${board}/entries`)),
        ),
        deleteCollection(firestore.collection('custom_questions')),
        deleteCollection(firestore.collection('question_reports')),
        // `recursiveDelete` (not the plain `deleteCollection` helper above)
        // because each `customers/{uid}` doc owns subcollections
        // (`subscriptions`, `checkout_sessions`, `payments`) that a
        // top-level doc delete would otherwise orphan.
        firestore.recursiveDelete(firestore.collection('customers')),
      ]);
      return null;
    },

    async createVerifiedUser(seed: VerifiedUserSeed) {
      const user = await auth.createUser({
        email: seed.email,
        password: seed.password,
        displayName: seed.displayName,
        emailVerified: true,
      });
      return { uid: user.uid };
    },

    async seedCustomQuestions(questions: CustomQuestionSeed[]) {
      await Promise.all(
        questions.map((q, index) => {
          const { id, ...doc } = q;
          const seeded = { status: 'approved', ...doc };
          return firestore
            .collection('custom_questions')
            .doc(id ?? `seed-${index}`)
            .set(seeded);
        }),
      );
      return null;
    },

    /**
     * Reads the state account deletion is supposed to leave behind, in one
     * round trip. Deletion spans Auth, the leaderboard and the question bank,
     * and asserting only on the UI would prove nothing about any of them —
     * the whole risk is a step that silently doesn't run.
     */
    async inspectAccountState({ uid, questionId }: AccountStateQuery) {
      const [authUser, leaderboardDoc, questionDoc, customerDoc] = await Promise.all([
        auth.getUser(uid).catch(() => null),
        Promise.all(
          LEADERBOARD_BOARDS.map((board) =>
            firestore.doc(`leaderboards/${board}/entries/${uid}`).get(),
          ),
        ),
        questionId
          ? firestore.collection('custom_questions').doc(questionId).get()
          : Promise.resolve(null),
        firestore.collection('customers').doc(uid).get(),
      ]);
      return {
        authUserExists: authUser !== null,
        // True if *any* board still holds an entry — deletion has to clear
        // all of them, and asserting on one would pass while two survived.
        leaderboardExists: leaderboardDoc.some((snapshot) => snapshot.exists),
        customerExists: customerDoc.exists,
        questionExists: questionDoc?.exists ?? false,
        questionCreatedBy: (questionDoc?.data()?.['createdBy'] as string | undefined) ?? null,
      };
    },

    /**
     * Everything currently in `question_reports`, IDs included. Clients are
     * forbidden from reading the collection (a report can quote another
     * user's content), so the Admin SDK is the only way a spec can prove a
     * report actually landed — asserting on the UI alone would pass against
     * a submit handler that writes nothing.
     */
    async getQuestionReports(): Promise<QuestionReportRecord[]> {
      const snapshot = await firestore.collection('question_reports').get();
      return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as QuestionReportRecord);
    },

    async seedLeaderboardEntry(entry: LeaderboardSeed) {
      const board = entry.timeLimit ?? '15';
      await firestore
        .doc(`leaderboards/${board}/entries/${entry.uid}`)
        .set({ createdAt: Date.now(), ...entry, timeLimit: board });
      return null;
    },

    getVerificationLink(email: string) {
      return fetchVerificationLink(email);
    },

    /** Whether the Auth emulator holds a pending PASSWORD_RESET code for this
     * address — the proof a reset request actually reached Auth (H1), and its
     * absence the proof the unknown-address path sent nothing. */
    async hasPendingPasswordReset(email: string) {
      const response = await fetch(
        `http://${AUTH_EMULATOR_HOST}/emulator/v1/projects/${E2E_PROJECT_ID}/oobCodes`,
      );
      const { oobCodes } = (await response.json()) as { oobCodes: OobCode[] };
      return oobCodes.some((code) => code.email === email && code.requestType === 'PASSWORD_RESET');
    },

    /**
     * Simulates what our Stripe webhook handler
     * (functions/src/subscriptions.ts) does after a real checkout completes
     * — sets the `stripeRole: 'pro'` custom claim (what firestore.rules
     * actually checks) and seeds a matching `customers/{uid}/subscriptions`
     * doc (what drives the app's real-time `isProUser` UI signal) — entirely
     * via the Admin SDK, so this particular test path never needs a real
     * Stripe webhook delivery. (Contrast with the *checkout-session
     * creation* half of the flow, which runs for real against the emulated
     * `createCheckoutSession` function — see add-question-pro-gating.cy.ts
     * and pricing.cy.ts.)
     */
    async setProSubscription({ uid }: ProSubscriptionSeed) {
      await auth.setCustomUserClaims(uid, { stripeRole: 'pro' });
      await firestore
        .collection('customers')
        .doc(uid)
        .collection('subscriptions')
        .doc('seed-sub')
        .set({
          status: 'active',
          role: 'pro',
          current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
      return null;
    },

    /**
     * Seeds the `products`/`prices` catalog `SubscriptionService.getProPriceId()`
     * reads to resolve the current Pro price — normally kept in sync by
     * `stripeWebhook` (functions/src/products.ts) from real Stripe
     * `product.*`/`price.*` events, which obviously never fire against the
     * emulator. Idempotent — safe to call once per spec.
     */
    async seedProProduct() {
      await firestore.collection('products').doc('prod_test_pro').set({
        active: true,
        name: 'Pro',
        role: 'pro',
      });
      await firestore
        .collection('products')
        .doc('prod_test_pro')
        .collection('prices')
        .doc('price_test_pro')
        .set({
          active: true,
          currency: 'usd',
          unit_amount: 99,
          type: 'recurring',
          interval: 'month',
        });
      return null;
    },
  });
}
