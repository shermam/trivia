import { ANONYMOUS_RETRY_DELAYS_MS, nextAnonymousRetryDelayMs } from './sign-in-retry.util';

/**
 * The retry policy behind `AuthService.ensureSignedIn()`, tested where it has
 * no Firebase SDK, no timer and no injector around it (`CLAUDE.md` §4.6 — keep
 * the decision in a pure function so covering it stays cheap).
 *
 * The decision itself is small; what these pin is the two ends of it, which
 * are the parts a future edit can quietly get wrong: that the very first
 * failure schedules something (a policy that answered `null` there would look
 * exactly like today's bug), and that the schedule genuinely stops (a policy
 * that never did would hammer a throttle that refused the first four).
 */
describe('nextAnonymousRetryDelayMs', () => {
  it('walks the schedule, one delay per failed attempt', () => {
    expect(nextAnonymousRetryDelayMs(1)).toBe(2_000);
    expect(nextAnonymousRetryDelayMs(2)).toBe(5_000);
    expect(nextAnonymousRetryDelayMs(3)).toBe(15_000);
    expect(nextAnonymousRetryDelayMs(4)).toBe(30_000);
  });

  it('stops once the schedule is spent', () => {
    expect(nextAnonymousRetryDelayMs(ANONYMOUS_RETRY_DELAYS_MS.length + 1)).toBeNull();
    expect(nextAnonymousRetryDelayMs(99)).toBeNull();
  });

  it('backs off rather than repeating one interval', () => {
    const ascending = [...ANONYMOUS_RETRY_DELAYS_MS].sort((a, b) => a - b);
    expect(ANONYMOUS_RETRY_DELAYS_MS).toEqual(ascending);
    expect(new Set(ANONYMOUS_RETRY_DELAYS_MS).size).toBe(ANONYMOUS_RETRY_DELAYS_MS.length);
  });

  it('never retries sooner than the attempt that just failed was given', () => {
    // `ANONYMOUS_SIGN_IN_TIMEOUT_MS` is 10s, so a first delay of, say, 50ms
    // would be a client with no timeout wearing one.
    expect(ANONYMOUS_RETRY_DELAYS_MS[0]).toBeGreaterThanOrEqual(1_000);
  });

  it('answers null when nothing has failed, since there is nothing to schedule', () => {
    expect(nextAnonymousRetryDelayMs(0)).toBeNull();
    expect(nextAnonymousRetryDelayMs(-1)).toBeNull();
    expect(nextAnonymousRetryDelayMs(1.5)).toBeNull();
    expect(nextAnonymousRetryDelayMs(Number.NaN)).toBeNull();
  });
});
