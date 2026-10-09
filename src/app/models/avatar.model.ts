/**
 * A player's avatar choice (`FEAT-038`) as `users/{uid}.avatar` stores it, and
 * the reader every surface goes through.
 *
 * The `setAvatar` callable is the only writer (`functions/src/avatar-choice.ts`
 * validates everything there); this side only ever *reads*, so it is lenient
 * where the server is strict — a document the console edited, or one a later
 * version of the app wrote, renders as initials rather than as an error.
 */

export type AvatarKind = 'initials' | 'photo' | 'built';

export interface AvatarChoice {
  readonly kind: AvatarKind;
  /** Which built avatar, for `built` only — a variant's name, never a URL. */
  readonly seed?: string;
  /**
   * Whether the choice may appear where another player can see it. Nothing
   * public shows an avatar yet; a later surface has to ask this first.
   */
  readonly showPublicly: boolean;
}

/** What every account shows until it chooses otherwise, and every failure falls back to. */
export const DEFAULT_AVATAR_CHOICE: AvatarChoice = { kind: 'initials', showPublicly: false };

/**
 * A built avatar's seed: `<set>-<two digits>`. Must agree with
 * `AVATAR_SEED_PATTERN` in `functions/src/avatar-choice.ts`, which is the copy
 * that is enforced and where the grammar is explained.
 */
export const AVATAR_SEED_PATTERN = /^[a-z]{1,8}-[0-9]{2}$/;

/**
 * The stored choice, read leniently: anything this build cannot use reads as
 * the default rather than as an error.
 *
 * **`showPublicly` is `true` only when the document says exactly `true`.** A
 * document that never set it, a hand-edited `"true"`, a number — all `false`.
 * That is the owner's condition on this feature ("we should give the user the
 * choice of not showing their photo"), and the one place it is decided for
 * every reader.
 */
export function readAvatarChoice(raw: unknown): AvatarChoice {
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_AVATAR_CHOICE;
  }
  const { kind, seed, showPublicly } = raw as Record<string, unknown>;
  const isPublic = showPublicly === true;
  if (kind === 'built' && typeof seed === 'string' && AVATAR_SEED_PATTERN.test(seed)) {
    return { kind, seed, showPublicly: isPublic };
  }
  if (kind === 'photo') {
    return { kind, showPublicly: isPublic };
  }
  return { kind: 'initials', showPublicly: isPublic };
}

/**
 * The one host a provider photo may come from: Google's image server.
 *
 * It is the origin `img-src` and `connect-src` in `firebase.json` admit, and
 * the one `RUNTIME_ORIGINS` in `scripts/csp-rules.mjs` declares, so a photo
 * anywhere else would be refused by the browser. Filtering here is what stops
 * the picker offering a choice that can only ever resolve to initials — a
 * Facebook or GitHub picture lives on a host the policy does not name.
 */
export const PROVIDER_PHOTO_ORIGIN = 'https://lh3.googleusercontent.com';

/**
 * The account's `photoURL` when it is on {@link PROVIDER_PHOTO_ORIGIN}, else
 * `null`. Compared as a parsed origin, never as a string prefix, so
 * `https://lh3.googleusercontent.com@elsewhere.example/` is not mistaken for it.
 */
export function providerPhotoUrl(photoURL: string | null | undefined): string | null {
  if (!photoURL) {
    return null;
  }
  try {
    return new URL(photoURL).origin === PROVIDER_PHOTO_ORIGIN ? photoURL : null;
  } catch {
    return null;
  }
}

/**
 * The letter an initials avatar shows: the first of the display name, else of
 * the email address, uppercased — `?` when there is neither.
 */
export function avatarLetter(
  user: { displayName?: string | null; email?: string | null } | null | undefined,
): string {
  const source = user?.displayName || user?.email || '';
  return source.trim().charAt(0).toUpperCase() || '?';
}
