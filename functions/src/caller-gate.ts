/**
 * Who a callable may write about — the caller gate every callable that keeps
 * something about a player applies, decided from the caller's verified ID
 * token and from nothing the caller sent.
 *
 * **One gate, not a check per callable.** A copy per callable is how two
 * lists drift apart, and these did: `recordGameResult` named three sign-in
 * providers while `setAvatar` named the eight the app offers, so a player
 * signed in with GitHub, Microsoft, Apple, Twitter/X or Yahoo could save an
 * avatar and had every finished game refused — no totals, no play history,
 * nothing counted into a question — with nothing saying so.
 *
 * **Dependency-free on purpose.** `auth.service.spec.ts` imports this file
 * across the package boundary to pin {@link PLAYER_SIGN_IN_PROVIDERS} to the
 * sign-in buttons the app renders, so it has to compile under the app's
 * compiler settings as well as this package's, and load in either test runner
 * without Firebase behind it.
 *
 * Kept pure for the reason `role.ts` is: `CLAUDE.md` §4.6 asks for a direct
 * unit test of every security decision a function makes, which stays cheap
 * only while the decision needs no Auth or Firestore standing up behind it.
 */

/**
 * The sign-in providers the app offers: `AuthService`'s `OAuthProviderId`
 * plus `password`, held equal to the buttons the auth menu renders by
 * `auth.service.spec.ts`.
 *
 * **An allowlist rather than `!== 'anonymous'`, so a provider fails closed.**
 * Firebase signs a token for any provider enabled in the console, and a
 * provider nobody wired into the app must not start writing documents the day
 * somebody switches it on there. Adding one is therefore two edits — the
 * button and this list — and the pin fails until both are made.
 */
export const PLAYER_SIGN_IN_PROVIDERS = [
  'password',
  'google.com',
  'facebook.com',
  'github.com',
  'microsoft.com',
  'apple.com',
  'twitter.com',
  'yahoo.com',
] as const;

const OFFERED_PROVIDERS: ReadonlySet<string> = new Set(PLAYER_SIGN_IN_PROVIDERS);

/**
 * The slice of a callable's `request.auth.token` the gate reads. Every field
 * is `unknown` because a callable is reachable without the app, and the gate
 * has to fail closed on a token of any shape rather than trust its type.
 */
export interface CallerToken {
  firebase?: { sign_in_provider?: unknown };
  email_verified?: unknown;
}

/**
 * What the token says about the caller, as one of four answers.
 *
 * - `verified` — signed in with a provider the app offers, and for a
 *   `password` account with an address the provider has verified. This is
 *   `isRealAuthedUser()` in `firestore.rules`, clause for clause, with one
 *   deliberate difference: the rules admit any provider that is not
 *   `anonymous`, and this admits only the eight above.
 * - `unverified-email` — a `password` account whose address is not verified
 *   yet. Anything but the boolean `true` counts as not verified.
 * - `anonymous` — the session every visitor gets before signing in.
 * - `unsupported-provider` — any other provider, or a token naming none.
 */
export type CallerStanding = 'verified' | 'unverified-email' | 'anonymous' | 'unsupported-provider';

/** Where a caller stands, read from the verified token alone. */
export function callerStanding(token: CallerToken | undefined): CallerStanding {
  const provider = token?.firebase?.sign_in_provider;
  if (provider === 'anonymous') {
    return 'anonymous';
  }
  if (typeof provider !== 'string' || !OFFERED_PROVIDERS.has(provider)) {
    return 'unsupported-provider';
  }
  if (provider === 'password' && token?.email_verified !== true) {
    return 'unverified-email';
  }
  return 'verified';
}

/**
 * The whole gate: `isRealAuthedUser()` on the providers the app offers.
 * What `setAvatar` admits, and what every write a player makes about
 * themselves through `firestore.rules` already required.
 */
export function isVerifiedPlayer(standing: CallerStanding): boolean {
  return standing === 'verified';
}

/** What `recordGameResult` answers a caller whose games it does not bank. */
export interface GameResultRefusal {
  recorded: false;
  /**
   * Why, because the client acts on the difference: a guest is refused on
   * every game by design, while a signed-in account refused is a gap worth
   * reporting (`AccountService.recordGameResult`).
   */
  reason: 'anonymous' | 'unsupported-provider';
  /** The provider the token named, for the client's log; `null` when it named none. */
  provider: string | null;
}

/**
 * `recordGameResult`'s caller decision: `null` to bank the game, or the
 * answer that refuses it.
 *
 * **Every account the app signs in is banked, a password account whose
 * address is not verified yet included** — the one place the gate is applied
 * without its email clause, and a decision rather than an omission
 * (`docs/data-model.md`, `users`). Requiring a verified address here would
 * stop banking games for players nothing on screen tells: a curated quiz's
 * result card shows no verify prompt at all, and once somebody has verified,
 * the app reads them as verified on their next page load while the ID token
 * it holds keeps saying otherwise until it is refreshed — up to an hour. The
 * screens and the Privacy Policy ask for a verified address to save a score,
 * not to keep totals.
 *
 * Anonymous sessions stay refused, which is not tidiness: nothing would ever
 * delete a guest's document (`deleteAccount` never runs for one, and
 * Firebase's clean-up of dormant anonymous accounts removes only the Auth
 * record), and the Privacy Policy says nothing is kept for anonymous play.
 */
export function gameResultRefusal(token: CallerToken | undefined): GameResultRefusal | null {
  const standing = callerStanding(token);
  switch (standing) {
    case 'verified':
    case 'unverified-email':
      return null;
    case 'anonymous':
    case 'unsupported-provider': {
      const provider = token?.firebase?.sign_in_provider;
      return {
        recorded: false,
        reason: standing,
        provider: typeof provider === 'string' ? provider : null,
      };
    }
  }
}
