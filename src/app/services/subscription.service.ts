import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { pollUntil } from '../utils/poll-until.util';
import { AuthService } from './auth.service';
import {
  FirestoreRestClient,
  isFirestorePermissionDenied,
} from './firestore-rest/firestore-rest.client';

const CUSTOMERS_COLLECTION = 'customers';
const PRODUCTS_COLLECTION = 'products';
const CHECKOUT_TIMEOUT_MS = 20_000;

/**
 * How often to re-read a session document while waiting for the Cloud Function
 * to write its URL back, and for how long in total.
 *
 * This replaces an `onSnapshot` listener, because REST has no equivalent
 * (`FIRESTORE_SDK_VS_REST.md` §4). The trade is arithmetic: a checkout costs up
 * to 40 reads instead of about 2. That is irrelevant at any volume this app
 * will see — checkout is rare by definition, and a listener was never free
 * either, billing the initial read plus every change delivered for as long as
 * the tab stayed open.
 *
 * 500 ms rather than the 1 s the design document sketched, because this delay
 * is in front of a user who has just clicked Subscribe and is looking at a
 * spinner.
 */
const SESSION_POLL_INTERVAL_MS = 500;

/**
 * The wait after returning from Stripe, on `/pricing?checkout=success`.
 *
 * A full page load happens between paying and landing back here, so the
 * read-on-load below would normally be enough — except that the `stripeWebhook`
 * delivery which writes the subscription document races that redirect and
 * sometimes loses. A listener papered over this by definition. One second is
 * unhurried here: the user is reading a confirmation, not waiting on a click.
 */
const PRO_ACTIVATION_POLL_INTERVAL_MS = 1_000;
const PRO_ACTIVATION_TIMEOUT_MS = 20_000;

/**
 * `firestore.rules` caps how many session documents one account can create —
 * and therefore how many Cloud Function invocations and Stripe API calls it
 * can trigger — by constraining the document ID to `{window}-{slot}`, where
 * the window is derived from *server* time and `create` (unlike a general
 * write) only ever applies to an ID that doesn't exist yet. Rules cannot count
 * a user's documents, so the ID is the only place the cap can live; these two
 * constants have to match `sessionWindow`/`isRateLimitedSessionId` there.
 */
const SESSION_WINDOW_MS = 300_000;
const SESSION_SLOTS_PER_WINDOW = 10;

/** Subscription statuses our Cloud Functions backend considers "currently paying". */
const ACTIVE_SUBSCRIPTION_STATUSES = ['trialing', 'active'] as const;

/**
 * The role a subscription must carry to mean *Pro*, mirroring the server.
 *
 * A status alone is not entitlement. `stripeWebhook` derives the `stripeRole`
 * claim from `deriveClaimRole(status, priceRole)` (`functions/src/role.ts`),
 * which returns `null` when the price carries no `firebaseRole` metadata — so
 * an active subscription on an unlabelled price grants **nothing**, and
 * `firestore.rules` refuses every privileged write from that account. A UI
 * signal that looked only at `status` therefore unlocked a form the server was
 * always going to reject, with no way for the user to tell why. Same
 * correction as `getProPriceId()` below, which already selects by role
 * "matching the server" — this half was simply missed.
 */
const PRO_ROLE = 'pro';

/**
 * Ceilings on the price lookup, so neither of its queries is unbounded
 * (`CLAUDE.md` §4.1 — every read needs a `where` *and* a `limit`).
 *
 * `MAX_PRO_PRODUCTS` matches the server's own cap in
 * `functions/src/products.ts`, because both are asking the same question of the
 * same collection and disagreeing about the answer's size would be a bug
 * neither side could see. There is one Pro product today; the cap only exists
 * so a Dashboard mistake can't turn this into an unbounded read.
 */
const MAX_PRO_PRODUCTS = 5;
const MAX_PRICES_PER_PRODUCT = 20;

/**
 * A ceiling the `onSnapshot` version never had. The query was filtered by
 * status but not bounded, which §4.1 asks for on every read — a listener on an
 * unbounded query re-reads the whole result set on every reconnect. One
 * customer holds one or two subscription documents; twenty is a cap that only
 * a bug could reach.
 */
const MAX_SUBSCRIPTIONS_PER_CUSTOMER = 20;

