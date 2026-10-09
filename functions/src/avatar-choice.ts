import type { DocumentReference } from 'firebase-admin/firestore';

/**
 * A player's avatar choice (`FEAT-038`), and the decision about who may store
 * one — kept pure so both are unit-tested without standing up Auth or
 * Firestore, the same convention as `role.ts` and `game-stats.ts`
 * (`CLAUDE.md` §4.6).
 *
 * The choice lives on `users/{uid}` as one field, `avatar`, and the only path
 * that writes it is the `setAvatar` callable on the Admin SDK. `users` has no
 * client write rule and must not gain one (`CLAUDE.md` §4.2,
 * `docs/data-model.md`): a cosmetic preference is not worth the exact-key
 * `hasOnly()` door a client write path would put on the collection every
 * later feature wants a field on. So this module is where everything a rule
 * would otherwise have checked is checked instead.
 */

/** What a player can be pictured as. Initials stay the default and the fallback. */
export const AVATAR_KINDS = ['initials', 'photo', 'built'] as const;
export type AvatarKind = (typeof AVATAR_KINDS)[number];

/** `users/{uid}.avatar`, exactly as stored. */
export interface AvatarChoice {
  kind: AvatarKind;
  /**
   * Which built avatar — present for `built` and for nothing else. It names a
   * variant (see {@link AVATAR_SEED_PATTERN}); it is never a URL.
   */
  seed?: string;
  /**
   * Whether the choice may appear on a surface another player can see.
   * Nothing public shows an avatar today; the switch exists so that whatever
   * does, later, has to ask. A reader treats anything but `true` as `false`.
   */
  showPublicly: boolean;
}

/**
 * A built avatar's seed: `<set>-<two digits>`, such as `core-35`.
 *
 * **A seed names a variant rather than feeding a hash**, so that `FEAT-041`
 * can lock and unlock whole sets by their name without a schema change: the
 * stored field stays one short string, and "which sets this player has
 * unlocked" becomes a rule over the part before the dash. Each set decides
 * what its two digits mean — the first set, `core`, reads them as a shape and
 * a colour — and a set is frozen once shipped, because a stored seed is a
 * reference into it.
 *
 * Deliberately a pattern and not a catalog. Whether a set exists is the
 * client's business (an unknown one renders as initials); this bounds what can
 * be stored to eleven characters of a known shape. The digits are fixed-width,
 * so every variant has exactly one spelling.
 *
 * Must agree with `AVATAR_SEED_PATTERN` in `src/app/models/avatar.model.ts`.
 * This copy is the one that is enforced.
 */
export const AVATAR_SEED_PATTERN = /^[a-z]{1,8}-[0-9]{2}$/;

/**
 * The sign-in providers whose accounts may store a choice — the eight the app
 * offers (`AuthService`'s `OAuthProviderId` plus `password`).
 *
 * An allowlist rather than `!== 'anonymous'`, for the reason
 * `recordGameResult` gives: a provider nobody has enabled must fail closed
 * rather than start writing documents the day somebody switches it on in the
 * console. **It names all eight, where `recordGameResult`'s names three**,
 * because the picker is offered to every signed-in account and a client gate
 * may not be broader than the server's (`CLAUDE.md` §4.2): a GitHub player
 * shown the picker and then refused would be exactly that shape.
 */
export const AVATAR_PROVIDERS: ReadonlySet<string> = new Set([
  'password',
  'google.com',
  'facebook.com',
  'github.com',
  'microsoft.com',
  'apple.com',
  'twitter.com',
  'yahoo.com',
]);

/** The slice of a callable's `request.auth` the decision reads. */
export interface AvatarCaller {
  uid: string;
  token: {
    firebase?: { sign_in_provider?: unknown };
    email_verified?: unknown;
  };
}

export type AvatarRefusalCode = 'unauthenticated' | 'permission-denied' | 'invalid-argument';

export type AvatarDecision =
  | { ok: true; uid: string; choice: AvatarChoice }
  | { ok: false; code: AvatarRefusalCode; message: string };

const ALLOWED_KEYS: ReadonlySet<string> = new Set(['kind', 'seed', 'showPublicly']);

