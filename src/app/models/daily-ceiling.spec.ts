import * as server from '../../../functions/src/daily-ceiling';
import { DAILY_GAME_CEILING } from './daily-ceiling';

/**
 * `/profile` tells a player whose last game was refused with `daily-limit`
 * that the limit is 200 games a day, reset at midnight UTC. Both halves of
 * that sentence are facts about `functions/src/daily-ceiling.ts`, so both are
 * pinned to it here, across the package boundary — the way `levels.spec.ts`
 * pins the level table.
 */
describe('daily ceiling — the sentence on /profile agrees with the server', () => {
  it('names the ceiling the server enforces', () => {
    expect(DAILY_GAME_CEILING).toBe(server.DAILY_GAME_CEILING);
  });

  /** "Reset at midnight UTC": the server's day ends at 23:59:59.999 UTC and not before. */
  it('counts a UTC day, so the count starts again at midnight UTC', () => {
    for (const midnight of [Date.UTC(2026, 9, 10), Date.UTC(2027, 0, 1), Date.UTC(2028, 2, 1)]) {
      expect(server.utcDay(midnight), new Date(midnight).toISOString()).not.toBe(
        server.utcDay(midnight - 1),
      );
      // Every other instant of the day falls in the same one.
      expect(server.utcDay(midnight + 24 * 60 * 60 * 1000 - 1)).toBe(server.utcDay(midnight));
      expect(server.utcDay(midnight + 12 * 60 * 60 * 1000)).toBe(server.utcDay(midnight));
    }
  });
});
