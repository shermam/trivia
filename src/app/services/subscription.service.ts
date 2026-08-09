import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { DocumentReference, Firestore } from 'firebase/firestore';
import { giveUpAfter } from '../utils/give-up-after.util';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase.service';

const CUSTOMERS_COLLECTION = 'customers';
const PRODUCTS_COLLECTION = 'products';
const CHECKOUT_TIMEOUT_MS = 20_000;

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
 * Ceilings on the price lookup, so neither of its queries is unbounded
 * (`CLAUDE.md` §4.1 — every `getDocs` needs a `where` *and* a `limit`).
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
 * `isProUser` here is a *real-time, optimistic* signal — the subscription
 * doc this listens to appears within moments of a successful checkout,
 * well before the next natural ID-token refresh. It's meant for UI only:
 * the actual security gate for privileged writes is the `stripeRole`
 * custom claim enforced in firestore.rules (`AuthService.isProUser`), which
 * this service explicitly nudges to refresh the moment a subscription doc
 * goes active — see `refreshIdToken()` in AuthService.
 */
@Injectable({ providedIn: 'root' })
export class SubscriptionService {
  private readonly authService = inject(AuthService);
  private readonly firebaseService = inject(FirebaseService);

  private readonly hasActiveSubscriptionDocSignal = signal(false);
  private unsubscribeFromSubscriptions: (() => void) | null = null;
  private subscribedUid: string | null = null;
  private proPricePromise: Promise<string> | null = null;

  readonly isProUser = computed(
    () => this.authService.isProUser() || this.hasActiveSubscriptionDocSignal(),
  );

  constructor() {
    effect(() => {
      const user = this.authService.user();
      this.listenToSubscriptions(user && !user.isAnonymous ? user.uid : null);
    });
  }

  private listenToSubscriptions(uid: string | null): void {
    if (uid === this.subscribedUid) {
      return;
    }
    this.unsubscribeFromSubscriptions?.();
    this.unsubscribeFromSubscriptions = null;
    this.subscribedUid = uid;
    this.hasActiveSubscriptionDocSignal.set(false);

    if (!uid) {
      return;
    }

    void this.firebaseService.getFirestore().then(({ firestore, firestoreModule }) => {
      // The signed-in user may have changed again while this promise was
      // in flight — don't attach a listener for a uid we've since moved on
      // from.
      if (this.subscribedUid !== uid) {
        return;
      }
      const subscriptionsQuery = firestoreModule.query(
        firestoreModule.collection(firestore, CUSTOMERS_COLLECTION, uid, 'subscriptions'),
        firestoreModule.where('status', 'in', [...ACTIVE_SUBSCRIPTION_STATUSES]),
      );
      this.unsubscribeFromSubscriptions = firestoreModule.onSnapshot(
        subscriptionsQuery,
        (snapshot) => {
          const isActive = !snapshot.empty;
          const justActivated = isActive && !this.hasActiveSubscriptionDocSignal();
          this.hasActiveSubscriptionDocSignal.set(isActive);
          if (justActivated) {
            void this.authService.refreshIdToken();
          }
        },
      );
    });
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
      this.proPricePromise = this.firebaseService
        .getFirestore()
        .then(async ({ firestore, firestoreModule: fm }) => {
          // Filters on `role` alone, exactly as the server's own catalog check
          // does (`functions/src/products.ts`): one equality filter is served
          // by the automatic single-field index, while `role` + `active`
          // together would need a composite one. `active` is checked below
          // instead, which costs nothing extra since the document is already
          // here.
          const productsSnapshot = await giveUpAfter(
            fm.getDocs(
              fm.query(
                fm.collection(firestore, PRODUCTS_COLLECTION),
                fm.where('role', '==', 'pro'),
                fm.limit(MAX_PRO_PRODUCTS),
              ),
            ),
            CHECKOUT_TIMEOUT_MS,
          );

          const activeProducts = productsSnapshot.docs.filter(
            (productDoc) => productDoc.data()['active'] === true,
          );

          // Every product's prices are fetched at once. This used to be a
          // sequential `for` loop that awaited each subcollection in turn
          // (finding C5), so the wait was the sum of the round trips rather
          // than the slowest one — and it ran on the click that starts
          // checkout, where the delay is most visible.
          const monthlyPriceIds = await Promise.all(
            activeProducts.map(async (productDoc) => {
              const pricesSnapshot = await giveUpAfter(
                fm.getDocs(
                  fm.query(
                    fm.collection(productDoc.ref, 'prices'),
                    fm.where('active', '==', true),
                    fm.limit(MAX_PRICES_PER_PRODUCT),
                  ),
                ),
                CHECKOUT_TIMEOUT_MS,
              );
              return (
                pricesSnapshot.docs.find((priceDoc) => priceDoc.data()['interval'] === 'month')
                  ?.id ?? null
              );
            }),
          );

          // First match in catalog order, not first to resolve — parallelism
          // must not make which price is chosen depend on network timing.
          const proPriceId = monthlyPriceIds.find((priceId) => priceId !== null);
          if (!proPriceId) {
            throw new Error(
              'No active monthly Pro price found — check the Stripe Dashboard setup.',
            );
          }
          return proPriceId;
        });
      // Don't cache a failed lookup: a product fixed in the Dashboard after
      // a failed attempt should be picked up on the very next click, not
      // require a full page reload.
      this.proPricePromise.catch(() => {
        this.proPricePromise = null;
      });
    }
    return this.proPricePromise;
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
   * Same doc-create-then-listen handshake as `startProCheckout` above.
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
   * The create-then-listen half both flows share: write a session document,
   * wait for the Cloud Function to write a `url` (or an `error`) back onto it,
   * and return that URL. Both sides of the handshake are identical for
   * checkout and the billing portal, so they share one implementation rather
   * than two that can drift.
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