/**
 * The payload, validated and rebuilt key by key, or `null` when any part of it
 * is wrong.
 *
 * **Rebuilt rather than passed through, and an unknown key refuses the whole
 * call** — the server-side equivalent of the exact-key `hasOnly()` allowlist
 * `CLAUDE.md` §4.1 would ask of a client-writable path, since there is no
 * client write rule here to carry one.
 *
 * `seed: null` is read as absent: the callable SDK encodes a present-but-
 * `undefined` key as `null`, so which of the two arrives depends on how the
 * caller spelled its object rather than on anything it meant (the same
 * tolerance `recordGameResult` extends to `answers`).
 */
export function parseAvatarChoice(payload: unknown): AvatarChoice | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const data = payload as Record<string, unknown>;
  if (Object.keys(data).some((key) => !ALLOWED_KEYS.has(key))) {
    return null;
  }

  const { kind, showPublicly } = data;
  const seed = data['seed'] ?? undefined;
  if (typeof showPublicly !== 'boolean') {
    return null;
  }
  if (kind === 'built') {
    return typeof seed === 'string' && AVATAR_SEED_PATTERN.test(seed)
      ? { kind, seed, showPublicly }
      : null;
  }
  if (kind === 'initials' || kind === 'photo') {
    // A seed on any other kind is refused rather than dropped: it is a
    // malformed request, and storing a seed beside `initials` would leave a
    // value on the document that means nothing.
    return seed === undefined ? { kind, showPublicly } : null;
  }
  return null;
}

/**
 * Whether this caller may store a choice: a non-anonymous account on an
 * allowlisted provider, and — for a password account — a verified address.
 *
 * Read from the verified token, never from the payload, and the same two facts
 * `isRealAuthedUser()` in `firestore.rules` reads for every other write a
 * player makes about themselves. The client mirrors it with
 * `AuthService.isFullyAuthenticated()`.
 */
function mayChooseAvatar(token: AvatarCaller['token']): boolean {
  const provider = token.firebase?.sign_in_provider;
  if (typeof provider !== 'string' || !AVATAR_PROVIDERS.has(provider)) {
    return false;
  }
  return provider !== 'password' || token.email_verified === true;
}

/**
 * The whole decision `setAvatar` makes before it writes anything.
 *
 * The messages are deliberately general. Which field of a payload was wrong is
 * not worth telling a caller who could only have produced it by bypassing the
 * app, and the client mirrors the caller gate, so neither refusal is something
 * a player using the app should ever see.
 */
export function decideAvatarChoice(
  caller: AvatarCaller | undefined,
  payload: unknown,
): AvatarDecision {
  if (!caller?.uid) {
    return { ok: false, code: 'unauthenticated', message: 'Sign in before choosing an avatar.' };
  }
  if (!mayChooseAvatar(caller.token)) {
    return {
      ok: false,
      code: 'permission-denied',
      message: 'Only a signed-in account with a verified email can choose an avatar.',
    };
  }
  const choice = parseAvatarChoice(payload);
  if (choice === null) {
    return { ok: false, code: 'invalid-argument', message: 'That avatar choice is not valid.' };
  }
  return { ok: true, uid: caller.uid, choice };
}

/**
 * Writes the choice onto `users/{uid}`, replacing the `avatar` field whole and
 * touching nothing else on the document.
 *
 * **`mergeFields: ['avatar']`, and neither of the two obvious calls.** A plain
 * `set` would replace the whole document and erase the player's lifetime
 * totals. `merge: true` merges *maps* deeply, so a `built` choice followed by
 * an `initials` one would keep the old `seed` under the new kind — a value
 * that means nothing, on a document whose shape `parseAvatarChoice` exists to
 * keep exact. Naming the field as the merge mask replaces exactly it, and
 * still creates the document for a player who has not finished a game yet.
 *
 * Takes the reference rather than resolving it, so a fake can see the options.
 */
export async function applyAvatarChoice(
  user: Pick<DocumentReference, 'set'>,
  choice: AvatarChoice,
): Promise<void> {
  await user.set({ avatar: choice }, { mergeFields: ['avatar'] });
}
