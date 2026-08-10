import * as logger from 'firebase-functions/logger';
import { onRequest } from 'firebase-functions/v2/https';
import type Stripe from 'stripe';
import {
  deleteProductFromFirestore,
  deletePriceFromFirestore,
  syncPriceToFirestore,
  syncProductToFirestore,
} from './products';
import { isEventForThisEnvironment } from './environment';
import {
  currentProjectId,
  getStripeClient,
  stripeSecretKey,
  stripeWebhookSecret,
} from './stripe-client';
import { syncSubscriptionToFirestore } from './subscriptions';
import { webhookRouteFor } from './webhook-routing';

/**
 * Single Stripe webhook endpoint. Configure this URL (printed after deploy,
 * e.g. `https://<region>-<project>.cloudfunctions.net/stripeWebhook`) in the
 * Stripe Dashboard with the events listed in the PR description.
 *
 * Three things stand between a delivery and a Firestore write, and they guard
 * different failures:
 *
 * 1. **Signature verification** — is this really from Stripe.
 * 2. **`livemode`** — is it from the *right* Stripe, i.e. the mode the deployed
 *    secret key talks to (see `isEventForThisEnvironment`). Test-mode traffic
 *    must never be able to mutate live billing state.
 * 3. **A per-document high-water mark** (`event-order.ts`) — is it newer than
 *    what the document already holds. Every write here is idempotent, so a
 *    redelivery was always safe; what was not safe is Stripe's total absence of
 *    ordering guarantees, which let a stale `cancelled` land on top of a fresh
 *    `active` and take the user's `stripeRole` claim with it.
 */
export const stripeWebhook = onRequest(
  // Stripe calls this with no Google-issued auth token — it authenticates
  // via the Stripe-Signature header instead (verified below) — so the
  // underlying Cloud Run service must explicitly allow unauthenticated
  // invocations, or every delivery gets rejected with a 403 before this
  // handler ever runs.
  { secrets: [stripeSecretKey, stripeWebhookSecret], invoker: 'public' },
  async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature) {
      res.status(400).send('Missing Stripe-Signature header.');
      return;
    }

    let event: Stripe.Event;
    try {
      const stripe = getStripeClient();
      event = stripe.webhooks.constructEvent(req.rawBody, signature, stripeWebhookSecret.value());
    } catch (error) {
      logger.warn('Stripe webhook signature verification failed', error);
      res.status(400).send('Invalid signature.');
      return;
    }

    if (!isEventForThisEnvironment(event.livemode, stripeSecretKey.value(), currentProjectId())) {
      // Acknowledged, not rejected. A 4xx would make Stripe retry and
      // eventually disable the endpoint, and there is nothing to retry: the
      // delivery is simply for the other mode. Refusing to act on it is the
      // entire point, and saying so once in the log is the useful part.
      logger.warn(
        `Ignoring Stripe event ${event.id} (${event.type}): livemode=${event.livemode} does not match this project.`,
      );
      res.json({ received: true, ignored: 'livemode mismatch' });
      return;
    }

    try {
      // The event-type → handler map lives in webhook-routing.ts, where it is
      // directly unit-tested — a mistyped case here would drop deliveries
      // silently, since the 200 below tells Stripe never to retry.
      switch (webhookRouteFor(event.type)) {
        case 'subscription':
          await syncSubscriptionToFirestore(
            event.data.object as Stripe.Subscription,
            event.created,
          );
          break;
        case 'product-sync':
          await syncProductToFirestore(event.data.object as Stripe.Product, event.created);
          break;
        case 'product-delete':
          await deleteProductFromFirestore((event.data.object as Stripe.Product).id, event.created);
          break;
        case 'price-sync':
          await syncPriceToFirestore(event.data.object as Stripe.Price, event.created);
          break;
        case 'price-delete':
          await deletePriceFromFirestore(event.data.object as Stripe.Price, event.created);
          break;
        case 'ignore':
          break;
      }
      res.json({ received: true });
    } catch (error) {
      logger.error(`Error handling Stripe webhook event ${event.type}`, error);
      res.status(500).send('Webhook handler error.');
    }
  },
);
