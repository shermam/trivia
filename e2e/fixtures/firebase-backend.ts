import { App } from 'firebase-admin/app';
import { Auth, getAuth } from 'firebase-admin/auth';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { FirebaseTarget } from './firebase-target';
import {
  CustomQuestionSeed,
  ProSubscriptionSeed,
  QuestionReportRecord,
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

  /**
   * Records uids the **browser** brought into existence, as
   * `e2e/support/auth-uid-tracker.ts` observes them being persisted.
   *
   * Finding C6. `createVerifiedUser` above knows about the accounts a test asks
   * for by name, which against the preview project are the minority: every page
   * load signs in anonymously, and a sign-out mints another. Those are the
   * accounts that accumulate, so the sweep has to hear about them too.
   */
  trackAuthUids(uids: Iterable<string>): void {
    for (const uid of uids) {
      this.authUids.add(uid);
    }
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
   * The reports filed against these questions, read through the Admin SDK
   * because `firestore.rules` forbids **every** client read of
   * `question_reports` — so the UI saying "Reported" proves nothing about the
   * write on its own (finding H4).
   *
   * **Takes the ids rather than reading the collection**, which is the one way
   * it differs from the Cypress task it replaces. That task read every document
   * and could, because `resetBackend()` had just emptied the emulator. Here the
   * emulator is shared by every worker in the run, so an unscoped read would
   * return another test's reports and an `expect(reports).toHaveLength(0)`
   * would fail for something the test did not do. Question ids are unique per
   * test, so filtering on them *is* the isolation.
   */
  async getQuestionReports(questionIds: string[]): Promise<QuestionReportRecord[]> {
    if (questionIds.length === 0) {
      return [];
    }
    const snapshot = await this.firestore
      .collection('question_reports')
      .where('questionId', 'in', questionIds)
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as QuestionReportRecord);
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

  async cleanup(): Promise<void> {
    await this.target.cleanup(this.app, {
      authUids: this.authUids,
      customQuestionIds: this.customQuestionIds,
    });
  }
}
