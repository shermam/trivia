import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import { getOrCreateStripeCustomerId } from './customers';
import { getStripeClient, isMockMode, stripeSecretKey } from './stripe-client';

interface CheckoutSessionRequest {
  price: string;
  mode?: 'subscription' | 'payment';
  success_url: string;
  cancel_url: string;
}

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

    try {
      const customerId = await getOrCreateStripeCustomerId(uid);
      const mode = request.mode ?? 'subscription';

      if (isMockMode()) {
        // Deliberately same-origin (derived from the caller's own
        // `success_url`, e.g. `http://localhost:4200/pricing`), not a fake
        // external host: the client for real calls `window.location.assign`
        // on this URL, and Location.assign/href can't be stubbed in a real
        // Chromium/Electron (it's non-configurable/read-only) — so Cypress
        // has to let that navigation actually happen. A same-origin,
        // hash-only target makes that a harmless in-page navigation instead
        // of an attempt to reach a domain that doesn't exist.
        const mockOrigin = new URL(request.success_url).origin;
        await snapshot.ref.set(
          {
            sessionId: `cs_mock_${sessionId}`,
            url: `${mockOrigin}/pricing#mock-checkout-session-${sessionId}`,
          },
          { merge: true },
        );
        return;
      }

      const stripe = getStripeClient();
      const session = await stripe.checkout.sessions.create({
        mode,
        customer: customerId,
        line_items: [{ price: request.price, quantity: 1 }],
        success_url: request.success_url,
        cancel_url: request.cancel_url,
        // Carried onto the resulting Subscription object itself (not just
        // the Customer), so the webhook handler can identify the Firebase
        // user directly from the subscription event payload with no
        // Firestore reverse-lookup — see subscriptions.ts.
        subscription_data: mode === 'subscription' ? { metadata: { firebaseUID: uid } } : undefined,
        metadata: { firebaseUID: uid },
      });

      await snapshot.ref.set({ sessionId: session.id, url: session.url }, { merge: true });
    } catch (error) {
      logger.error(`Failed to create Stripe checkout session for ${uid}`, error);
      await snapshot.ref.set(
        { error: { message: error instanceof Error ? error.message : 'Checkout failed.' } },
        { merge: true },
      );
    }
  },
);
