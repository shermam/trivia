import type Stripe from 'stripe';

/**
 * Whether a subscription in this Stripe status should currently grant its
 * price's `firebaseRole` metadata as a custom claim. Kept as a pure function
 * (no Firestore/Admin SDK) so it's cheaply unit-testable — see role.test.ts —
 * despite being the crux of a security-relevant decision.
 */
export function deriveClaimRole(
  status: Stripe.Subscription.Status,
  priceRole: string | null,
): string | null {
  if (!priceRole) {
    return null;
  }
  return status === 'active' || status === 'trialing' ? priceRole : null;
}