/** What the Cloud Function eventually writes back onto a session document. */
interface SessionOutcome {
  url?: string;
  error?: string;
}

/**
 * Bridges the client to our own Cloud Functions backend (`functions/`,
 * `createCheckoutSession` + `stripeWebhook`) purely through the Firestore
 * collections that backend manages (`customers/{uid}/checkout_sessions`,
 * `customers/{uid}/subscriptions`, `products/{id}/prices`). This used to be
 * the officially maintained "Run Subscriptions with Stripe" Firebase
 * Extension, but that entire product line is shutting down in March 2027 —
 * we now own equivalent functions directly instead, using the same
 * Firestore schema so this service (and firestore.rules) didn't need to
 * change shape, only where the data comes from.
 *
 * `isProUser` here is an *optimistic* signal — the subscription document
 * appears within moments of a successful checkout, well before the next
 * natural ID-token refresh. It's meant for UI only: the actual security gate
 * for privileged writes is the `stripeRole` custom claim enforced in
 * firestore.rules (`AuthService.isProUser`), which this service explicitly
 * nudges to refresh the moment it first sees an active subscription — see
 * `refreshIdToken()` in AuthService.
 *
 * **It used to be real-time and no longer is** (`BACKLOG.md` item 2). Two
 * `onSnapshot` listeners were the last thing holding the 558.98 kB Firestore
 * SDK in the bundle, and REST has no equivalent, so both became reads:
 * subscription status is read when the signed-in user changes and again after
 * returning from checkout, and the checkout handshake polls. What is lost is
 * a second tab updating without a reload, for a tier whose only entitlement is
 * an "Add a question" link. What is gained is the largest thing this app
 * shipped.
 */
@Injectable({ providedIn: 'root' })
export class SubscriptionService {
  private readonly authService = inject(AuthService);
  private readonly rest = inject(FirestoreRestClient);

  private readonly hasActiveSubscriptionDocSignal = signal(false);
  private trackedUid: string | null = null;
  private proPricePromise: Promise<string> | null = null;

  /**
   * Orders concurrent reads of the same subcollection.
   *
   * `onSnapshot` delivered one stream in commit order, so this could not
   * arise. Reads can: on `/pricing?checkout=success` the constructor effect's
   * read and `awaitProActivation`'s poll are both in flight against the same
   * documents, and without a sequence the answer that lands last wins even
   * when it is the older question. The visible symptom would be Pro flickering
   * back off on the very page confirming the payment. Each read takes a ticket
   * before it starts; `applyProState` refuses one older than what it has
   * already applied.
   */
  private readSequence = 0;
  private appliedSequence = 0;

  readonly isProUser = computed(
    () => this.authService.isProUser() || this.hasActiveSubscriptionDocSignal(),
  );

  constructor() {
    effect(() => {
      const user = this.authService.user();
      this.trackUser(user && !user.isAnonymous ? user.uid : null);
    });
  }

  private trackUser(uid: string | null): void {
    if (uid === this.trackedUid) {
      return;
    }
    this.trackedUid = uid;
    this.hasActiveSubscriptionDocSignal.set(false);

    if (uid) {
      void this.refreshSubscriptionState(uid);
    }
  }

  /**
   * Re-reads whether this user currently has an active Pro subscription.
   *
   * Swallows its own failures deliberately. A read that fails leaves the
   * optimistic signal `false`, and the consequence of that is small precisely
   * because the signal is not the gate: `isProUser` is `claim || document`, so
   * a subscriber whose ID token already carries `stripeRole` still reads as Pro
   * with this half unavailable. The listener this replaces retried internally;
   * nothing here does, which is the honest cost of owning the transport.
   */
  private async refreshSubscriptionState(uid: string): Promise<void> {
    const sequence = ++this.readSequence;
    try {
      this.applyProState(uid, await this.readHasActiveProSubscription(uid), sequence);
    } catch {
      // See above — the claim is the authority, this is only the fast path.
    }
  }

