import { withTimeout } from './with-timeout.util';

/**
 * Finding B6. `withTimeout` races a promise against a `setTimeout` and never
 * cleared it, so every call that finished normally left a timer armed for its
 * full duration — ten seconds for a Firestore read, twenty for a checkout
 * handshake.
 *
 * `vi.getTimerCount()` is what makes the leak observable at all. Nothing about
 * the returned value differs between the leaking and the fixed version, which
 * is exactly why this went unnoticed: the bug is in what is left behind, not
 * in what comes back.
 */
describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves with the value and leaves no timer armed', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 10_000);

    expect(result).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  // The rejection path settles the race too, so it must disarm the timer as
  // well — a failing request is exactly when a retry loop piles calls up.
  it('passes a rejection through and leaves no timer armed', async () => {
    const failure = new Error('network down');

    await expect(withTimeout(Promise.reject(failure), 10_000)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the timeout message once the deadline passes', async () => {
    const pending = withTimeout(new Promise<string>(() => undefined), 10_000, 'Took too long');
    const assertion = expect(pending).rejects.toThrow('Took too long');

    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a default message when none is given', async () => {
    const pending = withTimeout(new Promise<string>(() => undefined), 5_000);
    const assertion = expect(pending).rejects.toThrow('Request timed out');

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  // The shape that actually bit: many short-lived calls in a row, each leaving
  // its own long timer behind.
  it('leaves nothing behind across many successful calls', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => withTimeout(Promise.resolve(i), 20_000)),
    );

    expect(vi.getTimerCount()).toBe(0);
  });
});
