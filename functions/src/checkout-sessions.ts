import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as logger from 'firebase-functions/logger';
import {
  RejectedRequestError,
  clientMessageFor,
  isAllowedRedirectOrigin,
  isPriceIdShaped,
} from './checkout-request';
import { getOrCreateStripeCustomerId } from './customers';
import { isPriceSellableAsPro } from './products';
import { currentProjectId, getStripeClient, isMockMode, stripeSecretKey } from './stripe-client';
import { sessionExpiryAt } from './session-expiry';

/**
 * Everything a client may say about a checkout it wants to start — and, since
 * the `hasOnly()` allowlist in `firestore.rules` rejects any other key,
 * everything a document on this path can contain.
 *
 * `mode`, `success_url` and `cancel_url` used to be here too and were handed
 * to Stripe verbatim. They aren't client-supplied any more: this app sells one
 * subscription and returns to one page, so both are decided below.
 */
interface CheckoutSessionRequest {
  price?: unknown;
  origin?: unknown;
}

/**
 * Shown to the user, so it says what to do rather than what went wrong. The
 * real reason — a price that isn't ours, an origin that isn't ours, a stale
 * client still writing the old payload — is in the logs, and none of the three
 * is something a user can act on differently.
 */
const REJECTED_MESSAGE = 'Could not start checkout. Please reload the page and try again.';

/**
 * The Angular client (`SubscriptionService.startProCheckout`) creates a doc
 * here and then listens on it for `url`/`error` — this function is the
 * other half of that handshake, replacing the equivalent trigger the
 * "Run Subscriptions with Stripe" extension used to provide.
 */
export const createCheckoutSession = onDocumentCreated(
  { document: 'customers/{uid}/checkout_sessions/{sessionId}', secrets: [stripeSecretKey] },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      return;
    }
    const { uid, sessionId } = event.params;
    const request = snapshot.data() as CheckoutSessionRequest;
    logger.info(`createCheckoutSession invoked for uid=${uid} sessionId=${sessionId}`, request);

    // Stamped before anything that can fail, rather than folded into the
    // write-backs below. Those only happen on paths this handler completes —
    // so a Stripe call that hangs until the function times out would leave a
    // document with no expiry at all, and it is exactly when things go wrong
    // that the cleanup should still apply (finding C2). One extra write on a
    // path that already does a Stripe round trip.
    await snapshot.ref.set({ expiresAt: sessionExpiryAt(new Date()) }, { merge: true });

    try {
      // Re-validated here even though `firestore.rules` already bounded the
      // shape of both fields, because rules can only check shape: they can't
      // know which hostnames are ours, and they can't ask whether a price ID
      // exists in the catalog. Anyone with a console can write straight to
      // Firestore, so this is the check that actually stands between a
      // client-chosen value and Stripe.
      const { price, origin } = request;
      if (!isPriceIdShaped(price)) {
        throw new RejectedRequestError(`price is not a Stripe price ID: ${String(price)}`);
      }
      if (!isAllowedRedirectOrigin(origin, currentProjectId())) {
        throw new RejectedRequestError(`origin is not an origin of this app: ${String(origin)}`);
      }
      if (!(await isPriceSellableAsPro(price))) {
        throw new RejectedRequestError(`price ${price} is not an active Pro price`);
      }

      const customerId = await getOrCreateStripeCustomerId(uid);

      if (isMockMode()) {
        // Deliberately same-origin (the caller's own origin, e.g.
        // `http://localhost:4200`), not a fake external host: the client for
        // real calls `window.location.assign` on this URL, and
        // Location.assign/href can't be stubbed in a real Chromium/Electron
        // (it's non-configurable/read-only) — so Cypress has to let that
        // navigation actually happen. A same-origin, hash-only target makes
        // that a harmless in-page navigation instead of an attempt to reach a
        // domain that doesn't exist.
        await snapshot.ref.set(
          {
            sessionId: `cs_mock_${sessionId}`,
            url: `${origin}/pricing#mock-checkout-session-${sessionId}`,
          },
          { merge: true },
        );
        return;
      }

      const stripe = getStripeClient();
      const session = await stripe.checkout.sessions.create({
        // Hardcoded rather than read from the document: this app has exactly
        // one paid tier and it is a subscription. A client-chosen mode bought
        // nothing and let a recurring price be charged as a one-off.
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price, quantity: 1 }],
        success_url: `${origin}/pricing?checkout=success`,
        cancel_url: `${origin}/pricing?checkout=cancelled`,
        // Carried onto the resulting Subscription object itself (not just
        // the Customer), so the webhook handler can identify the Firebase
        // user directly from the subscription event payload with no
        // Firestore reverse-lookup — see subscriptions.ts.
        subscription_data: { metadata: { firebaseUID: uid } },
        metadata: { firebaseUID: uid },
      });

      await snapshot.ref.set({ sessionId: session.id, url: session.url }, { merge: true });
    } catch (error) {
      logger.error(`Failed to create Stripe checkout session for ${uid}`, error);
      await snapshot.ref.set(
        { error: { message: clientMessageFor(error, REJECTED_MESSAGE) } },
        { merge: true },
      );
    }
  },
);
