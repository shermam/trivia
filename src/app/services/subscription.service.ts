import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { withTimeout } from '../utils/with-timeout.util';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase.service';

const CUSTOMERS_COLLECTION = 'customers';
const PRODUCTS_COLLECTION = 'products';
const CHECKOUT_TIMEOUT_MS = 20_000;

/** Subscription statuses our Cloud Functions backend considers "currently paying". */
const ACTIVE_SUBSCRIPTION_STATUSES = ['trialing', 'active'] as const;

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

    this.firebaseService.getFirestore().then(({ firestore, firestoreModule }) => {
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
   */
  private getProPriceId(): Promise<string> {
    if (!this.proPricePromise) {
      this.proPricePromise = this.firebaseService
        .getFirestore()
        .then(async ({ firestore, firestoreModule }) => {
          const productsSnapshot = await withTimeout(
            firestoreModule.getDocs(
              firestoreModule.query(
                firestoreModule.collection(firestore, PRODUCTS_COLLECTION),
                firestoreModule.where('active', '==', true),
              ),
            ),
            CHECKOUT_TIMEOUT_MS,
          );
          for (const productDoc of productsSnapshot.docs) {
            const pricesSnapshot = await withTimeout(
              firestoreModule.getDocs(
                firestoreModule.query(
                  firestoreModule.collection(productDoc.ref, 'prices'),
                  firestoreModule.where('active', '==', true),
                ),
              ),
              CHECKOUT_TIMEOUT_MS,
            );
            const monthlyPrice = pricesSnapshot.docs.find(
              (priceDoc) => priceDoc.data()['interval'] === 'month',
            );
            if (monthlyPrice) {
              return monthlyPrice.id;
            }
          }
          throw new Error('No active monthly Pro price found — check the Stripe Dashboard setup.');
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
   */
  async startProCheckout(): Promise<void> {
    const user = this.authService.user();
    if (!user || user.isAnonymous) {
      throw new Error('Sign in before subscribing.');
    }

    const [{ firestore, firestoreModule }, priceId] = await Promise.all([
      this.firebaseService.getFirestore(),
      this.getProPriceId(),
    ]);

    const sessionRef = await firestoreModule.addDoc(
      firestoreModule.collection(firestore, CUSTOMERS_COLLECTION, user.uid, 'checkout_sessions'),
      {
        price: priceId,
        mode: 'subscription',
        success_url: `${window.location.origin}/pricing?checkout=success`,
        cancel_url: `${window.location.origin}/pricing?checkout=cancelled`,
      },
    );

    const checkoutUrl = await withTimeout(
      new Promise<string>((resolve, reject) => {
        const unsubscribe = firestoreModule.onSnapshot(
          sessionRef,
          (snapshot) => {
            const data = snapshot.data() as
              { url?: string; error?: { message?: string } } | undefined;
            if (data?.error) {
              unsubscribe();
              reject(new Error(data.error.message ?? 'Stripe checkout could not be started.'));
            } else if (data?.url) {
              unsubscribe();
              resolve(data.url);
            }
          },
          (error) => {
            unsubscribe();
            reject(error);
          },
        );
      }),
      CHECKOUT_TIMEOUT_MS,
      'Timed out waiting for Stripe checkout to start.',
    );

    window.location.assign(checkoutUrl);
  }
}
