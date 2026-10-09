/**
 * Levels, and what a level unlocks (`FEAT-041`) — the app's copy of
 * `functions/src/levels.ts`, which is the one `setAvatar` enforces.
 *
 * **A copy, held equal by a test rather than imported.** The functions package
 * has its own `tsconfig` and its own build, so the app does not import from
 * it at run time; `levels.spec.ts` imports both across the package boundary
 * and pins every function and the table equal, so the two cannot drift
 * without a red test. A client that thought a set was unlocked when the server
 * did not would offer a choice that can never save (`CLAUDE.md` §4.2).
 *
 * **The level is derived from `users/{uid}.xp`, never stored**, and nothing
 * here is shown to anyone but the player it belongs to: the XP is bounded,
 * not attested (audit decision A1), so it unlocks a cosmetic and appears on no
 * public surface.
 */

/** The XP one level step is worth: level L is reached at `50 × L × (L + 1)`. */
const XP_PER_STEP = 50;

/** The total XP at which `level` is reached — 0, 100, 300, 600, 1,000, 1,500 … */
export function xpForLevel(level: number): number {
  return XP_PER_STEP * level * (level + 1);
}

/** The XP a stored value means: a whole, non-negative count, or 0 for anything else. */
export function readXp(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * The level `xp` has reached: the largest L with `xpForLevel(L) <= xp`.
 * Stepped through rather than solved with a square root, which can land a hair
 * either side of an integer threshold; it runs about `√(xp / 50)` times.
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
 * The level each built-avatar set unlocks at, by the name a seed uses
 * (`<set>-<shape><colour>`). A set this table does not name is locked;
 * `levels.spec.ts` holds its names to `BUILT_AVATAR_SETS`'.
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

/** Where `xp` stands between two levels — what the progress card draws. */
export interface LevelProgress {
  level: number;
  xp: number;
  /** The XP the next level is reached at. */
  nextLevelXp: number;
  /** XP earned since this level was reached: `0 <= into < span`. */
  into: number;
  /** The XP between this level and the next. */
  span: number;
}

/** {@link LevelProgress} for a total. App-only: the server needs no more than the level. */
export function levelProgress(xp: number): LevelProgress {
  const total = readXp(xp);
  const level = levelFor(total);
  const floor = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  return { level, xp: total, nextLevelXp, into: total - floor, span: nextLevelXp - floor };
}

/** The next set a player at `xp` has still to unlock, or `null` when every set is theirs. */
export function nextUnlock(xp: number): { set: string; level: number } | null {
  const level = levelFor(xp);
  for (const [set, unlockLevel] of Object.entries(AVATAR_SET_UNLOCK_LEVELS)) {
    if (unlockLevel > level) {
      return { set, level: unlockLevel };
    }
  }
  return null;
}
