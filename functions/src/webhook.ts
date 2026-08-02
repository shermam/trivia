import * as logger from 'firebase-functions/logger';
import { onRequest } from 'firebase-functions/v2/https';
import type Stripe from 'stripe';
import {
  deleteProductFromFirestore,
  deletePriceFromFirestore,
  syncPriceToFirestore,
  syncProductToFirestore,
} from './products';
import { getStripeClient, stripeSecretKey, stripeWebhookSecret } from './stripe-client';
import { syncSubscriptionToFirestore } from './subscriptions';

/**
 * Single Stripe webhook endpoint. Configure this URL (printed after deploy,
 * e.g. `https://<region>-<project>.cloudfunctions.net/stripeWebhook`) in the
 * Stripe Dashboard with the events listed in the PR description. Everything
 * this handler does is idempotent (Firestore `set(..., {merge:true})` /
 * `delete()`), so Stripe's at-least-once webhook delivery is safe to retry.
 */
export const stripeWebhook = onRequest(
  { secrets: [stripeSecretKey, stripeWebhookSecret] },
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

    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          await syncSubscriptionToFirestore(event.data.object as Stripe.Subscription);
          break;
        case 'product.created':
        case 'product.updated':
          await syncProductToFirestore(event.data.object as Stripe.Product);
          break;
        case 'product.deleted':
          await deleteProductFromFirestore((event.data.object as Stripe.Product).id);
          break;
        case 'price.created':
        case 'price.updated':
          await syncPriceToFirestore(event.data.object as Stripe.Price);
          break;
        case 'price.deleted':
          await deletePriceFromFirestore(event.data.object as Stripe.Price);
          break;
        default:
          // Not every Stripe event type is relevant to us — silently
          // ignoring unhandled ones is expected, not an error.
          break;
      }
      res.json({ received: true });
    } catch (error) {
      logger.error(`Error handling Stripe webhook event ${event.type}`, error);
      res.status(500).send('Webhook handler error.');
    }
  },
);
