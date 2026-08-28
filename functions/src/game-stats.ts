/**
 * The decision behind `users/{uid}` — what a completed game does to a
 * player's lifetime totals.
 *
 * Kept as a pure function, separate from the callable, for the reason
 * `role.ts` and `account-policy.ts` are: `CLAUDE.md` §4.6 requires a Cloud
 * Function making a security decision to have a direct unit test for that
 * decision, and that stays cheap only while the decision does not need Auth
 * and Firestore standing up behind it.
 */

/** The most questions a single game can hold — the setup form's own maximum. */
export const MAX_QUESTIONS_PER_GAME = 25;

/**
 * How many games one account may bank per rolling hour.
 *
 * **This is not `CLAUDE.md` §4.1's volume cap, and saying so plainly matters
 * more than the number does.** §4.1's cap exists because a client-writable
 * path that triggers a Cloud Function lets a user spend your Functions quota
 * in a loop; here the trigger is a *callable invoked directly*, so the
 * invocation is already billed by the time this counter is read. The 61st call
 * costs exactly what the 1st did.
 *
 * What it does buy is **stat integrity**: `lastGameId` stops the same game
 * being banked twice, but nothing stops a client minting fresh ids in a loop
 * and inflating its own totals, and this is what bounds that. Quota on this
 * path is genuinely unprotected — closing it needs App Check or a
 * `maxInstances` ceiling, and neither is in this change. Do not read this
 * constant as discharging §4.1.
 *
 * 60/hour sits far above any real play rate — the shortest possible game is
 * five questions on a 15-second clock — and far below anything that distorts a
 * lifetime total.
 */
export const MAX_GAMES_PER_WINDOW = 60;

const WINDOW_MS = 60 * 60 * 1000;

/** The totals as stored. Every field is written by this module and nothing else. */
export interface UserStats {
  gamesPlayed: number;
  questionsAnswered: number;
  correctAnswers: number;
  /** Longest run of consecutive correct answers **within a single game**. */
  bestStreak: number;
  /** The last game banked, so a reload of `/game-over` cannot bank it twice. */
  lastGameId: string;
  /** When these totals started accumulating — what makes the word "lifetime" honest. */
  statsSince: number;
  updatedAt: number;
  rateWindowStart: number;
  gamesInWindow: number;
}

/** What the client claims about a finished game. Bounded here; never trusted as given. */
export interface GameResultSubmission {
  gameId: string;
  totalQuestions: number;
  correctAnswers: number;
  bestStreak: number;
}

export type RejectionReason = 'invalid' | 'duplicate' | 'rate-limited';

export type StatsDecision =
  { accepted: true; stats: UserStats } | { accepted: false; reason: RejectionReason };

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Whether a submission is self-consistent and within the bounds a real game
 * could produce.
 *
 * These are the "hard-bounded" half of `CLAUDE.md` §4.1 — the totals are
 * **not** server-attested, because the payload is still client-supplied, and
 * that is audit decision A1 adopted deliberately. What the bounds buy is that
 * no single call can move a total by more than one honest game's worth.
 */
export function isValidSubmission(submission: unknown): submission is GameResultSubmission {
  if (typeof submission !== 'object' || submission === null) {
    return false;
  }
  const { gameId, totalQuestions, correctAnswers, bestStreak } = submission as Record<
    string,
    unknown
  >;

  if (typeof gameId !== 'string' || gameId.length === 0 || gameId.length > 128) {
    return false;
  }
  if (!isNonNegativeInt(totalQuestions) || totalQuestions < 1) {
    return false;
  }
  if (totalQuestions > MAX_QUESTIONS_PER_GAME) {
    return false;
  }
  if (!isNonNegativeInt(correctAnswers) || correctAnswers > totalQuestions) {
    return false;
  }
  // A streak is a run of correct answers, so it can never exceed how many
  // there were. Checked against `correctAnswers` rather than `totalQuestions`
  // because the looser bound would admit a 25-streak on a game with 3 right.
  if (!isNonNegativeInt(bestStreak) || bestStreak > correctAnswers) {
    return false;
  }
  return true;
}

/**
 * The totals after banking one completed game, or the reason it was refused.
 *
 * **Order is load-bearing: the duplicate check runs before the rate window.**
 * A duplicate is the ordinary case this function exists for — `/game-over`
 * survives a reload by design, and a callable that times out gets retried — so
 * charging it a slot would let a player with a flaky connection exhaust an
 * hour's budget on one game. Pinned by a test that submits a repeat id at a
 * full window and expects `duplicate`, not `rate-limited`.
 */
export function nextUserStats(
  current: UserStats | null,
  submission: GameResultSubmission,
  nowMs: number,
): StatsDecision {
  if (!isValidSubmission(submission)) {
    return { accepted: false, reason: 'invalid' };
  }

  if (current !== null && current.lastGameId === submission.gameId) {
    return { accepted: false, reason: 'duplicate' };
  }

  // A window that has rolled starts again at zero. Comparing elapsed time
  // against the stored start rather than bucketing on a computed slot id, so
  // there is no `string(math.floor(...))` equivalent to get wrong — that trap
  // belongs to the rules language, and this is TypeScript, but the shape of
  // the mistake travels.
  const windowRolled = current === null || nowMs - current.rateWindowStart >= WINDOW_MS;
  const gamesInWindow = windowRolled ? 0 : current.gamesInWindow;

  if (gamesInWindow >= MAX_GAMES_PER_WINDOW) {
    return { accepted: false, reason: 'rate-limited' };
  }

  return {
    accepted: true,
    stats: {
      gamesPlayed: (current?.gamesPlayed ?? 0) + 1,
      questionsAnswered: (current?.questionsAnswered ?? 0) + submission.totalQuestions,
      correctAnswers: (current?.correctAnswers ?? 0) + submission.correctAnswers,
      bestStreak: Math.max(current?.bestStreak ?? 0, submission.bestStreak),
      lastGameId: submission.gameId,
      // Written once, on create, and never again — including when the clock
      // has gone backwards, which is why this reads the stored value rather
      // than `Math.min`.
      statsSince: current?.statsSince ?? nowMs,
      updatedAt: nowMs,
      rateWindowStart: windowRolled ? nowMs : current.rateWindowStart,
      gamesInWindow: gamesInWindow + 1,
    },
  };
}
