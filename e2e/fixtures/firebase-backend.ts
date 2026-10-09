import { App } from 'firebase-admin/app';
import { Auth, getAuth } from 'firebase-admin/auth';
import { FieldPath, Firestore, getFirestore } from 'firebase-admin/firestore';
import { FirebaseTarget } from './firebase-target';
import {
  AccountState,
  AccountStateQuery,
  AvatarSeed,
  CallableAnswer,
  CallerIdentity,
  CheckoutSessionRecord,
  CustomQuestionSeed,
  DonationPriceSeed,
  DonationSessionRecord,
  GameplayStatsSeed,
  LEADERBOARD_BOARDS,
  LeaderboardEntryQuery,
  LeaderboardEntryRecord,
  LeaderboardSeed,
  PlayRecord,
  RegionalLeaderboardEntryQuery,
  ProPriceSeed,
  ProSubscriptionSeed,
  QuestionCountersRecord,
  QuestionReportRecord,
  QuestionReportSeed,
  QuestionVoteRecord,
  QuestionVoteSeed,
  QuizSeed,
  ReviewerSeed,
  SignedInCaller,
  VerifiedUserSeed,
  XpSeed,
} from './types';

/**
 * The Functions emulator, where `firebase.json` puts it — the same address
 * `AccountService` connects the app to under `useEmulators`. Only the
 * emulator-only operations below use it.
 */
const FUNCTIONS_EMULATOR_HOST = '127.0.0.1:5001';

/**
 * The key the app's emulator config sends (`FirebaseAppService`). The Auth
 * emulator accepts any value; one is sent because the REST API requires the
 * parameter.
 */
