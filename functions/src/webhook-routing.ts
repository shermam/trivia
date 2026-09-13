/**
 * Which handler a Stripe event type belongs to — the webhook's dispatch map,
 * extracted so the list of events this app acts on is a single, directly
 * unit-tested decision (finding E3). The failure mode this pins is silent: an
 * event type dropped or mistyped in a switch is simply "unhandled", the
 * endpoint still returns 200, and Stripe never retries — so subscriptions
 * quietly stop syncing with nothing red anywhere.
 */
export type WebhookRoute =
  | 'subscription'
  | 'checkout-completed'
  | 'product-sync'
  | 'product-delete'
  | 'price-sync'
  | 'price-delete'
  | 'ignore';

export function webhookRouteFor(eventType: string): WebhookRoute {
  switch (eventType) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return 'subscription';
    // Both of these carry a Checkout Session, and **the event type cannot say
    // whether it is a donation**: Stripe emits `checkout.session.completed`
    // for every session this account completes, a Pro subscription starting
    // included. Only the object knows, so the mode and payment checks live in
    // `donation-record.ts` where they can be unit-tested against a real
    // payload shape rather than against a string.
    //
    // `async_payment_succeeded` is here because a delayed payment method
    // completes the session *unpaid* and settles later — boleto and Pix, which
    // is not a hypothetical for a Brazilian Stripe account. Without it a
    // donation paid that way is never recorded, and nothing anywhere says so.
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return 'checkout-completed';
    case 'product.created':
    case 'product.updated':
      return 'product-sync';
    case 'product.deleted':
      return 'product-delete';
    case 'price.created':
    case 'price.updated':
      return 'price-sync';
    case 'price.deleted':
      return 'price-delete';
    default:
      // Not every Stripe event type is relevant to us — silently ignoring
      // unhandled ones is expected, not an error.
      return 'ignore';
  }
}
