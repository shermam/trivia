import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gamesBankedOn, nextDailyGames, utcDay } from './daily-ceiling';

/**
 * The daily ceiling on what `recordGameResult` banks (`daily-ceiling.ts`): the
 * UTC day, the counter that resets with it, and the 200th and 201st game.
 *
 * **Every number is written out, never read from the module**, for the reason
 * `caller-gate.test.ts` writes its lists out: a row computed from
 * `DAILY_GAME_CEILING` moves with it, so moving the ceiling would pass the very
 * test that exists to notice.
 */

/** Midday, 9 October 2026, UTC. */
const NOON = Date.UTC(2026, 9, 9, 12, 0, 0);
/** The last millisecond of 9 October 2026, UTC. */
const LAST_MOMENT = Date.UTC(2026, 9, 9, 23, 59, 59, 999);
/** The first millisecond of 10 October 2026, UTC. */
const MIDNIGHT = Date.UTC(2026, 9, 10, 0, 0, 0, 0);

describe('utcDay', () => {
  it('names the UTC calendar day an instant falls in', () => {
    assert.equal(utcDay(NOON), '2026-10-09');
    assert.equal(utcDay(Date.UTC(2026, 0, 5, 3, 4, 5)), '2026-01-05');
  });

  /**
   * **The rollover is at midnight UTC and nowhere else** — the boundary
   * `/profile` names when it refuses a game.
   */
  it('changes day between 23:59:59.999 and 00:00:00.000 UTC', () => {
    assert.equal(utcDay(Date.UTC(2026, 9, 9, 23, 59, 59)), '2026-10-09');
    assert.equal(utcDay(LAST_MOMENT), '2026-10-09');
    assert.equal(utcDay(MIDNIGHT), '2026-10-10');
  });
});

describe('nextDailyGames', () => {
  // Accept cases first (`CLAUDE.md` §4.6): a ceiling that refused everything
  // would pass every refusal row below.
  it('counts the first game of a day as one', () => {
    assert.deepEqual(nextDailyGames(undefined, NOON), { day: '2026-10-09', count: 1 });
  });

  it('adds a game to the day it counts', () => {
    assert.deepEqual(nextDailyGames({ day: '2026-10-09', count: 37 }, NOON), {
      day: '2026-10-09',
      count: 38,
    });
  });

  /** **The ceiling, both sides of it.** The 200th game banks; the 201st does not. */
  it('banks the 200th game of the day', () => {
    assert.deepEqual(nextDailyGames({ day: '2026-10-09', count: 199 }, NOON), {
      day: '2026-10-09',
      count: 200,
    });
  });

  it('refuses the 201st game of the day', () => {
    assert.equal(nextDailyGames({ day: '2026-10-09', count: 200 }, NOON), null);
  });

  /**
   * **The reset.** A full day refuses up to its last millisecond and not one
   * past it: the first game after midnight UTC is the first of a new day.
   */
  it('refuses at 23:59:59 UTC and counts again from 00:00:00 UTC', () => {
    const full = { day: '2026-10-09', count: 200 };

    assert.equal(nextDailyGames(full, Date.UTC(2026, 9, 9, 23, 59, 59)), null);
    assert.equal(nextDailyGames(full, LAST_MOMENT), null);
    assert.deepEqual(nextDailyGames(full, MIDNIGHT), { day: '2026-10-10', count: 1 });
  });

  it('starts a day again whatever an older day reached', () => {
    assert.deepEqual(nextDailyGames({ day: '2026-10-01', count: 200 }, NOON), {
      day: '2026-10-09',
      count: 1,
    });
  });

  /**
   * A counter for a day still to come is a hand edit, or a clock that went
   * backwards. It is not today's, so it resets like any other day's — rather
   * than holding an account at the ceiling until the date it names.
   */
  it('reads a counter for a later day as no counter', () => {
    assert.deepEqual(nextDailyGames({ day: '2026-10-10', count: 200 }, NOON), {
      day: '2026-10-09',
      count: 1,
    });
  });

  /**
   * Only `recordGameResult` writes the counter, so anything else is a hand
   * edit in the console, and it reads as empty — as `readXp` reads a broken
   * XP. Today's day with a count that is not a whole, non-negative number is
   * the case that matters: it must not refuse, and must not produce a count
   * the next write would carry forward.
   */
  it('reads a malformed counter as empty', () => {
    for (const stored of [
      null,
      'nonsense',
      200,
      [],
      { day: '2026-10-09' },
      { count: 200 },
      { day: '2026-10-09', count: -1 },
      { day: '2026-10-09', count: 12.5 },
      { day: '2026-10-09', count: '200' },
      { day: '2026-10-09', count: Number.NaN },
      { day: '2026-10-09', count: Number.POSITIVE_INFINITY },
      { day: '2026-10-09', count: 2 ** 60 },
      { day: 20261009, count: 200 },
      { day: '9 October 2026', count: 200 },
    ]) {
      assert.deepEqual(
        nextDailyGames(stored, NOON),
        { day: '2026-10-09', count: 1 },
        JSON.stringify(stored),
      );
    }
  });

  /**
   * A count above the ceiling is well formed — a hand edit, or a ceiling a
   * deploy has lowered under a day already past it — and it refuses: reading
   * it as empty would turn lowering the ceiling into a fresh allowance.
   */
  it('refuses a day already past the ceiling', () => {
    assert.equal(nextDailyGames({ day: '2026-10-09', count: 250 }, NOON), null);
  });
});

describe('gamesBankedOn', () => {
  it("reads the day's own count, and nothing for another day", () => {
    const stored = { day: '2026-10-09', count: 12 };

    assert.equal(gamesBankedOn(stored, '2026-10-09'), 12);
    assert.equal(gamesBankedOn(stored, '2026-10-10'), 0);
    assert.equal(gamesBankedOn(stored, '2026-10-08'), 0);
    assert.equal(gamesBankedOn({ day: '2026-10-09', count: 0 }, '2026-10-09'), 0);
  });
});
