/**
 * Rejects "plus-alias" addresses (e.g. `player+alt1@gmail.com`), which most
 * mailbox providers treat as equivalent to the base address. Without this,
 * one inbox can back an unlimited number of distinct Firebase accounts,
 * each with its own uid and its own leaderboard entry — defeating the
 * one-entry-per-user anti-cheat rule.
 *
 * This is a client-side-only guard (checked on sign-up, not sign-in): it
 * stops the UI from creating alias accounts but doesn't stop a determined
 * user from calling the Auth API directly. See `docs/known-gaps.md` §6 for
 * why server-side enforcement (an Auth blocking function) was scoped out.
 */
export function isAliasEmail(email: string): boolean {
  const [localPart] = email.split('@');
  return localPart?.includes('+') ?? false;
}
