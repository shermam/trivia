import { defineSecret } from 'firebase-functions/params';
import Stripe from 'stripe';

/**
 * Bound from Secret Manager at deploy time (`firebase functions:secrets:set
 * STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`, one-time per project) — never
 * present in this repo. Each function that needs one declares it in its
 * `secrets: [...]` option; `.value()` is only ever called lazily at
 * invocation time, never at module load, since secret binding isn't
 * available until then.
 */
export const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
export const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');

/**
 * True only for the throwaway `demo-trivia-app-e2e` project (see
 * `.env.demo-trivia-app-e2e`) — never for a real, Stripe-backed deploy.
 * Lets Cypress/CI exercise the full checkout-session-creation path without
 * any real Stripe credentials.
 */
export function isMockMode(): boolean {
  return process.env['STRIPE_MOCK_CHECKOUT'] === 'true';
}

let stripeClient: Stripe | null = null;

/** Lazily constructs a singleton Stripe client. Never call this in mock mode — there's no secret to read. */
export function getStripeClient(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(stripeSecretKey.value());
  }
  return stripeClient;
}
