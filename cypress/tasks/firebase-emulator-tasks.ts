import { App, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { CollectionReference, getFirestore } from 'firebase-admin/firestore';
import { E2E_PROJECT_ID } from '../../cypress.config';
import {
  CustomQuestionSeed,
  LeaderboardSeed,
  ProSubscriptionSeed,
  VerifiedUserSeed,
} from './types';

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
        deleteCollection(firestore.collection('custom_questions')),
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
          return firestore
            .collection('custom_questions')
            .doc(id ?? `seed-${index}`)
            .set(doc);
        }),
      );
      return null;
    },

    async seedLeaderboardEntry(entry: LeaderboardSeed) {
      await firestore
        .collection('leaderboard')
        .doc(entry.uid)
        .set({ createdAt: Date.now(), ...entry });
      return null;
    },

    getVerificationLink(email: string) {
      return fetchVerificationLink(email);
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
