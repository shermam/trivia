import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { getStripeClient, isMockMode, stripeSecretKey } from './stripe-client';

interface PortalSessionRequest {
  return_url: string;
}

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
      const stripeId = (await getFirestore().collection('customers').doc(uid).get()).data()?.[
        'stripeId'
      ] as string | undefined;
      if (!stripeId) {
        throw new Error('No Stripe customer found for this account yet.');
      }

      if (isMockMode()) {
        // Same-origin, hash-only mock URL for the same reason
        // createCheckoutSession's mock branch is — see the comment there.
        const mockOrigin = new URL(request.return_url).origin;
        await snapshot.ref.set(
          { url: `${mockOrigin}/pricing#mock-portal-session-${sessionId}` },
          { merge: true },
        );
        return;
      }

      const stripe = getStripeClient();
      const session = await stripe.billingPortal.sessions.create({
        customer: stripeId,
        return_url: request.return_url,
      });

      await snapshot.ref.set({ url: session.url }, { merge: true });
    } catch (error) {
      logger.error(`Failed to create Stripe billing portal session for ${uid}`, error);
      await snapshot.ref.set(
        {
          error: {
            message: error instanceof Error ? error.message : 'Could not open billing portal.',
          },
        },
        { merge: true },
      );
    }
  },
);
