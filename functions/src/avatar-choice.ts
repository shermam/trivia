import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { type CallerToken, callerStanding, isVerifiedPlayer } from './caller-gate';
import { isSetUnlocked, readXp } from './levels';

/**
 * A player's avatar choice (`FEAT-038`), and the decision about who may store
 * one and from which sets (`FEAT-041`) — kept pure so each is unit-tested
 * without standing up Auth or Firestore, the same convention as `role.ts` and
 * `game-stats.ts` (`CLAUDE.md` §4.6).
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
 * **A seed names a variant rather than feeding a hash**, so that whole sets
 * lock and unlock by their name with no change to the stored field: it stays
 * one short string, and which sets a player may choose is a rule over the part
 * before the dash (`FEAT-041`, {@link lockedSetRefusal}). Each set decides what
 * its two digits mean — `core` and `bold` read them as a shape and a colour —
 * and a set is frozen once shipped, because a stored seed is a reference into
 * it.
 *
 * A pattern, and not a catalog of variants: it bounds what can be stored to
 * eleven characters of a known shape, and whether a set's digits name a shape
 * it has is the client's business (one past a table's end renders as
 * initials). Which **sets** exist is decided here, by the unlock table in
 * `levels.ts`. The digits are fixed-width, so every variant has exactly one
 * spelling.
 *
 * Must agree with `AVATAR_SEED_PATTERN` in `src/app/models/avatar.model.ts`.
 * This copy is the one that is enforced.
 */
export const AVATAR_SEED_PATTERN = /^[a-z]{1,8}-[0-9]{2}$/;

/** The slice of a callable's `request.auth` the decision reads. */
export interface AvatarCaller {
  uid: string;
  token: CallerToken;
}

export type AvatarRefusalCode = 'unauthenticated' | 'permission-denied' | 'invalid-argument';

export type AvatarDecision =
  | { ok: true; uid: string; choice: AvatarChoice }
  | { ok: false; code: AvatarRefusalCode; message: string };

/** A refusal, as `setAvatar` turns it into an `HttpsError`. */
export type AvatarRefusal = Extract<AvatarDecision, { ok: false }>;

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
  // The whole of the shared caller gate (`caller-gate.ts`): a provider the app
  // offers, and a verified address for a password account — the same two facts
  // `isRealAuthedUser()` reads for every other write a player makes about
  // themselves. Read from the verified token, never from the payload. The
  // picker mirrors it with `AuthService.isFullyAuthenticated()`, and offers
  // itself to every signed-in account, which is why the allowlist has to name
  // every provider the app offers (`CLAUDE.md` §4.2).
  if (!isVerifiedPlayer(callerStanding(caller.token))) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The refusal for a built avatar from a set the caller has not unlocked, or
 * `null` to store the choice (`FEAT-041`). `stored` is `users/{uid}` as the
 * transaction read it — `undefined` for a player with no document yet.
 *
 * **The server enforces the unlock, and the picker only mirrors it.** A seed
 * is a string any caller can send, so a set locked in the picker and open here
 * would be no lock at all (`CLAUDE.md` §4.2). The XP is the stored total,
 * which only `recordGameResult` writes, read the way `readXp` reads it: a
 * value a hand edit has broken unlocks nothing.
 *
 * **Never re-lock what was granted.** A seed equal to the one already stored
 * is accepted whatever its set's level is now, so moving a threshold above a
 * player who chose from that set leaves them wearing it — and lets them save
 * it again with the switch changed. What it protects is the stored seed: a
 * player who moves off it has to reach the set's level to choose from it
 * again, which is the only rule a single stored field can carry. Only a seed
 * stored under `kind: 'built'` counts, because no other kind is ever written
 * with one.
 */
export function lockedSetRefusal(choice: AvatarChoice, stored: unknown): AvatarRefusal | null {
  const seed = choice.kind === 'built' ? choice.seed : undefined;
  if (seed === undefined) {
    return null;
  }
  const document = isRecord(stored) ? stored : {};
  if (isSetUnlocked(seed.slice(0, seed.indexOf('-')), readXp(document['xp']))) {
    return null;
  }
  const current = document['avatar'];
  if (isRecord(current) && current['kind'] === 'built' && current['seed'] === seed) {
    return null;
  }
  return {
    ok: false,
    code: 'permission-denied',
    message: 'That avatar set is not unlocked yet.',
  };
}

/**
 * Writes the choice onto `users/{uid}` inside `setAvatar`'s transaction,
 * replacing the `avatar` field whole and touching nothing else on the
 * document — or, for a built avatar from a set the player has not unlocked,
 * writes nothing and returns the refusal (`lockedSetRefusal`).
 *
 * **Only a built avatar reads the document**, since only a seed has a set to
 * unlock; initials and the photo are written blind, as they always were. The
 * read and the write are one transaction, so the XP the unlock was decided on
 * is the XP on the document when the choice lands.
 *
 * **`mergeFields: ['avatar']`, and neither of the two obvious calls.** A plain
 * `set` would replace the whole document and erase the player's lifetime
 * totals and XP. `merge: true` merges *maps* deeply, so a `built` choice
 * followed by an `initials` one would keep the old `seed` under the new kind —
 * a value that means nothing, on a document whose shape `parseAvatarChoice`
 * exists to keep exact. Naming the field as the merge mask replaces exactly
 * it, and still creates the document for a player who has not finished a game
 * yet.
 *
 * Takes the transaction and the reference rather than opening one, so a fake
 * can see the read and the options — the split `applyGameResult` makes.
 */
export async function applyAvatarChoice(
  transaction: Transaction,
  user: DocumentReference,
  choice: AvatarChoice,
): Promise<AvatarRefusal | null> {
  if (choice.kind === 'built') {
    const snapshot = await transaction.get(user);
    const refusal = lockedSetRefusal(choice, snapshot.data());
    if (refusal) {
      return refusal;
    }
  }
  transaction.set(user, { avatar: choice }, { mergeFields: ['avatar'] });
  return null;
}
