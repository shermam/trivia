import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type Stripe from 'stripe';
import { deriveClaimRole } from './role';

/**
 * Mirrors a Stripe Subscription into `customers/{uid}/subscriptions/{id}` —
 * exactly the doc shape `SubscriptionService`'s real-time listener already
 * reads (`status`, `role` via the `active`/`trialing` filter) — then
 * recomputes the `stripeRole` custom claim from *all* of that user's
 * subscription docs, not just this one, so an unrelated subscription
 * canceling doesn't clobber a still-active one.
 */
export async function syncSubscriptionToFirestore(
  subscription: Stripe.Subscription,
): Promise<void> {
  const uid = subscription.metadata?.['firebaseUID'];
  if (!uid) {
    logger.warn(`Stripe subscription ${subscription.id} has no firebaseUID metadata — skipping.`);
    return;
  }

  const item = subscription.items.data[0];
  const price = item?.price;
  const priceRole = (price?.metadata?.['firebaseRole'] as string | undefined) ?? null;
  const productId = price?.product
    ? typeof price.product === 'string'
      ? price.product
      : price.product.id
    : null;

  await getFirestore()
    .collection('customers')
    .doc(uid)
    .collection('subscriptions')
    .doc(subscription.id)
    .set(
      {
        status: subscription.status,
        role: priceRole,
        price: price?.id ?? null,
        product: productId,
        cancel_at_period_end: subscription.cancel_at_period_end,
      },
      { merge: true },
    );

  await recomputeStripeRoleClaim(uid);
}

async function recomputeStripeRoleClaim(uid: string): Promise<void> {
  const subscriptionsSnapshot = await getFirestore()
    .collection('customers')
    .doc(uid)
    .collection('subscriptions')
    .get();

  let role: string | null = null;
  for (const doc of subscriptionsSnapshot.docs) {
    const data = doc.data();
    const candidate = deriveClaimRole(data['status'], data['role'] ?? null);
    if (candidate) {
      role = candidate;
      break;
    }
  }

  const auth = getAuth();
  const user = await auth.getUser(uid).catch(() => null);
  if (!user) {
    return;
  }
  if ((user.customClaims?.['stripeRole'] ?? null) === role) {
    // No-op: avoids invalidating the user's existing token (and everyone
    // else's cached listener state) for a claim that hasn't actually changed.
    return;
  }
  await auth.setCustomUserClaims(uid, role ? { stripeRole: role } : null);
}
