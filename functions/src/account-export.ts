import type { UserRecord } from 'firebase-admin/auth';

/**
 * The shape handed back to a user who asks for their data.
 *
 * Kept as a plain, self-describing structure rather than a dump of raw
 * Firestore documents: an export is read by a person, often one who is
 * suspicious of what is held about them, so field names should mean something
 * without the schema next to them. `notHeldHere` exists for the same reason —
 * an export that silently omits payment data reads like concealment, even
 * though the honest answer is that Stripe holds it and we never see it.
 */
export interface AccountExport {
  exportedAt: string;
  account: {
    uid: string;
    email: string | null;
    displayName: string | null;
    emailVerified: boolean;
    signInProviders: string[];
    createdAt: string | null;
    lastSignInAt: string | null;
  };
  /** One entry per board the player has a score on (finding G7); empty if none. */
  leaderboardEntries: Record<string, unknown>[];
  /**
   * Lifetime totals from `users/{uid}`, or an explicit `null` when the account
   * has never finished a game — which is a normal state, since the document is
   * created lazily on the first completed one.
   *
   * `null` rather than an absent key, deliberately: an absent key reads as "we
   * are not telling you", an explicit null reads as "there is nothing". The
   * same convention `notHeldHere` exists for.
   */
  gameplayStats: Record<string, unknown> | null;
  contributedQuestions: Record<string, unknown>[];
  billing: {
    stripeCustomerId: string | null;
    subscriptions: Record<string, unknown>[];
    checkoutSessions: Record<string, unknown>[];
    portalSessions: Record<string, unknown>[];
  };
  notHeldHere: string[];
}

/**
 * Builds the export payload from already-fetched pieces.
 *
 * Split out from the callable purely so it is directly unit-testable — the
 * decision worth pinning is *what gets included*, and that shouldn't require
 * standing up Auth and Firestore to verify. Same reasoning as `role.ts` and
 * `account-policy.ts`.
 */
export function buildAccountExport(input: {
  user: Pick<
    UserRecord,
    'uid' | 'email' | 'displayName' | 'emailVerified' | 'providerData' | 'metadata'
  >;
  leaderboardEntries: Record<string, unknown>[];
  contributedQuestions: Record<string, unknown>[];
  gameplayStats: Record<string, unknown> | null;
  stripeCustomerId: string | null;
  subscriptions: Record<string, unknown>[];
  checkoutSessions: Record<string, unknown>[];
  portalSessions: Record<string, unknown>[];
  now?: Date;
}): AccountExport {
  return {
    exportedAt: (input.now ?? new Date()).toISOString(),
    account: {
      uid: input.user.uid,
      email: input.user.email ?? null,
      displayName: input.user.displayName ?? null,
      emailVerified: input.user.emailVerified,
      signInProviders: input.user.providerData.map((p) => p.providerId),
      createdAt: input.user.metadata.creationTime ?? null,
      lastSignInAt: input.user.metadata.lastSignInTime ?? null,
    },
    leaderboardEntries: input.leaderboardEntries,
    gameplayStats: input.gameplayStats,
    contributedQuestions: input.contributedQuestions,
    billing: {
      stripeCustomerId: input.stripeCustomerId,
      subscriptions: input.subscriptions,
      checkoutSessions: input.checkoutSessions,
      portalSessions: input.portalSessions,
    },
    // Naming the gaps is part of an honest export. A reader who knows they
    // paid and sees no card details should be told why, not left guessing.
    notHeldHere: [
      'Payment card details — held by Stripe, never received or stored by Trivimind.',
      'Your password — handled by Firebase Authentication and never visible to this application.',
      'Analytics or tracking data — none is collected.',
      'Offline question cache and theme preference — stored only in your browser, not on any server.',
    ],
  };
}
