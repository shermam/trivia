/**
 * Streak bonuses and score multipliers (`FEAT-004`) — the whole scoring
 * decision, as pure functions with no Angular in sight.
 *
 * Separate from `GameControllerService` for the reason `functions/src/role.ts`
 * is separate from its callable: `CLAUDE.md` §4.6 wants the decision that
 * reaches a public ranking covered by a direct unit test, and that stays cheap
 * only while the decision does not need a `TestBed` behind it.
 */

/**
 * The ceiling a streak multiplier can reach, and therefore the factor by which
 * a run can beat its own question count.
 *
 * **Duplicated in `firestore.rules` (`maxScoreMultiplier()`), and the rules
 * copy is the authority.** A public ranking a player writes about themselves
 * has to be server-attested or hard-bounded (`CLAUDE.md` §4.1); this is the
 * hard bound, so the client cannot be the one that decides it. What this
 * constant buys is the *other* end of the same rule — the client must never
 * send a score the rules will refuse, because the refusal arrives as a bare
 * `permission-denied` that nothing can honestly narrate to the player
 * (`CLAUDE.md` §4.4). The two are pinned equal by a test in
 * `firestore-tests/leaderboards.rules.spec.ts`, which reads the number out of
 * the rules file rather than trusting this one.
 *
 * Three, because it is worth chasing and still small enough to mean something:
 * a perfect 25-question run tops out at 75 rather than at anything a hand-
 * written document could claim.
 */
export const MAX_SCORE_MULTIPLIER = 3;

/**
 * What one correct answer is worth before the multiplier.
 *
 * One, and that is load-bearing rather than arbitrary: it is what makes the
 * rules bound `score <= totalQuestions * MAX_SCORE_MULTIPLIER` the right
 * expression, and it keeps a multiplied score comparable with every entry
 * already on the boards, which were all won at one point per question. A
 * larger base would bury those entries under a change of unit rather than a
 * change of skill.
 */
export const BASE_QUESTION_POINTS = 1;

/**
 * The multiplier tiers, longest streak first so the first match wins.
 *
 * A table rather than a chain of `if`s because the boundaries are the
 * specification — 1–2 plain, 3–4 at 1.5×, 5–7 at 2×, 8 and up at 3× — and a
 * table is the shape that can be read against it.
 */
export const STREAK_TIERS: readonly { readonly minStreak: number; readonly multiplier: number }[] =
  [
    { minStreak: 8, multiplier: 3 },
    { minStreak: 5, multiplier: 2 },
    { minStreak: 3, multiplier: 1.5 },
    { minStreak: 0, multiplier: 1 },
  ];

/** The streak at which the indicator appears — one short of the first bonus tier. */
export const STREAK_INDICATOR_THRESHOLD = 2;

/**
 * What the answer that *reached* this streak is worth, as a multiple of the
 * base.
 *
 * Note the tense: the streak is incremented first and then read, so the third
 * consecutive correct answer earns 1.5× rather than earning 1× and promoting
 * the one after it. That is what the tier table means by "3–4 Correct: 1.5×".
 */
export function multiplierForStreak(streak: number): number {
  return STREAK_TIERS.find((tier) => streak >= tier.minStreak)?.multiplier ?? 1;
}

/** Points earned by a correct answer that took the run to `streak`. */
export function pointsForStreak(streak: number): number {
  return BASE_QUESTION_POINTS * multiplierForStreak(streak);
}

/**
 * The score as it is shown and as it is saved: the exact point total, rounded.
 *
 * **The rounding exists because a 1.5× tier and a one-point base make half
 * points unavoidable**, and `firestore.rules` requires `score` to be an `int`
 * — a bound deliberately left unchanged when the multiplier ceiling was
 * widened. Rounding only at the leaderboard boundary was the obvious
 * alternative and is worse: the player would watch a 7.5 all the way through
 * the results screen and find an 8 on the board. One number, integral
 * everywhere, is the version nobody has to reconcile.
 *
 * Rounding cannot break the bound in either direction: the exact total is at
 * most `MAX_SCORE_MULTIPLIER` per question, and rounding a value at or below
 * an integer ceiling cannot cross it.
 */
export function displayScore(points: number): number {
  return Math.round(points);
}

/**
 * The most a game of this length may score, which is exactly what
 * `firestore.rules` will accept.
 *
 * Used by the persistence layer to bound a restored total, so a hand-edited
 * IndexedDB record cannot put the client on the wrong side of the rule it is
 * meant to satisfy.
 */
export function maxScoreFor(totalQuestions: number): number {
  return totalQuestions * MAX_SCORE_MULTIPLIER;
}

/**
 * How the multiplier is written on screen — always one decimal place, so
 * `×1.0` and `×1.5` are the same width.
 *
 * That is the whole reason it is a function: the indicator sits in a card
 * header that must not resize when a streak starts (`CLAUDE.md` §4.4), and
 * fixed-width text with `tabular-nums` makes the states identical by
 * construction rather than by a reserved box somebody has to re-measure.
 */
export function multiplierLabel(multiplier: number): string {
  return multiplier.toFixed(1);
}
