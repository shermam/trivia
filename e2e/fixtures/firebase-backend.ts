import { App } from 'firebase-admin/app';
import { Auth, getAuth } from 'firebase-admin/auth';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { FirebaseTarget } from './firebase-target';
import {
  AccountState,
  AccountStateQuery,
  CustomQuestionSeed,
  LEADERBOARD_BOARDS,
  LeaderboardSeed,
  ProSubscriptionSeed,
  ReviewerSeed,
  VerifiedUserSeed,
} from './types';

/**
 * Admin-SDK seeding, as the `firebase` test fixture exposes it.
 *
 * This is the Playwright counterpart of Cypress's `cy.task` bridge: the same
 * operations, called directly instead of marshalled across a process boundary,
 * because a Playwright test body already runs in Node. Which project they act
 * on is the `FirebaseTarget`'s business, not this class's — see
 * `firebase-target.ts`.
 *
 * **Nothing here resets the backend.** Workers share one emulator, so a
 * blanket wipe would delete state another worker is mid-assertion on. Tests
 * own unique ids instead, which is also the only thing that can work against
 * the real preview project.
 */
export class FirebaseBackend {
  private readonly auth: Auth;
  private readonly firestore: Firestore;

  /** Everything this worker created, for the target's end-of-run sweep. */
  private readonly authUids = new Set<string>();
  private readonly customQuestionIds = new Set<string>();
  private readonly leaderboardUids = new Set<string>();

  constructor(
    private readonly target: FirebaseTarget,
    private readonly app: App,
  ) {
    this.auth = getAuth(app);
    this.firestore = getFirestore(app);
  }

  /** Creates an already-email-verified account, bypassing the mailbox entirely. */
  async createVerifiedUser(seed: VerifiedUserSeed): Promise<{ uid: string }> {
    const user = await this.auth.createUser({
      email: seed.email,
      password: seed.password,
      displayName: seed.displayName,
      emailVerified: true,
    });
    this.authUids.add(user.uid);
    return { uid: user.uid };
  }

  /** Writes documents straight into `custom_questions`, bypassing Firestore rules. */
  async seedCustomQuestions(questions: CustomQuestionSeed[]): Promise<void> {
    await Promise.all(
      questions.map((question, index) => {
        const { id, ...doc } = question;
        const seeded = { status: 'approved', ...doc };
        const docId = id ?? `seed-${index}`;
        this.customQuestionIds.add(docId);
        return this.firestore.collection('custom_questions').doc(docId).set(seeded);
      }),
    );
  }

