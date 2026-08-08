import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import {
  RejectedRequestError,
  clientMessageFor,
  isAllowedRedirectOrigin,
} from './checkout-request';
import { currentProjectId, getStripeClient, isMockMode, stripeSecretKey } from './stripe-client';

/**
 * The one thing a client may say about a billing-portal session it wants to
 * open. `return_url` used to be here and was passed to Stripe verbatim; the
 * URL is now built below from a bare origin this function has checked.
 */
interface PortalSessionRequest {
  origin?: unknown;
}

const REJECTED_MESSAGE = 'Could not open the billing portal. Please reload the page and try again.';

/**
 * The Angular client (`SubscriptionService.openBillingPortal`) creates a doc
 * here and then listens on it for `url`/`error` — same handshake shape as
 * `createCheckoutSession` (checkout-sessions.ts). Lets an existing Pro
 * subscriber manage payment method / cancel from Stripe's own hosted portal
 * instead of console-only.
 */
export const createPortalSession = onDocumentCreated(
  { document: 'customers/{uid}/portal_sessions/{sessionId}', secrets: [stripeSecretKey] },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      return;
    }
    const { uid, sessionId } = event.params;
    const request = snapshot.data() as PortalSessionRequest;
    logger.info(`createPortalSession invoked for uid=${uid} sessionId=${sessionId}`);

    try {
      // Same two-layer check as createCheckoutSession: `firestore.rules`
      // bounded the shape, and only this side knows which hostnames are ours.
      const { origin } = request;
      if (!isAllowedRedirectOrigin(origin, currentProjectId())) {
        throw new RejectedRequestError(`origin is not an origin of this app: ${String(origin)}`);
      }

      const stripeId = (await getFirestore().collection('customers').doc(uid).get()).data()?.[
        'stripeId'
      ] as string | undefined;
      if (!stripeId) {
        throw new Error('No Stripe customer found for this account yet.');
      }

      if (isMockMode()) {
        // Same-origin, hash-only mock URL for the same reason
        // createCheckoutSession's mock branch is — see the comment there.
        await snapshot.ref.set(
          { url: `${origin}/pricing#mock-portal-session-${sessionId}` },
          { merge: true },
        );
        return;
      }

      const stripe = getStripeClient();
      const session = await stripe.billingPortal.sessions.create({
        customer: stripeId,
        return_url: `${origin}/pricing`,
      });

      await snapshot.ref.set({ url: session.url }, { merge: true });
    } catch (error) {
      logger.error(`Failed to create Stripe billing portal session for ${uid}`, error);
      await snapshot.ref.set(
        { error: { message: clientMessageFor(error, REJECTED_MESSAGE) } },
        { merge: true },
      );
    }
  },
);
