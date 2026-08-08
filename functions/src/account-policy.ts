import type Stripe from 'stripe';

/**
 * Replaces `createdBy` on questions whose author has deleted their account.
 *
 * Deliberately not an empty string and not a missing field. A missing field
 * would be indistinguishable from a question created before attribution
 * existed (see `CustomQuestionDoc`'s optional read shape), and those two cases
 * are not the same thing: one was never recorded, the other was deliberately
 * erased. A sentinel that cannot collide with a real Firebase uid keeps them
 * distinguishable forever.
 */
export const ANONYMISED_AUTHOR = '[deleted-user]';

/**
 * Stripe subscription statuses that still represent a live billing
 * relationship and therefore have to be cancelled before an account goes
 * away.
 *
 * `past_due` and `unpaid` are included on purpose — they are *failing* to
 * collect, not finished collecting, and Stripe will keep retrying them. A
 * terminal status (`canceled`, `incomplete_expired`) needs no action, and
 * cancelling one again is a pointless API call that can only fail.
 *
 * Isolated as a pure function so the decision "does this status still cost
 * the user money" is unit-testable without a Stripe client — same reasoning
 * as `deriveClaimRole` in role.ts.
 */
export function isCancellableStatus(status: Stripe.Subscription.Status): boolean {
  switch (status) {
    case 'active':
    case 'trialing':
    case 'past_due':
    case 'unpaid':
    case 'paused':
      return true;
    case 'canceled':
    case 'incomplete':
    case 'incomplete_expired':
      return false;
    default:
      // An unrecognised status is more likely a new live state than a new
      // terminal one, and the cost of asymmetry favours cancelling: a
      // redundant cancel is a no-op, a missed one keeps charging someone who
      // deleted their account.
      return true;
  }
}