  /**
   * Simulates what our Stripe webhook handler (`functions/src/subscriptions.ts`)
   * does after a real checkout completes — sets the `stripeRole: 'pro'` custom
   * claim (what `firestore.rules` actually checks) and seeds a matching
   * `customers/{uid}/subscriptions` doc (what drives the app's `isProUser` UI
   * signal) — entirely via the Admin SDK, so this path never needs a real
   * Stripe webhook delivery. Contrast the *checkout-session creation* half of
   * the flow, which runs for real against the emulated `createCheckoutSession`
   * — see `pricing.spec.ts`.
   */
  async setProSubscription({ uid }: ProSubscriptionSeed): Promise<void> {
    await this.auth.setCustomUserClaims(uid, { stripeRole: 'pro' });
    await this.firestore
      .collection('customers')
      .doc(uid)
      .collection('subscriptions')
      .doc('seed-sub')
      .set({
        status: 'active',
        role: 'pro',
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
  }

  /**
   * Seeds the `products`/`prices` catalog `SubscriptionService.getProPriceId()`
   * reads to resolve the current Pro price — normally kept in sync by
   * `stripeWebhook` (`functions/src/products.ts`) from real Stripe
   * `product.*`/`price.*` events, which obviously never fire against the
   * emulator. Idempotent, so every test that needs a price can just ask for
   * one without coordinating with the others.
   */
  async seedProProduct(): Promise<void> {
    await this.firestore.collection('products').doc('prod_test_pro').set({
      active: true,
      name: 'Pro',
      role: 'pro',
    });
    await this.firestore
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
  }

  /**
   * Grants (or explicitly withholds) the moderation role.
   *
   * Through the Admin SDK because that is the only way it can be granted at
   * all — `user_roles` has no client write path, by design
   * (`docs/data-model.md` § `user_roles`).
   */
  async seedReviewer({ uid, reviewer }: ReviewerSeed): Promise<void> {
    await this.firestore.doc(`user_roles/${uid}`).set({ reviewer });
  }

  /** Writes a single board entry, bypassing Firestore rules. */
  async seedLeaderboardEntry(entry: LeaderboardSeed): Promise<void> {
    this.leaderboardUids.add(entry.uid);
    const board = entry.timeLimit ?? '15';
    await this.firestore
      .doc(`leaderboards/${board}/entries/${entry.uid}`)
      .set({ createdAt: Date.now(), ...entry, timeLimit: board });
  }

  /**
   * Reads the state account deletion is supposed to leave behind, in one round
   * trip. Deletion spans Auth, Stripe, the leaderboard and the question bank,
   * and asserting only on the UI would prove nothing about any of them — the
   * whole risk is a step that silently doesn't run.
   */
  async inspectAccountState({ uid, questionId }: AccountStateQuery): Promise<AccountState> {
    const [authUser, leaderboardDocs, questionDoc, customerDoc, statsDoc] = await Promise.all([
      this.auth.getUser(uid).catch(() => null),
      Promise.all(
        LEADERBOARD_BOARDS.map((board) =>
          this.firestore.doc(`leaderboards/${board}/entries/${uid}`).get(),
        ),
      ),
      questionId
        ? this.firestore.collection('custom_questions').doc(questionId).get()
        : Promise.resolve(null),
      this.firestore.collection('customers').doc(uid).get(),
      this.firestore.collection('users').doc(uid).get(),
    ]);
    return {
      authUserExists: authUser !== null,
      // True if *any* board still holds an entry — deletion has to clear all of
      // them, and asserting on one would pass while two survived.
      leaderboardExists: leaderboardDocs.some((snapshot) => snapshot.exists),
      customerExists: customerDoc.exists,
      questionExists: questionDoc?.exists ?? false,
      questionCreatedBy: (questionDoc?.data()?.['createdBy'] as string | undefined) ?? null,
      // The whole document, not a boolean. A test that can only ask "does it
      // exist" cannot tell a correct total from a doubled one — and the
      // double-count on reload is the specific defect `lastGameId` exists to
      // prevent, so the assertion has to be able to read the number.
      gameplayStats: statsDoc.exists ? (statsDoc.data() as Record<string, unknown>) : null,
    };
  }

  /**
   * The most recent pending email-verification link for this address.
   *
   * The Auth emulator never sends real email — instead it exposes pending
   * "out-of-band" action codes (verify-email, password-reset, …) over a
   * testing-only REST endpoint, which is the documented way to drive the real
   * verification flow end to end without a mailbox.
   */
  async getVerificationLink(email: string): Promise<string> {
    const codes = await this.fetchOobCodes();
    const match = [...codes]
      .reverse()
      .find((code) => code.email === email && code.requestType === 'VERIFY_EMAIL');
    if (!match) {
      throw new Error(`No pending email-verification code found for ${email}`);
    }
    return match.oobLink;
  }

  /**
   * Whether the Auth emulator holds a pending PASSWORD_RESET code for this
   * address — the proof a reset request actually reached Auth (H1), and its
   * absence the proof the unknown-address path sent nothing.
   */
  async hasPendingPasswordReset(email: string): Promise<boolean> {
    const codes = await this.fetchOobCodes();
    return codes.some((code) => code.email === email && code.requestType === 'PASSWORD_RESET');
  }

  /**
   * The two operations above are **emulator-only**, and the host is read back
   * from the variable `createAdminApp()` set rather than restated here, so
   * there is one answer to "which Auth is this" rather than two that can
   * disagree. Against a real project there is nothing to read: `oobCodes` is a
   * testing endpoint with no real-Auth equivalent short of a live mailbox,
   * which is also why `sign-up-verify` is permanently outside the preview
   * slice (`docs/ci-cd.md` §4.3). Throwing says that, where an undefined host
   * would produce a fetch to `http://undefined/…`.
   */
  private async fetchOobCodes(): Promise<OobCode[]> {
    const host = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
    if (!host) {
      throw new Error(
        'No Auth emulator is configured (FIREBASE_AUTH_EMULATOR_HOST is unset). Out-of-band ' +
          'action codes are a testing-only endpoint of the Auth emulator; there is no equivalent ' +
          'on a real project.',
      );
    }
    const response = await fetch(
      `http://${host}/emulator/v1/projects/${this.target.projectId}/oobCodes`,
    );
    const { oobCodes } = (await response.json()) as { oobCodes: OobCode[] };
    return oobCodes;
  }

  async cleanup(): Promise<void> {
    await this.target.cleanup(this.app, {
      authUids: this.authUids,
      customQuestionIds: this.customQuestionIds,
      leaderboardUids: this.leaderboardUids,
    });
  }
}

interface OobCode {
  email: string;
  requestType: string;
  oobLink: string;
}