  private async readHasActiveProSubscription(uid: string): Promise<boolean> {
    const documents = await this.rest.runQuery(
      {
        collectionPath: `${CUSTOMERS_COLLECTION}/${uid}/subscriptions`,
        where: [{ field: 'status', op: 'IN', value: [...ACTIVE_SUBSCRIPTION_STATUSES] }],
        limit: MAX_SUBSCRIPTIONS_PER_CUSTOMER,
      },
      { timeoutMs: CHECKOUT_TIMEOUT_MS },
    );
    // `role` is filtered here rather than in the query on purpose:
    // `where('status','in',…)` plus `where('role','==',…)` needs a composite
    // index, and index configuration is the one thing the emulator cannot
    // verify (finding D3 took the deploy pipeline down for four merges). This
    // subcollection holds a handful of documents for one user and is already
    // bounded by the status filter and the limit above, so the check costs
    // nothing to do in memory.
    return documents.some((document) => document.data['role'] === PRO_ROLE);
  }

  private applyProState(uid: string, isActive: boolean, sequence: number): void {
    // Two axes of staleness, and both have to be checked: the signed-in user
    // may have changed while the read was in flight, and an older read may be
    // landing after a newer one has already answered.
    if (this.trackedUid !== uid || sequence < this.appliedSequence) {
      return;
    }
    this.appliedSequence = sequence;
    const justActivated = isActive && !this.hasActiveSubscriptionDocSignal();
    this.hasActiveSubscriptionDocSignal.set(isActive);
    if (justActivated) {
      void this.authService.refreshIdToken();
    }
  }

  /**
   * Waits for a just-completed checkout to show up as Pro, called by
   * `PricingComponent` when Stripe redirects back to `?checkout=success`.
   *
   * Resolves as soon as the subscription document lands, or gives up quietly
   * at the deadline — in which case the user is a reload away from correct,
   * and `stripeRole` on their next token refresh gets there on its own.
   */
  async awaitProActivation(): Promise<void> {
    await pollUntil(
      async () => {
        const uid = this.trackedUid;
        // Auth persistence may still be restoring the session this page load —
        // "no user yet" is a not-yet, not an answer.
        if (!uid) {
          return null;
        }
        const sequence = ++this.readSequence;
        try {
          if (!(await this.readHasActiveProSubscription(uid))) {
            return null;
          }
        } catch {
          // A failed read here is also a not-yet: this is polling for a webhook
          // that has not landed, on a page the user will sit on for a few
          // seconds either way.
          return null;
        }
        this.applyProState(uid, true, sequence);
        return true;
      },
      { intervalMs: PRO_ACTIVATION_POLL_INTERVAL_MS, timeoutMs: PRO_ACTIVATION_TIMEOUT_MS },
    );
  }

  /**
   * Resolves the Stripe Price ID for the single active monthly "Pro"
   * product by reading the `products`/`prices` collections the webhook
   * handler (`functions/src/products.ts`) keeps synced from the Stripe
   * Dashboard, so the price never has to be hardcoded here — changing the
   * price in Stripe doesn't require a frontend deploy.
   *
   * **Selects by `role`, matching the server.** `createCheckoutSession` accepts
   * a price only if it belongs to an active product carrying `role: 'pro'`
   * (`functions/src/checkout-request.ts`), so picking by "first active product
   * with a monthly price" — as this used to — is a different question with the
   * same answer only while exactly one product exists. The day a second one is
   * added, the client would send a price the server is bound to reject, and the
   * failure would surface as checkout simply not working.
   *
   * **Both queries are bounded and the per-product ones run in parallel.**
   * Neither carried a `limit` before, and the price lookups ran one after
   * another (finding C5).
   */
  private getProPriceId(): Promise<string> {
    if (!this.proPricePromise) {
      this.proPricePromise = this.loadProPriceId();
      // Don't cache a failed lookup: a product fixed in the Dashboard after
      // a failed attempt should be picked up on the very next click, not
      // require a full page reload.
      this.proPricePromise.catch(() => {
        this.proPricePromise = null;
      });
    }
    return this.proPricePromise;
  }

