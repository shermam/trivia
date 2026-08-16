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

/**
 * The claim role derived from *all* of a user's subscription documents — the
 * first one whose status grants its role wins, so an unrelated subscription
 * cancelling can never clobber a still-active one. Takes raw Firestore
 * document data (fields `unknown`-typed on purpose: the docs were written by
 * the webhook, but nothing here should have to assume that).
 */
export function chooseStripeRole(
  subscriptionDocs: readonly Record<string, unknown>[],
): string | null {
  for (const data of subscriptionDocs) {
    const candidate = deriveClaimRole(
      data['status'] as Stripe.Subscription.Status,
      (data['role'] as string | null | undefined) ?? null,
    );
    if (candidate) {
      return candidate;
    }
  }
  return null;
}
