/**
 * The daily ceiling on what `recordGameResult` banks for one account: at most
 * {@link DAILY_GAME_CEILING} games per UTC day, counted on `users/{uid}` as
 * `dailyGames: { day, count }` inside the transaction that banks the game.
 *
 * **A backstop, not the tier rule.** The free tier's five games a day is the
 * app's (`DailyGameLimitService`), device-local and a conversion nudge rather
 * than an entitlement boundary; Pro has no limit at all. Nothing here changes
 * either. What this bounds is what one account can make the callable *write*:
 * with only the hourly window, a script could bank sixty games an hour around
 * the clock — 1,440 a day, every one of them a totals write, a play-history
 * document, up to twenty-five question counters and up to 800 XP, which is
 * 1,152,000 XP and level 151 by the end of the first day.
 *
 * **Why 200.** It is set where no honest player arrives, Pro included. The
 * hourly window already holds every account to sixty games an hour
 * (`game-stats.ts`), so reaching 200 takes at least three hours and twenty
 * minutes at that maximum — a five-question game every minute, every minute.
 * At the default ten questions and a real reading pace, with each answer
 * holding the next question back two seconds, a game takes about two minutes
 * from setup to results, and 200 of them is the better part of seven hours of
 * nothing else. For a forger it is the ceiling that matters: 200 games is at
 * most 160,000 XP a day (level 56) and at most 5,400 document writes — one
 * totals write, one play-history document and up to twenty-five question
 * counters a game — where the hourly window alone allowed seven times that.
 *
 * **What it does not bound is the invocation.** A callable is billed before
 * anything here is read, so a refused call still costs an invocation and the
 * one document read the transaction makes — only the writes stop. Closing that
 * wants App Check or a `maxInstances` ceiling, as it did before; this is not
 * `CLAUDE.md` §4.1's volume cap on a client-writable trigger, and it does not
 * claim to be.
 *
 * **A UTC day**, because it is the same day for every account and every server
 * instance, and needs no time zone the server could only guess at — `/profile`
 * says the count starts again at midnight UTC.
 *
 * Dependency-free on purpose: the app's copy of the ceiling
 * (`src/app/models/daily-ceiling.ts`), which `/profile` names when it refuses
 * a game, is pinned equal to this one by a spec that imports this file across
 * the package boundary — so it has to compile under the app's compiler settings
 * and load in either test runner with nothing behind it.
 */

/** The most games one account may bank in one UTC day. */
export const DAILY_GAME_CEILING = 200;

/** The day's counter as stored: the UTC day it counts, and the games banked in it. */
export interface DailyGames {
  /** `YYYY-MM-DD`, in UTC. */
  day: string;
  count: number;
}

/** The UTC calendar day an instant falls in, as `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * How many games a stored counter says were banked on `day`.
 *
 * Its count when it counts that day and the count is a whole, non-negative
 * number; otherwise none. **A counter for any other day is no counter** — that
 * is the whole of the reset, so nothing has to run at midnight, and a day in
 * the future (a hand edit, or a clock that went backwards) resets the same way
 * a day in the past does. **A malformed one reads as empty**, as `readXp` reads
 * a broken XP: only `recordGameResult` writes the field, so anything else is a
 * hand edit in the console. A count above the ceiling is well formed, and
 * refuses — which is what lowering the ceiling in a deploy has to do.
 */
export function gamesBankedOn(stored: unknown, day: string): number {
  if (typeof stored !== 'object' || stored === null) {
    return 0;
  }
  const { day: storedDay, count } = stored as Record<string, unknown>;
  return storedDay === day && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    ? count
    : 0;
}

/**
 * The counter once one more game has banked at `nowMs`, or `null` when the
 * day's ceiling is already reached and the game must be refused.
 *
 * A refused game moves nothing — the counter included, since a refusal writes
 * no document at all — so the call after it is judged on the same count.
 */
export function nextDailyGames(stored: unknown, nowMs: number): DailyGames | null {
  const day = utcDay(nowMs);
  const count = gamesBankedOn(stored, day);
  return count >= DAILY_GAME_CEILING ? null : { day, count: count + 1 };
}
