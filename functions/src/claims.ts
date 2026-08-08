/**
 * Custom-claim bookkeeping for the `stripeRole` entitlement.
 *
 * `setCustomUserClaims` does not merge — it **replaces the entire claims
 * object**. Both of the obvious ways to call it are therefore destructive:
 * passing `null` erases every claim on the user, and passing
 * `{ stripeRole: 'pro' }` erases every claim that isn't `stripeRole`. This app
 * has only one claim today, which is exactly why the bug is easy to keep: it
 * costs nothing until the day someone adds a second one, and then it silently
 * deletes it on the next webhook delivery.
 *
 * Isolated as pure functions so the two security-relevant decisions — what the
 * claims object becomes, and whether the change is a downgrade — are unit
 * tested directly, same convention as `role.ts` and `account-policy.ts`.
 */

export const STRIPE_ROLE_CLAIM = 'stripeRole';

/** The current entitlement, or null if the user has none. */
export function readStripeRole(claims: Record<string, unknown> | undefined): string | null {
  const value = claims?.[STRIPE_ROLE_CLAIM];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The claims object to write: everything the user already had, with
 * `stripeRole` set or removed.
 *
 * Returns a new object rather than mutating the one Auth handed back — the
 * caller still needs the previous value to decide whether this is a downgrade,
 * and a function that quietly edits its argument makes that ordering load
 * bearing.
 */
export function withStripeRoleClaim(
  existing: Record<string, unknown> | undefined,
  role: string | null,
): Record<string, unknown> {
  const next = { ...(existing ?? {}) };
  if (role === null) {
    delete next[STRIPE_ROLE_CLAIM];
  } else {
    next[STRIPE_ROLE_CLAIM] = role;
  }
  return next;
}

/**
 * Whether this claim change takes a privilege away, and therefore has to
 * invalidate the sessions that were issued while the user still had it.
 *
 * Any move *from* a role counts, not just to nothing: `pro` → `basic` leaves
 * old tokens asserting `pro`, which is the same problem as `pro` → none.
 *
 * Gaining a role deliberately does not qualify. An old token that asserts
 * *less* than the truth is harmless, and revoking on an upgrade would sign a
 * user out seconds after they finished paying — the single worst moment in the
 * product to do it, and one `SubscriptionService` already handles properly by
 * force-refreshing the token when a subscription goes active.
 */
export function isPrivilegeDowngrade(
  previousRole: string | null,
  nextRole: string | null,
): boolean {
  return previousRole !== null && previousRole !== nextRole;
}
