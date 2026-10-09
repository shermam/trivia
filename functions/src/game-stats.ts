/**
 * The decision behind `users/{uid}` — what a completed game does to a
 * player's lifetime totals, what it leaves in their play history, and what it
 * adds to each community question's difficulty counters.
 *
 * Kept as a pure function, separate from the callable, for the reason
 * `role.ts` and `account-policy.ts` are: `CLAUDE.md` §4.6 requires a Cloud
 * Function making a security decision to have a direct unit test for that
 * decision, and that stays cheap only while the decision does not need Auth
 * and Firestore standing up behind it.
 */
import {
  type PlayAnswer,
  type PlayRecord,
  isSafeDocumentId,
  isValidPlayAnswers,
  playRecordFrom,
} from './play-history';
import { type QuestionCounterIncrement, counterIncrementsFrom } from './question-counters';
import { type DailyGames, nextDailyGames } from './daily-ceiling';
import {
  MAX_GAME_ID_LENGTH,
  hasLegacyGameId,
  recentGameIdsOf,
  withRecentGame,
} from './recent-games';

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
 * What it does buy is **stat integrity**: the ring of recent game ids stops
 * the same game being banked twice (`recent-games.ts`), but nothing stops a
 * client minting fresh ids in a loop and inflating its own totals, and this is
 * what bounds that by the hour — as `DAILY_GAME_CEILING` bounds it by the day
 * (`daily-ceiling.ts`), which is what stops an hour's worth repeating around
 * the clock. Between them they bound what one account can make this callable
 * write; the invocation itself is still unprotected — closing that needs App
 * Check or a `maxInstances` ceiling. Do not read either constant as
 * discharging §4.1.
 *
 * 60/hour sits far above any real play rate — the shortest possible game is
 * five questions on a 15-second clock.
 */
export const MAX_GAMES_PER_WINDOW = 60;

const WINDOW_MS = 60 * 60 * 1000;

/**
 * The totals as stored. Every field here is written by this module and
 * nothing else — but they are not the only fields on the document: `setAvatar`
 * keeps the player's avatar choice beside them (`FEAT-038`), which is why the
 * write merges rather than replaces (`game-result.ts`).
 */
export interface UserStats {
  gamesPlayed: number;
  questionsAnswered: number;
  correctAnswers: number;
  /** Longest run of consecutive correct answers **within a single game**. */
  bestStreak: number;
  /**
   * The last games banked, newest first, so a reload of `/game-over` — or a
   * second tab, or a retried call — cannot bank one twice (`recent-games.ts`).
   */
  recentGameIds: string[];
  /** The games banked on one UTC day, against the daily ceiling (`daily-ceiling.ts`). */
  dailyGames: DailyGames;
  /** When these totals started accumulating — what makes the word "lifetime" honest. */
  statsSince: number;
  updatedAt: number;
  rateWindowStart: number;
  gamesInWindow: number;
}

/**
 * `users/{uid}` as the transaction reads it: any of the totals, possibly none
 * of them, and — on a document no game has banked on since the ring replaced
 * it — the single `lastGameId` the ring migrates from (`recent-games.ts`).
 */
export type StoredUserStats = Partial<UserStats> & { lastGameId?: unknown };

/** What the client claims about a finished game. Bounded here; never trusted as given. */
export interface GameResultSubmission {
  gameId: string;
  totalQuestions: number;
  correctAnswers: number;
  bestStreak: number;
  /**
   * One record per question, in the order they were asked (`FEAT-049`).
   *
   * **Optional, and "no history" is a first-class case rather than an error.**
   * A browser still running a bundle from before this field existed sends
   * nothing, and so does a game restored from a save whose per-answer history
   * could not be trusted to line up with its questions — both are games worth
   * banking into the totals, and rejecting them to protect a history that is
   * not the point of the call would cost more than it buys.
   *
   * `null` means the same as absent, and has to: the callable SDK encodes a
   * present-but-`undefined` key as `null`, so which of the two arrives is
   * decided by how the caller spelled its object literal rather than by
   * anything about the game (`playRecordFrom`).
   */
  answers?: PlayAnswer[] | null;
}

export type RejectionReason = 'invalid' | 'duplicate' | 'daily-limit' | 'rate-limited';

export type StatsDecision =
  | {
      accepted: true;
      /** The id this game banks under — the ring's newest entry, and its play-history document's id. */
      gameId: string;
      stats: UserStats;
      /**
       * Whether the stored document still carries the `lastGameId` the ring
       * replaced, which this write deletes — the migration's second half, the
       * first being `recentGameIdsOf` reading it as a ring of one.
       */
      dropsLastGameId: boolean;
      /**
       * The play-history document to write beside the totals, or `null` when
       * the submission carried no per-answer records. Decided here so the
       * transaction writes what the decision says rather than re-deriving it.
       */
      play: PlayRecord | null;
      /**
       * What this game adds to each bank question's difficulty counters
       * (`FEAT-023`), one entry per question it named — empty for a game with
       * no history, or one drawn wholly from Open Trivia DB.
       *
       * **Only an accepted decision carries any**, which is the whole of how a
       * refused submission moves no counter: a duplicate, or a call over the
       * daily ceiling or the hourly window, returns before this exists, so
       * there is nothing for the transaction to apply.
       */
      counters: QuestionCounterIncrement[];
    }
  | { accepted: false; reason: RejectionReason };

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
  const { gameId, totalQuestions, correctAnswers, bestStreak, answers } = submission as Record<
    string,
    unknown
  >;

  if (typeof gameId !== 'string' || gameId.length === 0 || gameId.length > MAX_GAME_ID_LENGTH) {
    return false;
  }
  // It names `users/{uid}/plays/{gameId}` (`FEAT-049`). Every id the app mints
  // is a `crypto.randomUUID()`, so refusing a path-shaped one costs nothing
  // real, and it means one rejected submission rather than an `internal` error
  // from inside the transaction.
  if (!isSafeDocumentId(gameId)) {
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
  // The per-answer history, when there is one. Bounded against this same
  // submission's own question count, so an array cannot describe a different
  // game from the one being banked (`play-history.ts`). `null` is let through
  // beside `undefined` because the SDK turns one into the other in transit —
  // refusing it would drop the totals of a game that simply had no history.
  if (answers != null && !isValidPlayAnswers(answers, totalQuestions)) {
    return false;
  }
  return true;
}

