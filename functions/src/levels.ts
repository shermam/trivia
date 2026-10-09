/**
 * Levels, and what a level unlocks (`FEAT-041`): the threshold table and the
 * unlock rule, in one module.
 *
 * **Dependency-free on purpose**, for the reason `caller-gate.ts` is. The app
 * carries its own copy (`src/app/models/levels.ts`) to draw the progress card
 * on `/profile` and to lock the avatar picker's sets, and `levels.spec.ts`
 * there imports this file across the package boundary to pin the two equal —
 * so it has to compile under the app's compiler settings as well as this
 * package's, and load in either test runner with nothing behind it.
 *
 * **A level is derived, never stored.** `users/{uid}.xp` is the only number
 * kept (`game-xp.ts` decides what one game adds to it); the level is
 * `levelFor(xp)` wherever it is needed. So nothing can hold a level that
 * disagrees with its own XP, and moving a threshold is a deploy rather than a
 * migration over every account.
 *
 * **What a level is for: unlocking a built-avatar set, and nothing else.** The
 * XP behind it is client-supplied and bounded rather than attested (audit
 * decision A1, `game-stats.ts`), so a level is worth a cosmetic its owner sees
 * and nothing anyone else does — it is shown on no public surface and readable
 * through no rule.
 */

/** The XP one level step is worth: level L is reached at `50 × L × (L + 1)`. */
const XP_PER_STEP = 50;

/**
 * The total XP at which `level` is reached — 0, 100, 300, 600, 1,000, 1,500 …
 *
 * Each level costs a hundred XP more than the one before it, so early levels
 * come within a few games and later ones take longer, without any level ever
 * becoming out of reach.
 */
export function xpForLevel(level: number): number {
  return XP_PER_STEP * level * (level + 1);
}

/**
 * The XP a stored value means: a whole, non-negative count, or 0.
 *
 * Only `recordGameResult` writes `xp`, and it only ever writes such a count —
 * but `users/{uid}` is a document the console can edit, and a reader has to be
 * right regardless of the writer (`CLAUDE.md` §4.4). Anything else reads as
 * none, which **fails closed** where it matters: `setAvatar` reading a broken
 * value unlocks nothing rather than everything.
 */
export function readXp(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * The level `xp` has reached: the largest L with `xpForLevel(L) <= xp`.
 *
 * A loop over the thresholds rather than the closed-form square root, because
 * the thresholds are integers and stepping through them is exact, where a
 * floating-point root can land a hair either side of one. Levels grow
 * quadratically, so it runs about `√(xp / 50)` times — 141 at a million XP.
 */
export function levelFor(xp: number): number {
  const total = readXp(xp);
  let level = 0;
  while (xpForLevel(level + 1) <= total) {
    level += 1;
  }
  return level;
}

/**
 * The level each built-avatar set unlocks at, by the name a seed uses —
 * `<set>-<shape><colour>`, so `bold-21` is in `bold` (`FEAT-038`,
 * `avatar-choice.ts`).
 *
 * **A set this table does not name is locked**, and that is the fail-closed
 * half of the rule: a seed naming one is refused by `setAvatar`, so a set the
 * app adds later has to be added here before anybody can choose it. The app's
 * `BUILT_AVATAR_SETS` and this table are held to the same names by
 * `levels.spec.ts`.
 *
 * **Moving a threshold never re-locks what was granted.** `setAvatar` accepts
 * a seed equal to the one already stored whatever its set's level now is, and
 * the app draws a stored seed whatever the table says — so raising `bold`
 * after somebody chose a bold avatar leaves them wearing it.
 */
export const AVATAR_SET_UNLOCK_LEVELS: Readonly<Record<string, number>> = Object.freeze({
  core: 0,
  bold: 3,
});

/** Whether a set is unlocked at `xp`. Unknown sets are not. */
export function isSetUnlocked(set: string, xp: number): boolean {
  return (
    Object.hasOwn(AVATAR_SET_UNLOCK_LEVELS, set) && AVATAR_SET_UNLOCK_LEVELS[set] <= levelFor(xp)
  );
}

/** Every set unlocked at `xp`, in the table's order — `core` always among them. */
export function unlockedSets(xp: number): string[] {
  return Object.keys(AVATAR_SET_UNLOCK_LEVELS).filter((set) => isSetUnlocked(set, xp));
}
