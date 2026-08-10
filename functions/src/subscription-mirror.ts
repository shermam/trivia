import type Stripe from 'stripe';

/**
 * The exact document shape `SubscriptionService`'s real-time listener reads
 * from `customers/{uid}/subscriptions/{id}`. A `type`, not an `interface`, so
 * it picks up the implicit index signature `setIfNotStale`'s
 * `Record<string, unknown>` parameter needs.
 */
export type SubscriptionMirrorDoc = {
  status: Stripe.Subscription.Status;
  role: string | null;
  price: string | null;
  product: string | null;
  cancel_at_period_end: boolean;
};

/**
 * Maps a Stripe Subscription to its Firestore mirror, or `null` when the
 * subscription carries no `firebaseUID` metadata. That metadata — stamped
 * onto the subscription at checkout time — is the only link back to an Auth
 * user; without it there is no uid to write under and no claim to recompute,
 * so the delivery has to be skipped rather than guessed at. Pure (no
 * Firestore/Admin SDK) so the mapping is directly unit-testable (finding E3).
 */
export function subscriptionMirrorFrom(
  subscription: Stripe.Subscription,
): { uid: string; doc: SubscriptionMirrorDoc } | null {
  const uid = subscription.metadata?.['firebaseUID'];
  if (!uid) {
    return null;
  }

  const price = subscription.items.data[0]?.price;
  const product = price?.product;
  return {
    uid,
    doc: {
      status: subscription.status,
      role: (price?.metadata?.['firebaseRole'] as string | undefined) ?? null,
      price: price?.id ?? null,
      // Stripe sends `product` as an ID string unless the object was expanded;
      // the mirror stores the ID either way.
      product: product ? (typeof product === 'string' ? product : product.id) : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
    },
  };
}
