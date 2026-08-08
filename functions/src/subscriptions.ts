import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type Stripe from 'stripe';
import { isPrivilegeDowngrade, readStripeRole, withStripeRoleClaim } from './claims';
import { setIfNotStale } from './event-order';
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
  eventCreated: number,
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

  const written = await setIfNotStale(
    getFirestore()
      .collection('customers')
      .doc(uid)
      .collection('subscriptions')
      .doc(subscription.id),
    {
      status: subscription.status,
      role: priceRole,
      price: price?.id ?? null,
      product: productId,
      cancel_at_period_end: subscription.cancel_at_period_end,
    },
    eventCreated,
  );
  if (!written) {
    logger.info(
      `Ignored out-of-order Stripe event for subscription ${subscription.id}: a newer one already wrote it.`,
    );
  }

  // Recomputed even when the write was dropped, and deliberately so. The claim
  // is derived from all of the user's subscription documents, so it is correct
  // for whatever state won — and a redelivery exists precisely because some
  // earlier attempt failed, which may well have been this step after the
  // document write already succeeded. Skipping it here would leave that
  // failure with nothing to retry it. It is cheap to repeat: the claim write
  // itself no-ops when nothing changed.
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

  const previousRole = readStripeRole(user.customClaims);
  if (previousRole === role) {
    // No-op: avoids invalidating the user's existing token (and everyone
    // else's cached listener state) for a claim that hasn't actually changed.
    // Stripe redelivers webhooks, so this is the common case, not the rare
    // one — and it is what keeps the revocation below from signing users out
    // on every duplicate delivery.
    return;
  }

  // Merged, never wholesale. `setCustomUserClaims` replaces the entire claims
  // object, so writing `{ stripeRole }` — or `null` to clear it — deletes
  // every other claim the user has. See claims.ts.
  await auth.setCustomUserClaims(uid, withStripeRoleClaim(user.customClaims, role));

  if (isPrivilegeDowngrade(previousRole, role)) {
    // Unsetting the claim only changes what the *next* ID token says. The one
    // in the user's browser keeps asserting the old role until it expires, so
    // taking the entitlement away has to invalidate the session carrying it,
    // not just the record behind it.
    //
    // Deliberately after the claim write: if this throws, the entitlement is
    // already gone and only the session lingers. The other order would sign
    // the user out while leaving them Pro.
    await auth.revokeRefreshTokens(uid);
    logger.info(
      `Revoked refresh tokens for ${uid}: stripeRole ${previousRole} -> ${role ?? 'none'}`,
    );
  }
}
