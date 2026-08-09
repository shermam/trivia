import { giveUpAfter } from './give-up-after.util';

/**
 * Part of finding B6. This helper only still exists for the Firestore and Auth
 * calls that expose no cancellation of their own; everywhere an API offers one
 * — `AbortSignal.timeout` for `fetch`, `HttpsCallableOptions.timeout` for
 * callables, `unsubscribe` for `onSnapshot` — the call site uses it instead.
 *
 * What is pinned here is the timer teardown. `Promise.race` settles on the
 * first promise and ignores the other, so the losing `setTimeout` used to stay
 * armed for its full duration after the call had already returned. Nothing
 * about the returned value differs between the leaking and fixed versions —
 * the bug is entirely in what is left behind — so the assertion has to be on
 * `vi.getTimerCount()`.
 */
describe('giveUpAfter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves with the value and leaves no timer armed', async () => {
    const result = await giveUpAfter(Promise.resolve('ok'), 10_000);

    expect(result).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  // A failing request is exactly when a retry loop piles calls up, so the
  // rejection path has to disarm the timer too.
  it('passes a rejection through and leaves no timer armed', async () => {
    const failure = new Error('network down');

    await expect(giveUpAfter(Promise.reject(failure), 10_000)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the given message once the deadline passes', async () => {
    const pending = giveUpAfter(new Promise<string>(() => undefined), 10_000, 'Took too long');
    const assertion = expect(pending).rejects.toThrow('Took too long');

    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a default message when none is given', async () => {
    const pending = giveUpAfter(new Promise<string>(() => undefined), 5_000);
    const assertion = expect(pending).rejects.toThrow('Request timed out');

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  // The shape that actually accumulated: many short-lived calls in a row, each
  // leaving its own long timer behind.
  it('leaves nothing behind across many successful calls', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => giveUpAfter(Promise.resolve(i), 20_000)),
    );

    expect(vi.getTimerCount()).toBe(0);
  });
});