  private async loadProPriceId(): Promise<string> {
    // Filters on `role` alone, exactly as the server's own catalog check does
    // (`functions/src/products.ts`): one equality filter is served by the
    // automatic single-field index, while `role` + `active` together would
    // need a composite one. `active` is checked below instead, which costs
    // nothing extra since the document is already here.
    const products = await this.rest.runQuery(
      {
        collectionPath: PRODUCTS_COLLECTION,
        where: [{ field: 'role', op: 'EQUAL', value: PRO_ROLE }],
        limit: MAX_PRO_PRODUCTS,
      },
      { timeoutMs: CHECKOUT_TIMEOUT_MS },
    );

    const activeProducts = products.filter((product) => product.data['active'] === true);

    // Every product's prices are fetched at once. This used to be a sequential
    // `for` loop that awaited each subcollection in turn (finding C5), so the
    // wait was the sum of the round trips rather than the slowest one — and it
    // ran on the click that starts checkout, where the delay is most visible.
    const monthlyPriceIds = await Promise.all(
      activeProducts.map(async (product) => {
        const prices = await this.rest.runQuery(
          {
            collectionPath: `${PRODUCTS_COLLECTION}/${product.id}/prices`,
            where: [{ field: 'active', op: 'EQUAL', value: true }],
            limit: MAX_PRICES_PER_PRODUCT,
          },
          { timeoutMs: CHECKOUT_TIMEOUT_MS },
        );
        return prices.find((price) => price.data['interval'] === 'month')?.id ?? null;
      }),
    );

    // First match in catalog order, not first to resolve — parallelism must
    // not make which price is chosen depend on network timing.
    const proPriceId = monthlyPriceIds.find((priceId) => priceId !== null);
    if (!proPriceId) {
      throw new Error('No active monthly Pro price found — check the Stripe Dashboard setup.');
    }
    return proPriceId;
  }

  /**
   * Creates a Stripe Checkout session doc, waits for `createCheckoutSession`
   * (functions/src/checkout-sessions.ts) to write back a hosted checkout
   * URL, and redirects the browser to it. Requires a
   * fully signed-in (non-anonymous) caller — also enforced by
   * firestore.rules, but checked here first so an anonymous caller never
   * even creates a doc that would just be rejected.
   *
   * The payload is deliberately only `price` and `origin`. The redirect URLs
   * and the checkout mode used to be sent from here and handed to Stripe
   * verbatim; the function decides both itself now, so there is nothing left
   * on this path for a hand-written document to redirect or re-price.
   */
  async startProCheckout(): Promise<void> {
    const checkoutUrl = await this.runSessionHandshake({
      collectionName: 'checkout_sessions',
      // A factory, not a value, so the price lookup only happens once the
      // caller has been confirmed signed in — an anonymous click should cost
      // a catalog read no more than it should cost a rejected write.
      buildPayload: async () => ({
        price: await this.getProPriceId(),
        origin: window.location.origin,
      }),
      signedOutMessage: 'Sign in before subscribing.',
      timeoutMessage: 'Timed out waiting for Stripe checkout to start.',
      failureMessage: 'Stripe checkout could not be started.',
    });
    window.location.assign(checkoutUrl);
  }

  /**
   * Creates a Stripe billing portal session doc, waits for
   * `createPortalSession` (functions/src/billing-portal.ts) to write back a
   * hosted portal URL, and redirects the browser to it — lets a Pro
   * subscriber manage their payment method or cancel from Stripe's own UI.
   * Same doc-create-then-poll handshake as `startProCheckout` above.
   */
  async openBillingPortal(): Promise<void> {
    const portalUrl = await this.runSessionHandshake({
      collectionName: 'portal_sessions',
      buildPayload: () => ({ origin: window.location.origin }),
      signedOutMessage: 'Sign in before managing your subscription.',
      timeoutMessage: 'Timed out waiting for the billing portal to open.',
      failureMessage: 'Billing portal could not be opened.',
    });
    window.location.assign(portalUrl);
  }

