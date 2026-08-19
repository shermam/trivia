import { pollUntil } from './poll-until.util';

/**
 * Uses fake timers, so the interval is asserted rather than waited out. The
 * deadline is read from the wall clock (`CLAUDE.md` §4.4), and `vi.useFakeTimers()`
 * mocks `Date.now()` along with `setTimeout` — so advancing time here moves
 * both, exactly as a throttled background tab would not.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs `promise` while draining the fake timer queue, so awaits inside resolve. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const result = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const outcome = await result;
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

describe('pollUntil', () => {
  it('returns the first non-null result without polling again', async () => {
    const attempt = vi.fn().mockResolvedValue('done');

    const result = await settle(pollUntil(attempt, { intervalMs: 500, timeoutMs: 20_000 }));

    expect(result).toBe('done');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('keeps asking while the answer is null', async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue('done');

    expect(await settle(pollUntil(attempt, { intervalMs: 500, timeoutMs: 20_000 }))).toBe('done');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('treats undefined the same as null', async () => {
    const attempt = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue('done');

    expect(await settle(pollUntil(attempt, { intervalMs: 500, timeoutMs: 20_000 }))).toBe('done');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('returns false rather than treating it as "not yet"', async () => {
    // `false` is a legitimate answer — the subscription read returns a boolean
    // — so only null and undefined may mean "ask again".
    const attempt = vi.fn().mockResolvedValue(false);

    expect(await settle(pollUntil(attempt, { intervalMs: 500, timeoutMs: 20_000 }))).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up at the deadline and returns null', async () => {
    const attempt = vi.fn().mockResolvedValue(null);

    expect(await settle(pollUntil(attempt, { intervalMs: 1000, timeoutMs: 5000 }))).toBeNull();
    // 5000 / 1000 = five waits, and the attempt after the last one would push
    // past the deadline — so five attempts, not six.
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it('bounds the total wait on the wall clock, not on a count of intervals', async () => {
    // The test above cannot tell the two apart, because with instant attempts
    // `timeoutMs / intervalMs` is the same number either way — so an
    // implementation counting ticks passes it. Here each attempt takes 4s
    // against a 10s budget and a 1s interval: counting ticks would allow ten
    // attempts, the wall clock allows two, because the third would start at
    // exactly 10s. This is the property `CLAUDE.md` §4.4 asks for, and the
    // reason it matters is that a throttled background tab stretches ticks
    // while the clock keeps going.
    const attempt = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      return null;
    });

    await settle(pollUntil(attempt, { intervalMs: 1000, timeoutMs: 10_000 }));

    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('hands each attempt the budget that is left', async () => {
    // So a caller with its own per-request deadline can shrink it to fit
    // rather than composing two full-length timeouts.
    const remaining: number[] = [];
    const attempt = vi.fn(async (ms: number) => {
      remaining.push(ms);
      return remaining.length < 3 ? null : 'done';
    });

    await settle(pollUntil(attempt, { intervalMs: 1000, timeoutMs: 10_000 }));

    expect(remaining).toEqual([10_000, 9_000, 8_000]);
  });

  it('always makes one attempt, even with no time to wait', async () => {
    const attempt = vi.fn().mockResolvedValue(null);

    expect(await settle(pollUntil(attempt, { intervalMs: 500, timeoutMs: 0 }))).toBeNull();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('waits between attempts rather than around them, so a slow one cannot overlap', async () => {
    const started = Date.now();
    const starts: number[] = [];
    const attempt = vi.fn(async () => {
      starts.push(Date.now() - started);
      // Each attempt itself takes 2s — longer than the interval.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return starts.length < 3 ? null : 'done';
    });

    await settle(pollUntil(attempt, { intervalMs: 500, timeoutMs: 60_000 }));

    // 0, then 2000 (attempt) + 500 (interval), then again.
    expect(starts).toEqual([0, 2500, 5000]);
  });

  it('propagates a throw immediately instead of retrying it', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('refused'));

    await expect(
      settle(pollUntil(attempt, { intervalMs: 500, timeoutMs: 20_000 })),
    ).rejects.toThrow('refused');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('leaves no timer armed once it has settled', async () => {
    // Deliberately NOT via `settle()`. `vi.runAllTimersAsync()` drains the
    // queue by definition, so `getTimerCount()` after it is zero whatever the
    // implementation does — the assertion was a tautology, and a leaked
    // one-hour timer per iteration passed it. Advancing by exactly one
    // interval instead leaves any leaked timer still pending and countable.
    const attempt = vi.fn().mockResolvedValueOnce(null).mockResolvedValue('done');

    const pending = pollUntil(attempt, { intervalMs: 500, timeoutMs: 20_000 });
    await vi.advanceTimersByTimeAsync(500);

    expect(await pending).toBe('done');
    // A poll that resolved while still holding a pending timer is the same
    // leak `Promise.race` had against `onSnapshot` (`CLAUDE.md` §4.4).
    expect(vi.getTimerCount()).toBe(0);
  });
});
