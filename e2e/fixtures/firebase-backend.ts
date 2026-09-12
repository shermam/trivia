import { App } from 'firebase-admin/app';
import { Auth, getAuth } from 'firebase-admin/auth';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { FirebaseTarget } from './firebase-target';
import {
  AccountState,
  AccountStateQuery,
  CheckoutSessionRecord,
  CustomQuestionSeed,
  GameplayStatsSeed,
  LEADERBOARD_BOARDS,
  LeaderboardEntryQuery,
  LeaderboardEntryRecord,
  LeaderboardSeed,
  RegionalLeaderboardEntryQuery,
  ProPriceSeed,
  ProSubscriptionSeed,
  QuestionReportRecord,
  QuestionReportSeed,
  ReviewerSeed,
  VerifiedUserSeed,
} from './types';

/**
 * Admin-SDK seeding, as the `firebase` test fixture exposes it.
 *
 * The Admin SDK is called directly rather than marshalled across a process
 * boundary, because a Playwright test body already runs in Node. Which project
 * these operations act on is the `FirebaseTarget`'s business, not this
 * class's — see `firebase-target.ts`.
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
   * because the only clients `firestore.rules` lets read `question_reports` are
   * the appointed reviewers (`FEAT-026`) — never the player who filed one, so
   * the UI saying "Reported" proves nothing about the write on its own
   * (finding H4).
   *
   * **Takes the ids rather than reading the collection.** The emulator is
   * shared by every worker in the run, so an unscoped read would return another
   * test's reports and a "no reports were written" assertion would fail for
   * something the test did not do. Question ids are unique per test, so
   * filtering on them *is* the isolation.
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
   * Writes reports straight into `question_reports`, bypassing Firestore rules.
   *
   * For the one thing filing them through the UI cannot reach: a page boundary.
   * The reporting form writes one report per five-minute slot per uid, so
   * twenty-six of them would need twenty-six browser sessions; the reviewer's
   * queue pages at twenty-five.
   *
   * **Emulator-only, like every other report in this suite.** `question_reports`
   * is keyed by nothing the preview sweep tracks, which is why
   * `playwright.preview.config.ts` keeps the specs that write them off the real
   * project rather than trying to clean up after them.
   */
  async seedQuestionReports(reports: QuestionReportSeed[]): Promise<void> {
    const batch = this.firestore.batch();
    for (const { id, ...report } of reports) {
      batch.set(this.firestore.collection('question_reports').doc(id), report);
    }
    await batch.commit();
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
   * Seeds the `products`/`prices` catalog `SubscriptionService.getProPrices()`
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
    await this.seedProPrice({ id: 'price_test_pro', currency: 'usd', unitAmount: 99 });
  }

  /**
   * Adds another monthly price to the seeded Pro product — one more currency
   * the pricing page can offer.
   *
   * Separate from `seedProProduct` so the single-currency catalog stays the
   * default: most specs want a Pro tier that is on sale, not a currency
   * choice, and a second price would put a control in front of every one of
   * them.
   */
  async seedProPrice(price: ProPriceSeed): Promise<void> {
    await this.firestore
      .collection('products')
      .doc('prod_test_pro')
      .collection('prices')
      .doc(price.id)
      .set({
        active: true,
        currency: price.currency,
        unit_amount: price.unitAmount,
        type: 'recurring',
        interval: 'month',
      });
  }

  /**
   * Removes a price from the seeded Pro product again.
   *
   * The catalog is global to the emulator — one `products` collection shared
   * by every worker — so a spec that seeds a second currency has to put the
   * catalog back, or it decides what a later test sees.
   */
  async removeProPrice(priceId: string): Promise<void> {
    await this.firestore
      .collection('products')
      .doc('prod_test_pro')
      .collection('prices')
      .doc(priceId)
      .delete();
  }

  /**
   * The checkout-session documents one account has created, as the **client**
   * wrote them.
   *
   * Which price ID a currency choice actually sends is not visible from the
   * screen — the redirect target is the same mock URL either way — so this is
   * the only place that claim can be checked (`CLAUDE.md` §4.6: assert the
   * thing the feature is about, not a proxy for it).
   */
  async getCheckoutSessions(uid: string): Promise<CheckoutSessionRecord[]> {
    const sessions = await this.firestore
      .collection('customers')
      .doc(uid)
      .collection('checkout_sessions')
      .get();
    return sessions.docs.map((session) => ({
      id: session.id,
      price: session.get('price') as string,
      origin: session.get('origin') as string,
    }));
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

  /**
   * Writes one account's lifetime totals, as the `recordGameResult` callable
   * would have.
   *
   * Through the Admin SDK because that is the only way they can be written at
   * all — `users` has no client write rule, by design (`docs/data-model.md`).
   * Nothing is tracked here beyond the uid the caller already created:
   * `users/{uid}` is keyed by the account, so the preview sweep reaches it by
   * walking `authUids`.
   */
  async seedGameplayStats({ uid, ...totals }: GameplayStatsSeed): Promise<void> {
    await this.firestore.doc(`users/${uid}`).set({ ...totals, updatedAt: Date.now() });
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
   * One account's entry on one board, or `null` when it has none.
   *
   * **A spec asserting that a score was saved has to read it here rather than
   * off the screen.** The board renders the top ten by score, and against the
   * real `trivimind-dev` project that is a shared, permanent ranking that only
   * ever grows — so "my row is visible" is a claim about everybody else's
   * scores as much as about the save under test, and it stops being true the
   * moment ten better entries exist. Reading the document says exactly what
   * the app wrote, for exactly the account the test created, whatever else is
   * on the board.
   */
  async getLeaderboardEntry({
    uid,
    timeLimit = '15',
  }: LeaderboardEntryQuery): Promise<LeaderboardEntryRecord | null> {
    const snapshot = await this.firestore.doc(`leaderboards/${timeLimit}/entries/${uid}`).get();
    return snapshot.exists ? (snapshot.data() as LeaderboardEntryRecord) : null;
  }

  /**
   * One account's entry on one *country* board (`FEAT-028`), or `null`.
   *
   * Read back rather than looked for on screen for the reason above, and one
   * more that only applies here: a spec proving a score reached Brazil's board
   * and not Portugal's is asserting about two collections, and the second half
   * — "it is *not* there" — cannot be shown by a screen that is only ever
   * displaying one of them.
   */
  async getRegionalLeaderboardEntry({
    uid,
    region,
    timeLimit = '15',
  }: RegionalLeaderboardEntryQuery): Promise<LeaderboardEntryRecord | null> {
    const snapshot = await this.firestore
      .doc(`leaderboards/${timeLimit}/regions/${region}/entries/${uid}`)
      .get();
    return snapshot.exists ? (snapshot.data() as LeaderboardEntryRecord) : null;
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