  /**
   * The create-then-wait half both flows share: write a session document, wait
   * for the Cloud Function to write a `url` (or an `error`) back onto it, and
   * return that URL. Both sides of the handshake are identical for checkout
   * and the billing portal, so they share one implementation rather than two
   * that can drift.
   *
   * The deadline used to be the delicate part. With `onSnapshot` it had to live
   * *inside* the promise rather than racing it from outside, because giving up
   * had to also mean detaching the listener — racing left the subscription
   * attached for the rest of the session, still receiving writes and still
   * billed for them, for a checkout nobody was waiting on. Polling has nothing
   * to detach: when `pollUntil` returns, the last request has already
   * completed and no timer is armed. That whole class of bug is gone by
   * construction rather than by care.
   */
  private async runSessionHandshake(options: {
    collectionName: 'checkout_sessions' | 'portal_sessions';
    buildPayload: () => Record<string, string> | Promise<Record<string, string>>;
    signedOutMessage: string;
    timeoutMessage: string;
    failureMessage: string;
  }): Promise<string> {
    const user = this.authService.user();
    if (!user || user.isAnonymous) {
      throw new Error(options.signedOutMessage);
    }

    const payload = await options.buildPayload();
    const sessionPath = await this.createSessionDoc(user.uid, options.collectionName, payload);

    // A read that fails is a not-yet, not a failure. The document is about to
    // be written and there is budget left to ask again, and `onSnapshot`
    // reconnected through a transient drop by itself — turning the payment
    // path into one-strike would be a regression the migration has no reason
    // to cause. The last error is kept rather than swallowed, so a deadline
    // reached while reads were failing reports *that* instead of narrating a
    // timeout it did not verify (`CLAUDE.md` §4.4); a read that succeeds
    // clears it, so only an unresolved failure is ever reported.
    let lastReadError: Error | null = null;
    const outcome = await pollUntil(
      async (remainingMs) => {
        try {
          const result = await this.readSessionOutcome(
            sessionPath,
            options.failureMessage,
            remainingMs,
          );
          lastReadError = null;
          return result;
        } catch (error) {
          lastReadError = error instanceof Error ? error : new Error(String(error));
          return null;
        }
      },
      { intervalMs: SESSION_POLL_INTERVAL_MS, timeoutMs: CHECKOUT_TIMEOUT_MS },
    );

    if (!outcome) {
      throw lastReadError ?? new Error(options.timeoutMessage);
    }
    if (outcome.error) {
      throw new Error(outcome.error);
    }
    return outcome.url!;
  }

  /**
   * One look at a session document: the URL if it has arrived, the failure if
   * the function reported one, and `null` for "still working" — which is both
   * the document not existing yet and it existing with neither field set.
   */
  private async readSessionOutcome(
    sessionPath: string,
    failureMessage: string,
    remainingMs: number,
  ): Promise<SessionOutcome | null> {
    // The budget left, not the whole budget. Giving each read the full
    // `CHECKOUT_TIMEOUT_MS` composes two 20-second bounds into forty seconds of
    // wall clock, because an attempt that starts at 19.5s is still allowed its
    // own twenty — and the constant, the comments and the user-facing message
    // all say twenty.
    const document = await this.rest.getDocument(sessionPath, {
      timeoutMs: remainingMs,
    });
    const data = document?.data;
    if (!data) {
      return null;
    }
    const error = data['error'] as { message?: string } | undefined;
    if (error) {
      return { error: error.message ?? failureMessage };
    }
    return typeof data['url'] === 'string' ? { url: data['url'] } : null;
  }

  /**
   * Writes the session document at an ID the volume cap in `firestore.rules`
   * accepts: `{current 5-minute window}-{slot}`, and returns its path.
   *
   * Slots are tried from a random starting point, so two checkouts inside the
   * same window don't both collide on slot 0 — a rejected slot is one that has
   * already been used this window, which for a real user only happens if they
   * genuinely started checkout twice in five minutes. Running out of all ten
   * is the cap actually biting.
   *
   * The message deliberately doesn't name a cause. A refusal here has two
   * plausible ones — every slot used, or a client old enough to still be
   * sending the pre-validation payload — and picking one to narrate would be
   * wrong half the time. Reloading and retrying is the answer to both.
   */
  private async createSessionDoc(
    uid: string,
    collectionName: string,
    payload: Record<string, string>,
  ): Promise<string> {
    const currentWindow = Math.floor(Date.now() / SESSION_WINDOW_MS);
    const firstSlot = Math.floor(Math.random() * SESSION_SLOTS_PER_WINDOW);

    for (let attempt = 0; attempt < SESSION_SLOTS_PER_WINDOW; attempt++) {
      const slot = (firstSlot + attempt) % SESSION_SLOTS_PER_WINDOW;
      const sessionPath = `${CUSTOMERS_COLLECTION}/${uid}/${collectionName}/${currentWindow}-${slot}`;
      try {
        await this.rest.setDocument(sessionPath, payload, { timeoutMs: CHECKOUT_TIMEOUT_MS });
        return sessionPath;
      } catch (error) {
        if (!isFirestorePermissionDenied(error)) {
          throw error;
        }
      }
    }

    throw new Error('Too many attempts just now. Reload the page and try again in a few minutes.');
  }
}
