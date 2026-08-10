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