/**
 * The totals after banking one completed game, or the reason it was refused.
 *
 * **Order is load-bearing: the duplicate check runs before both budgets.** A
 * duplicate is the ordinary case this function exists for — `/game-over`
 * survives a reload by design, and a callable that times out gets retried — so
 * charging it a slot would let a player with a flaky connection exhaust an
 * hour's budget on one game, and answering it `daily-limit` would have
 * `/profile` tell a player that a game which counted did not. Pinned by tests
 * that submit a repeat id at a full window and at a full day and expect
 * `duplicate` both times.
 *
 * **The day is judged before the hour.** Over both, the day is the refusal
 * that is still true an hour from now, and the one `/profile` can say
 * something useful about — when the count starts again.
 *
 * **`current` may be a document that holds no totals at all.** A player who
 * chooses an avatar before finishing a game has a `users/{uid}` carrying only
 * that choice (`FEAT-038`), so "the document exists" no longer means "the
 * totals exist" — and every field here is read as possibly absent. The one
 * that mattered was the rate window: `nowMs - undefined` is `NaN`, which
 * compares false against the window length, so the window read as still open,
 * `gamesInWindow` became `undefined + 1`, and the write was refused for an
 * `undefined` field — every game that player finished, forever.
 */
export function nextUserStats(
  current: StoredUserStats | null,
  submission: GameResultSubmission,
  nowMs: number,
): StatsDecision {
  if (!isValidSubmission(submission)) {
    return { accepted: false, reason: 'invalid' };
  }

  // The last twenty games banked, the old single `lastGameId` read as a ring of
  // one, and a malformed ring as none (`recent-games.ts`).
  const recentGameIds = recentGameIdsOf(current);
  if (recentGameIds.includes(submission.gameId)) {
    return { accepted: false, reason: 'duplicate' };
  }

  // A counter for another UTC day, or a malformed one, is no counter.
  const dailyGames = nextDailyGames(current?.dailyGames, nowMs);
  if (dailyGames === null) {
    return { accepted: false, reason: 'daily-limit' };
  }

  // A window that has rolled starts again at zero. Comparing elapsed time
  // against the stored start rather than bucketing on a computed slot id, so
  // there is no `string(math.floor(...))` equivalent to get wrong — that trap
  // belongs to the rules language, and this is TypeScript, but the shape of
  // the mistake travels. A window with no recorded start has rolled: there is
  // nothing in it to count.
  const windowStart = current?.rateWindowStart;
  const openWindowStart =
    typeof windowStart === 'number' &&
    Number.isFinite(windowStart) &&
    nowMs - windowStart < WINDOW_MS
      ? windowStart
      : null;
  const gamesInWindow = openWindowStart === null ? 0 : (current?.gamesInWindow ?? 0);

  if (gamesInWindow >= MAX_GAMES_PER_WINDOW) {
    return { accepted: false, reason: 'rate-limited' };
  }

  return {
    accepted: true,
    gameId: submission.gameId,
    stats: {
      gamesPlayed: (current?.gamesPlayed ?? 0) + 1,
      questionsAnswered: (current?.questionsAnswered ?? 0) + submission.totalQuestions,
      correctAnswers: (current?.correctAnswers ?? 0) + submission.correctAnswers,
      bestStreak: Math.max(current?.bestStreak ?? 0, submission.bestStreak),
      recentGameIds: withRecentGame(recentGameIds, submission.gameId),
      dailyGames,
      // Written once, on create, and never again — including when the clock
      // has gone backwards, which is why this reads the stored value rather
      // than `Math.min`.
      statsSince: current?.statsSince ?? nowMs,
      updatedAt: nowMs,
      rateWindowStart: openWindowStart ?? nowMs,
      gamesInWindow: gamesInWindow + 1,
    },
    dropsLastGameId: hasLegacyGameId(current),
    // Written in the same transaction as the totals and keyed by the same game
    // id, so the duplicate check above governs both: a retried call rewrites
    // nothing rather than appending a second copy of the round.
    play: playRecordFrom(submission.answers, nowMs),
    // Counted from the same validated records rather than from a second list
    // the payload would have to carry, and decided only past the duplicate
    // check and both budgets above — so the ring that stops a retried call
    // counting the game twice into the totals stops it counting twice here.
    counters: counterIncrementsFrom(submission.answers),
  };
}