    const [{ firestore, firestoreModule }, payload] = await Promise.all([
      this.firebaseService.getFirestore(),
      options.buildPayload(),
    ]);
    const sessionRef = await this.createSessionDoc(
      firestore,
      firestoreModule,
      user.uid,
      options.collectionName,
      payload,
    );

    // The deadline lives inside the promise rather than racing it from
    // outside, because giving up on this handshake has to mean detaching the
    // listener. Racing left the `onSnapshot` subscription attached for the rest
    // of the session — still receiving writes, and still billed for them, for a
    // checkout nobody was waiting on any more.
    return new Promise<string>((resolve, reject) => {
      let unsubscribe: (() => void) | null = null;
      let settled = false;

      const finish = (outcome: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        unsubscribe?.();
        outcome();
      };

      const timeoutHandle = setTimeout(
        () => finish(() => reject(new Error(options.timeoutMessage))),
        CHECKOUT_TIMEOUT_MS,
      );

      unsubscribe = firestoreModule.onSnapshot(
        sessionRef,
        (snapshot) => {
          const data = snapshot.data() as
            { url?: string; error?: { message?: string } } | undefined;
          if (data?.error) {
            const message = data.error.message ?? options.failureMessage;
            finish(() => reject(new Error(message)));
          } else if (data?.url) {
            const url = data.url;
            finish(() => resolve(url));
          }
        },
        (error) => finish(() => reject(error)),
      );

      // `onSnapshot` returns before it calls back, so `unsubscribe` is assigned
      // in time for every path above. If that ever stopped being true, the
      // listener would already have been detached-and-forgotten here rather
      // than leaked.
      if (settled) {
        unsubscribe();
      }
    });
  }

  /**
   * Writes the session document at an ID the volume cap in `firestore.rules`
   * accepts: `{current 5-minute window}-{slot}`.
   *
   * Slots are tried from a random starting point, so two checkouts inside the
   * same window don't both collide on slot 0 — a rejected slot is one that has
   * already been used this window, which for a real user only happens if they
   * genuinely started checkout twice in five minutes. Running out of all ten
   * is the cap actually biting.
   *
   * The message deliberately doesn't name a cause. A `permission-denied` here
   * has two plausible ones — every slot used, or a client old enough to still
   * be sending the pre-validation payload — and picking one to narrate would
   * be wrong half the time. Reloading and retrying is the answer to both.
   */
  private async createSessionDoc(
    firestore: Firestore,
    firestoreModule: typeof import('firebase/firestore'),
    uid: string,
    collectionName: string,
    payload: Record<string, string>,
  ): Promise<DocumentReference> {
    const currentWindow = Math.floor(Date.now() / SESSION_WINDOW_MS);
    const firstSlot = Math.floor(Math.random() * SESSION_SLOTS_PER_WINDOW);

    for (let attempt = 0; attempt < SESSION_SLOTS_PER_WINDOW; attempt++) {
      const slot = (firstSlot + attempt) % SESSION_SLOTS_PER_WINDOW;
      const sessionRef = firestoreModule.doc(
        firestore,
        CUSTOMERS_COLLECTION,
        uid,
        collectionName,
        `${currentWindow}-${slot}`,
      );
      try {
        await firestoreModule.setDoc(sessionRef, payload);
        return sessionRef;
      } catch (error) {
        if ((error as { code?: string })?.code !== 'permission-denied') {
          throw error;
        }
      }
    }

    throw new Error('Too many attempts just now. Reload the page and try again in a few minutes.');
  }
}
