/**
 * Stops *waiting* for a promise after `ms`. It does not stop the work.
 *
 * The name is deliberately blunt, because the previous one (`withTimeout`)
 * implied a cancellation it never performed: `Promise.race` settles on
 * whichever promise finishes first and then simply ignores the other, so the
 * request carries on to completion for a caller that has already given up.
 *
 * **Use a real cancellation mechanism wherever the API has one**, and there is
 * usually one:
 *
 * - `fetch` → `AbortSignal.timeout(ms)` (see `FirebaseAppService`)
 * - Firebase callables → `httpsCallable(fns, name, { timeout: ms })` (see
 *   `AccountService`)
 * - a poll → bound it on the wall clock and stop (see `pollUntil`, which
 *   replaced this app's `onSnapshot` listeners)
 * - Angular `HttpClient` → RxJS `timeout()`, since unsubscribing aborts
 *
 * What is left of it is shrinking on purpose. `signInAnonymously` takes no
 * options argument at all — `AbortSignal` appears nowhere in the Auth SDK's
 * type definitions — and Auth is not being migrated, so that call site is
 * permanent. `GameControllerService`'s restore is an IndexedDB read, not a
 * network one, and is a genuine "stop waiting" rather than a missing
 * cancellation.
 *
 * The Firestore call sites are gone. Every one of them goes over
 * `FirestoreRestClient` and a real `AbortSignal.timeout` now, and the SDK with
 * them (`BACKLOG.md` item 2) — so nothing here is waiting on Firestore any
 * more.
 *
 * The deadline itself remains load-bearing wherever it lives:
 * `TriviaService.getQuestions()` falls back to the offline question pool only
 * when the fetch *throws*. That is now guaranteed by `AbortSignal.timeout`
 * rather than by this helper, which is the stronger version of the same
 * property — the request is actually cancelled instead of merely abandoned.
 *
 * The timer is cleared however the race settles — otherwise every call that
 * finished normally left one armed for its full duration, ten seconds after a
 * Firestore read had already returned.
 */
export function giveUpAfter<T>(
  promise: Promise<T>,
  ms: number,
  message = 'Request timed out',
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timeoutHandle));
}
