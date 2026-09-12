import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as logger from 'firebase-functions/logger';
import type Stripe from 'stripe';
import {
  RejectedRequestError,
  clientMessageFor,
  isAllowedRedirectOrigin,
  isPriceIdShaped,
  openCheckoutSessionIdsToExpire,
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
 * How many of the customer's open Checkout Sessions one Subscribe click
 * clears (Stripe's own maximum for a single page is 100).
 *
 * A bound rather than an exhaustive sweep, so a single click can never turn
 * into an unbounded run of Stripe calls inside a function that has to finish.
 * Twenty is far more than an abandoned-checkout history holds in practice —
 * `firestore.rules` caps session creation at ten per five-minute window and
 * Stripe expires an open session after 24 hours, so reaching it takes
 * deliberate effort — and whatever a determined clicker leaves beyond it is
 * cleared by the next click.
 */
const OPEN_SESSIONS_TO_CLEAR = 20;

/**
 * Expires every Checkout Session this customer still has open, before a new
 * one is created for them.
 *
 * A click on Subscribe is a request for a fresh session; whatever is still
 * open was left behind by an attempt that did not finish — a declined card, a
 * closed tab — and nobody is going back to it. That much is tidiness. What
 * makes it a fix is the currency: **a Stripe customer can only be billed in
 * one currency, and an open subscription-mode session holds that currency for
 * as long as it lives.** So a buyer who abandons a USD checkout and then
 * chooses BRL is refused outright — "You cannot combine currencies on a single
 * customer" — by a session they walked away from, for up to 24 hours.
 * Expiring it first is what lets the second choice work.
 *
 * **Nothing in here may fail the checkout.** A list or an expire that throws
 * is logged and the create runs anyway, so the buyer sees what Stripe
 * actually says about the request they made, rather than a failure of this
 * cleanup wearing that costume (`CLAUDE.md` §4.4). Expiring the sessions
 * concurrently rather than in sequence keeps the added latency at one round
 * trip whatever the count.
 */
async function expireOpenCheckoutSessions(
  stripe: Stripe,
  customerId: string,
  uid: string,
): Promise<void> {
  try {
    const open = await stripe.checkout.sessions.list({
      customer: customerId,
      status: 'open',
      limit: OPEN_SESSIONS_TO_CLEAR,
    });
    const ids = openCheckoutSessionIdsToExpire(open.data);
    if (ids.length === 0) {
      return;
    }
    logger.info(`Expiring ${ids.length} open checkout session(s) for uid=${uid}`, ids);
    const outcomes = await Promise.allSettled(ids.map((id) => stripe.checkout.sessions.expire(id)));
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'rejected') {
        logger.warn(
          `Could not expire open checkout session ${ids[index]} for uid=${uid}`,
          outcome.reason,
        );
      }
    });
  } catch (error) {
    logger.warn(`Could not list open checkout sessions for uid=${uid}`, error);
  }
}

/**
 * The Angular client (`SubscriptionService.startProCheckout`) creates a doc
 * here and then polls it for `url`/`error` — this function is the
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
        // Location.assign/href can't be stubbed in a real Chromium
        // (it's non-configurable/read-only) — so Playwright has to let that
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

      // Before the create, not as a retry after it fails: an open session in
      // another currency makes the create fail outright, so there is nothing
      // to retry into. See the helper for why a stale session is able to do
      // that at all.
      await expireOpenCheckoutSessions(stripe, customerId, uid);

      const session = await stripe.checkout.sessions.create({
        // Hardcoded rather than read from the document: this app has exactly
        // one paid tier and it is a subscription. A client-chosen mode bought
        // nothing and let a recurring price be charged as a one-off.
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price, quantity: 1 }],
        // **Adaptive Pricing is cross-border only, and that is the whole
        // reason the catalog carries more than one price.** It localises a
        // price for a buyer in a *different* country from the merchant, and
        // never for one in the merchant's own — so for this Brazilian Stripe
        // account it does nothing at all for a Brazilian buyer, whose
        // Brazilian-issued card can only be charged in BRL and is otherwise
        // declined with "your card doesn't support this currency". No
        // parameter changes that; a BRL price on the Pro product does, and is
        // what `SubscriptionService` offers a BR visitor (`app.md` §1.6).
        // Stated explicitly rather than left to the Dashboard setting so the
        // behaviour is readable here and cannot change under the app from a
        // console toggle nobody in this repo can see.
        adaptive_pricing: { enabled: true },
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
