/**
 * Firestore's SDK retries with backoff internally and its promises never reject on
 * their own when the backend is unreachable (e.g. misconfigured/placeholder Firebase
 * credentials) — callers would otherwise be stuck "loading" forever.
 *
 * The timer is cleared however the race settles. `Promise.race` resolves as soon
 * as the *first* promise settles and then simply stops caring about the other
 * one, so the losing `setTimeout` used to stay armed for its full duration —
 * ten seconds for a Firestore read, twenty for a checkout handshake — holding
 * its closure alive and keeping the event loop busy for a result nobody would
 * look at. That is invisible in a single call and adds up across the twelve
 * call sites, one of which loops per price. It also keeps a Node process (a
 * test run) alive past the point where the work is done.
 *
 * `finally` rather than a `then`/`catch` pair: it runs on both paths, and it
 * passes the original value or rejection straight through, which a `then` would
 * have to reconstruct.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = 'Request timed out',
): Promise<T> {
  // Assigned synchronously by the executor below, so it is always set by the
  // time `finally` runs; `clearTimeout(undefined)` is a no-op regardless.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timeoutHandle));
}
