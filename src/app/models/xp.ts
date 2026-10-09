/**
 * The XP a stored `users/{uid}.xp` means (`FEAT-041`): a whole, non-negative
 * count, or 0 for anything else — the reading `functions/src/levels.ts` gives
 * the field, re-exported by `levels.ts` and pinned equal to it there by
 * `levels.spec.ts`.
 *
 * **A module of its own so the read stays off the critical path's level
 * table.** `FirebaseService`, which is in the initial bundle, reads the field;
 * esbuild places a module in one chunk whole, so importing this from
 * `levels.ts` would put the level table and the unlock rule — wanted only on
 * `/profile` — in every route's initial chunks for the sake of one function.
 */
export function readXp(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
