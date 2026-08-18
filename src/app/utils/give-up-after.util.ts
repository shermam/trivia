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
 * - `onSnapshot` → call its `unsubscribe` on the deadline (see
 *   `SubscriptionService`)
 * - Angular `HttpClient` → RxJS `timeout()`, since unsubscribing aborts
 *
 * What is left of it is shrinking on purpose. `signInAnonymously` takes no
 * options argument at all — `AbortSignal` appears nowhere in the Auth SDK's
 * type definitions — and Auth is not being migrated, so that call site is
 * permanent. `GameControllerService`'s restore is an IndexedDB read, not a
 * network one, and is a genuine "stop waiting" rather than a missing
 * cancellation.
 *
 * The Firestore call sites are going. `FirebaseService` moved to
 * `FirestoreRestClient` and a real `AbortSignal.timeout` (`BACKLOG.md` item 2);
 * the two `getDocs` in `SubscriptionService.getProPriceId()` are the last
 * holdouts and go with the SDK in the next PR of that item.
 *
 * The deadline itself is load-bearing wherever it lives, however:
 * `TriviaService.getQuestions()` falls back to the offline question pool only
 * when the fetch *throws*, and the Firestore SDK queues rather than failing
 * when the backend is unreachable. Without a deadline a custom game on a dead
 * network waits forever instead of falling back to cached questions.
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