const EMULATOR_API_KEY = 'demo-api-key';

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
  private readonly quizIds = new Set<string>();

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
      ...(seed.photoURL === undefined ? {} : { photoURL: seed.photoURL }),
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
   * Writes one curated quiz straight into `quizzes`, bypassing Firestore rules
   * (`FEAT-024`) — the only way one can be written at all, since no client may.
   *
   * Tracked by id for the preview sweep, which is why a spec seeds its quizzes
   * through here rather than through the collection: a quiz is keyed by
   * nothing else the sweep knows about.
   */
  async seedQuiz(seed: QuizSeed): Promise<void> {
    const { id, ...fields } = seed;
    this.quizIds.add(id);
    await this.firestore
      .collection('quizzes')
      .doc(id)
      .set({
        title: 'An e2e quiz',
        description: '',
        createdBy: 'e2e-curator',
        createdAt: Date.now(),
        isPublished: true,
        ...fields,
      });
  }

  /**
   * The difficulty counters on each of these questions (`FEAT-023`), keyed by
   * id — or `null` for a question whose document is gone.
   *
   * Read through the Admin SDK because the counts are written by a callable
   * that nothing in the DOM waits on: `recordGameResult` is fire-and-forget,
   * so the only evidence it counted a game is the document. Scoped to ids the
   * test seeded, so another worker's games never reach the assertion.
   */
  async getQuestionCounters(ids: string[]): Promise<Record<string, QuestionCountersRecord>> {
    const snapshots = await this.firestore.getAll(
      ...ids.map((id) => this.firestore.collection('custom_questions').doc(id)),
    );
    return Object.fromEntries(
      snapshots.map((snapshot) => [
        snapshot.id,
        snapshot.exists
          ? { answered: snapshot.get('answered'), correct: snapshot.get('correct') }
          : null,
      ]),
    );
  }

  /**
   * Deletes a seeded question outright, the way an author withdrawing it from
   * `/my-questions` would — for the case where it goes between the draw and the
   * end of the game.
   */
  async deleteCustomQuestion(id: string): Promise<void> {
    await this.firestore.collection('custom_questions').doc(id).delete();
  }

  /**
   * Every question one account contributed, exactly as Firestore stores it —
   * for the assertion a rendered card cannot make, which is about a field that
   * is **absent**: a contribution carries its topics as tags and no `category`
   * since topics replaced categories (`FEAT-052`), and no screen shows a
   * category any more, so only the document can say none was written.
   *
   * **Scoped by author**, and the author is an account the test created for
   * itself, so another worker's contributions never reach the assertion. One
   * equality filter, which Firestore's automatic single-field index serves.
   */
  async getContributedQuestions(createdBy: string): Promise<Record<string, unknown>[]> {
    const snapshot = await this.firestore
      .collection('custom_questions')
      .where('createdBy', '==', createdBy)
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
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
   * Writes votes straight into `question_votes`, bypassing Firestore rules
   * (`FEAT-027`).
   *
   * For the votes a test needs that no browser in it can cast: another
   * account's above all, which is what proves the deletion sweep takes the
   * departing account's range and nothing beside it.
   */
  async seedQuestionVotes(votes: QuestionVoteSeed[]): Promise<void> {
    const batch = this.firestore.batch();
    for (const vote of votes) {
      batch.set(
        this.firestore
          .collection('question_votes')
          .doc(vote.id ?? `${vote.uid}_${vote.questionId}`),
        { questionId: vote.questionId, value: vote.value, createdAt: vote.createdAt ?? Date.now() },
      );
    }
    await batch.commit();
  }

  /**
   * One vote by its document id, or `null` when there is none.
   *
   * **Read here rather than off the screen**: the buttons show the player's
   * vote only to that player, and only as a pressed state the client set
   * optimistically before the write landed — so a pressed button proves the
   * tap, not the write. This says what Firestore holds.
   */
  async getQuestionVote(id: string): Promise<QuestionVoteRecord | null> {
    const snapshot = await this.firestore.collection('question_votes').doc(id).get();
    return snapshot.exists ? ({ id, ...snapshot.data() } as QuestionVoteRecord) : null;
  }

  /**
   * Every vote cast under one uid: the ids that start with `{uid}_`, read as
   * the same range `deleteAccount` sweeps (`functions/src/question-votes.ts`).
   * Scoped to one account by its id, so it is safe against the shared emulator.
   */
  async getQuestionVotesOf(uid: string): Promise<QuestionVoteRecord[]> {
    const snapshot = await this.firestore
      .collection('question_votes')
      .where(FieldPath.documentId(), '>=', `${uid}_`)
      .where(FieldPath.documentId(), '<', `${uid}\``)
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as QuestionVoteRecord);
  }

  /**
   * Every vote on these questions, whoever cast it — the only way to say a
   * guest's tap wrote *nothing*, since a guest's uid is not one the test
   * chose. Question ids are unique per test, so filtering on them is the
   * isolation.
   */
  async getQuestionVotesOn(questionIds: string[]): Promise<QuestionVoteRecord[]> {
    const snapshot = await this.firestore
      .collection('question_votes')
      .where('questionId', 'in', questionIds)
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as QuestionVoteRecord);
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
   * Seeds the donation product and three one-time prices, the catalog
   * `DonationService` reads — normally kept in sync by `stripeWebhook`
   * (`functions/src/products.ts`) from real Stripe `product.*`/`price.*`
   * events, which never fire against the emulator.
   *
   * Both `kind: 'donation'` markers are seeded, on the product and on every
   * price, because both are what the client and the Cloud Function check. A
   * seed carrying only one of them would make the tip jar look empty for a
   * reason no test names.
   *
   * Idempotent, and separate from `seedProProduct` so a spec asks for exactly
   * the catalog it means to exercise.
   */
  async seedDonationProduct(prices?: DonationPriceSeed[]): Promise<void> {
    await this.firestore.collection('products').doc('prod_test_coffee').set({
      active: true,
      name: 'Buy me a coffee',
      kind: 'donation',
      role: null,
    });
    const presets = prices ?? [
      { id: 'price_test_coffee_small', currency: 'usd', unitAmount: 200 },
      { id: 'price_test_coffee_medium', currency: 'usd', unitAmount: 500 },
      { id: 'price_test_coffee_large', currency: 'usd', unitAmount: 1000 },
    ];
    await Promise.all(presets.map((price) => this.seedDonationPrice(price)));
  }

  /** Adds one more donation preset — another amount, or another currency. */
  async seedDonationPrice(price: DonationPriceSeed): Promise<void> {
    await this.firestore
      .collection('products')
      .doc('prod_test_coffee')
      .collection('prices')
      .doc(price.id)
      .set({
        active: true,
        currency: price.currency,
        unit_amount: price.unitAmount,
        type: 'one_time',
        kind: 'donation',
      });
  }

  /**
   * Takes the whole donation catalog away — the product and every price under
   * it — so the empty state can be exercised against a real empty catalog
   * rather than a stubbed response.
   *
   * Safe only because `donations.spec.ts` is serial and is the only spec that
   * reads this product; `seedDonationProduct` in its `beforeEach` puts it back
   * for the next test.
   */
  async removeDonationProduct(): Promise<void> {
    const product = this.firestore.collection('products').doc('prod_test_coffee');
    const prices = await product.collection('prices').get();
    await Promise.all(prices.docs.map((price) => price.ref.delete()));
    await product.delete();
  }

  /**
   * Removes a donation preset again.
   *
   * The catalog is global to the emulator — one `products` collection shared
   * by every worker — so a spec that seeds an extra currency has to put it
   * back, or it decides what a later test sees.
   */
  async removeDonationPrice(priceId: string): Promise<void> {
    await this.firestore
      .collection('products')
      .doc('prod_test_coffee')
      .collection('prices')
      .doc(priceId)
      .delete();
  }

  /**
   * The donation-session documents one account has created, as the **client**
   * wrote them.
   *
   * Which preset a click actually sends is not visible from the screen — the
   * redirect target is the same mock URL whichever amount was chosen — so this
   * is the only place that claim can be checked (`CLAUDE.md` §4.6: assert the
   * thing the feature is about, not a proxy for it).
   */
  async getDonationSessions(uid: string): Promise<DonationSessionRecord[]> {
    const sessions = await this.firestore
      .collection('customers')
      .doc(uid)
      .collection('donation_sessions')
      .get();
    return sessions.docs.map((session) => ({
      id: session.id,
      price: session.get('price') as string,
      origin: session.get('origin') as string,
    }));
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

  /**
   * Writes one account's avatar choice, as the `setAvatar` callable would
   * have — and the same way: `mergeFields: ['avatar']`, which replaces that
   * field whole and leaves any totals beside it alone. Through the Admin SDK
   * because `users` has no client write rule (`docs/data-model.md`).
   */
  async seedAvatar({ uid, avatar }: AvatarSeed): Promise<void> {
    await this.firestore.doc(`users/${uid}`).set({ avatar }, { mergeFields: ['avatar'] });
  }

  /**
   * Writes one account's XP (`FEAT-041`) and nothing else: `mergeFields:
   * ['xp']`, so an avatar or totals already on the document stay. Through the
   * Admin SDK because `users` has no client write rule (`docs/data-model.md`);
   * in the app only `recordGameResult` writes it.
   */
  async seedXp({ uid, xp }: XpSeed): Promise<void> {
    await this.firestore.doc(`users/${uid}`).set({ xp }, { mergeFields: ['xp'] });
  }

  /**
   * One account's whole play history (`FEAT-049`), newest first, or an empty
   * list when it has none.
   *
   * **Read through the Admin SDK rather than off the screen, and there is no
   * screen**: nothing in the app renders a play history, by design — the export
   * is where a player sees it. Scoped to one uid by the path itself, so this is
   * safe against the shared emulator without any filtering of its own.
   */
  async getPlayHistory(uid: string): Promise<PlayRecord[]> {
    const snapshot = await this.firestore
      .collection('users')
      .doc(uid)
      .collection('plays')
      .orderBy('at', 'desc')
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as PlayRecord);
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
   * A session for one kind of account, signed by the Auth emulator over its
   * REST API, with the ID token a callable would carry
   * (`caller-gate.spec.ts`).
   *
   * **Emulator-only, and that is what makes it possible at all.** The
   * emulator's `signInWithIdp` takes a fake `id_token` of plain JSON claims for
   * any provider id, and signs a token whose `firebase.sign_in_provider` is
   * that id — so one spec holds a GitHub session, an Apple one and a provider
   * the app does not offer, without driving an OAuth popup or owning an
   * account anywhere. A real project accepts no such token.
   *
   * Every account is unique to the call, and tracked for the sweep like any
   * other this fixture creates.
   */
  async signInAs(identity: CallerIdentity): Promise<SignedInCaller> {
    const host = this.authEmulatorHost('signing in with a fake provider token');
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const email = `caller-${unique}@example.com`;
    const password = 'Str0ngPassw0rd!';

    const call = async (method: string, body: object): Promise<SignedInCaller> => {
      const response = await fetch(
        `http://${host}/identitytoolkit.googleapis.com/v1/accounts:${method}?key=${EMULATOR_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, returnSecureToken: true }),
        },
      );
      const answer = (await response.json()) as {
        localId?: string;
        idToken?: string;
        error?: unknown;
      };
      if (!response.ok || !answer.localId || !answer.idToken) {
        throw new Error(`The Auth emulator refused ${method}: ${JSON.stringify(answer)}`);
      }
      return { uid: answer.localId, idToken: answer.idToken };
    };

    let caller: SignedInCaller;
    switch (identity.kind) {
      case 'anonymous':
        caller = await call('signUp', {});
        break;
      case 'password':
        // Verified through the Admin SDK, then signed in like the app signs in,
        // so the token carries `email_verified: true`; an unverified one is a
        // plain sign-up, which is what the app's own sign-up form produces.
        if (identity.emailVerified) {
          await this.createVerifiedUser({ email, password });
          caller = await call('signInWithPassword', { email, password });
        } else {
          caller = await call('signUp', { email, password });
        }
        break;
      case 'oauth':
        caller = await call('signInWithIdp', {
          requestUri: 'http://localhost',
          returnIdpCredential: true,
          postBody: new URLSearchParams({
            providerId: identity.providerId,
            id_token: JSON.stringify({ sub: unique, email, email_verified: true }),
          }).toString(),
        });
        break;
    }
    this.authUids.add(caller.uid);
    return caller;
  }

  /**
   * Invokes a callable on the Functions emulator the way `httpsCallable` does
   * — a POST of `{ data }`, the ID token as a bearer — and returns its answer
   * whole, the HTTP status included, so a refusal can be asserted by its code.
   *
   * Awaited to the end, unlike the app's fire-and-forget `recordGameResult`:
   * the answer arrives after the function's transaction has committed, so one
   * Admin read afterwards sees what it wrote, with no polling.
   */
  async invokeCallable(name: string, idToken: string, data: unknown): Promise<CallableAnswer> {
    this.authEmulatorHost(`invoking ${name} on the Functions emulator`);
    const response = await fetch(
      `http://${FUNCTIONS_EMULATOR_HOST}/${this.target.projectId}/us-central1/${name}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ data }),
      },
    );
    const body = (await response.json()) as Omit<CallableAnswer, 'status'>;
    return { status: response.status, ...body };
  }

  /**
   * The Auth emulator's address, for the operations here that exist only
   * against it — out-of-band codes, fake provider tokens and the Functions
   * emulator beside it.
   *
   * Read back from the variable `createAdminApp()` set rather than restated
   * here, so there is one answer to "which Auth is this" rather than two that
   * can disagree. Against a real project there is nothing to read: `oobCodes`
   * is a testing endpoint with no real-Auth equivalent short of a live
   * mailbox, which is also why `sign-up-verify` is permanently outside the
   * preview slice (`docs/ci-cd.md` §4.3), and a real project signs no token
   * for a fake provider. Throwing says that, where an undefined host would
   * produce a fetch to `http://undefined/…`.
   */
  private authEmulatorHost(operation: string): string {
    const host = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
    if (!host) {
      throw new Error(
        `No Auth emulator is configured (FIREBASE_AUTH_EMULATOR_HOST is unset), and ${operation} ` +
          'is a testing-only operation of the emulators; there is no equivalent on a real project.',
      );
    }
    return host;
  }

  private async fetchOobCodes(): Promise<OobCode[]> {
    const host = this.authEmulatorHost('reading out-of-band action codes');
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
      quizIds: this.quizIds,
    });
  }
}

interface OobCode {
  email: string;
  requestType: string;
  oobLink: string;
}
