import { getAuth } from 'firebase-admin/auth';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as logger from 'firebase-functions/logger';
import {
  RejectedRequestError,
  clientMessageFor,
  isAllowedRedirectOrigin,
  isPriceIdShaped,
} from './checkout-request';
import { getOrCreateStripeCustomerId } from './customers';
import { isPriceSellableAsDonation } from './products';
import { currentProjectId, getStripeClient, isMockMode, stripeSecretKey } from './stripe-client';
import { sessionExpiryAt } from './session-expiry';

/**
 * Everything a client may say about a donation it wants to make — and, since
 * the `hasOnly()` allowlist in `firestore.rules` rejects any other key,
 * everything a document on this path can contain.
 *
 * The amount is not here, and that is the whole design. An amount a client
 * chooses is a client-writable value with billing consequence, and the server
 * has nothing to check it against (`CLAUDE.md` §4.1); a catalog price id is a
 * value the mirrored catalog can answer for. So the presets are Stripe Prices
 * and the client sends which one, exactly as Pro does.
 */
interface DonationSessionRequest {
  price?: unknown;
  origin?: unknown;
}

const REJECTED_MESSAGE = 'Could not start the donation. Please reload the page and try again.';

/**
 * The other half of the handshake `DonationService.startDonation()` is waiting
 * on: the client creates a document here and polls it for `url`/`error`.
 *
 * A **separate subcollection from `checkout_sessions`**, deliberately. Two
 * things follow from that and both were the point: the volume caps are
 * separate, so a burst of donations cannot spend the slots a Pro checkout
 * needs, and the two validations are separate, so nothing on this path can
 * reach `isPriceSellableAsPro` or vice versa.
 *
 * **Anyone signed in may donate, anonymous sessions included.** Donating is
 * not a privilege — friction here costs donations and protects nothing, since
 * the money goes to Stripe either way. What the account decides is only
 * whether the donation can be *attributed*: a real account gets a Stripe
 * customer and a record under `customers/{uid}`, and a guest gets neither,
 * which the dialog says before they click.
 *
 * **`createCheckoutSession`'s open-session sweep is deliberately not repeated
 * here.** That sweep exists because an open *subscription-mode* session holds
 * the customer's currency for as long as it lives; a payment-mode session does
 * not, so there is nothing here for it to unblock. Running it anyway would
 * expire the Checkout Session the pricing page pre-created for this same
 * reader (`app.md` §1.6) and send them to Stripe's "this session has expired"
 * page on their next Subscribe click. A conflict that is *real* — the customer
 * has genuinely transacted in another currency — still reaches them as
 * Stripe's refusal, rewritten by `clientMessageFor` into which currency the
 * account is fixed to.
 */
export const createDonationSession = onDocumentCreated(
  { document: 'customers/{uid}/donation_sessions/{sessionId}', secrets: [stripeSecretKey] },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      return;
    }
    const { uid, sessionId } = event.params;
    const request = snapshot.data() as DonationSessionRequest;
    logger.info(`createDonationSession invoked for uid=${uid} sessionId=${sessionId}`, request);

    // Stamped before anything that can fail, for the same reason
    // `createCheckoutSession` stamps it there: the write-backs below only
    // happen on paths this handler completes, and a document left with no
    // expiry is exactly what the TTL policy exists to avoid.
    await snapshot.ref.set({ expiresAt: sessionExpiryAt(new Date()) }, { merge: true });

    try {
      // Re-validated here even though `firestore.rules` already bounded the
      // shape of both fields. Rules cannot know which hostnames are ours and
      // cannot look a price up in a catalog, and anyone with a console can
      // write straight to Firestore.
      const { price, origin } = request;
      if (!isPriceIdShaped(price)) {
        throw new RejectedRequestError(`price is not a Stripe price ID: ${String(price)}`);
      }
      if (!isAllowedRedirectOrigin(origin, currentProjectId())) {
        throw new RejectedRequestError(`origin is not an origin of this app: ${String(origin)}`);
      }
      if (!(await isPriceSellableAsDonation(price))) {
        throw new RejectedRequestError(`price ${price} is not an active donation price`);
      }

      if (isMockMode()) {
        // Same-origin and hash-only, for the reason `createCheckoutSession`'s
        // mock branch gives: `Location.assign`/`href` cannot be stubbed in a
        // real browser, so the e2e suite has to let the navigation happen, and
        // a hash on the app's own origin makes that harmless. The path is the
        // home screen because that is where a real donation returns to.
        await snapshot.ref.set(
          {
            sessionId: `cs_mock_${sessionId}`,
            url: `${origin}/?donation=success#mock-donation-session-${sessionId}`,
          },
          { merge: true },
        );
        return;
      }

      const attributable = await isRealAccount(uid);
      const stripe = getStripeClient();
      const session = await stripe.checkout.sessions.create({
        // Hardcoded, like Pro's `subscription`: a client-chosen mode buys
        // nothing and lets a recurring price be charged as a one-off.
        mode: 'payment',
        line_items: [{ price, quantity: 1 }],
        // Cross-border only, exactly as on the Pro checkout — it localises for
        // a buyer outside the merchant's country and never for one inside it,
        // which is why the catalog carries a real BRL price per preset rather
        // than relying on this (`checkout-sessions.ts`).
        adaptive_pricing: { enabled: true },
        // A Stripe customer only where there is an account to attach it to.
        // `if_required` lets a guest pay without one being invented for them,
        // which is the honest shape: nothing about that payment can be
        // attributed later, and creating a customer would imply otherwise.
        ...(attributable
          ? { customer: await getOrCreateStripeCustomerId(uid) }
          : { customer_creation: 'if_required' as const }),
        success_url: `${origin}/?donation=success`,
        cancel_url: `${origin}/?donation=cancelled`,
        // The only link back to a Firebase account, and it is set **only** for
        // a real one: `donationRecordFrom` writes nothing without it, which is
        // what makes "a guest donation stores nothing in our database" true in
        // the code rather than only in the Privacy Policy.
        ...(attributable ? { metadata: { firebaseUID: uid } } : {}),
      });

      await snapshot.ref.set({ sessionId: session.id, url: session.url }, { merge: true });
    } catch (error) {
      logger.error(`Failed to create Stripe donation session for ${uid}`, error);
      await snapshot.ref.set(
        { error: { message: clientMessageFor(error, REJECTED_MESSAGE, 'donation') } },
        { merge: true },
      );
    }
  },
);

/**
 * Whether this uid belongs to an account a donation can be attributed to.
 *
 * An anonymous session has no sign-in provider at all, which is what
 * `providerData` being empty means — there is no `isAnonymous` on the Admin
 * SDK's `UserRecord`, and inferring it from the absence of an email would
 * misclassify every provider that does not supply one. A lookup that fails is
 * treated as "not attributable": the donation still goes through, and the
 * alternative is failing a payment over a metadata field.
 */
async function isRealAccount(uid: string): Promise<boolean> {
  try {
    const user = await getAuth().getUser(uid);
    return user.providerData.length > 0;
  } catch (error) {
    logger.warn(`Could not resolve the account behind donation uid=${uid}`, error);
    return false;
  }
}
