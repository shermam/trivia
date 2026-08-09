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
 * This helper survives only for the Firestore one-shot operations (`getDocs`,
 * `getDoc`, `setDoc`, `addDoc`) and `signInAnonymously`, which take no options
 * argument at all — `AbortSignal` appears nowhere in the Firestore or Auth SDK
 * type definitions, so there is nothing to cancel with. If a future SDK adds
 * one, these call sites should move to it and this file should go.
 *
 * It cannot simply be dropped either: `TriviaService.getQuestions()` falls back
 * to the offline question pool only when the fetch *throws*, and Firestore
 * queues rather than failing when the backend is unreachable. Without a
 * deadline a custom game on a dead network waits forever instead of falling
 * back to cached questions.
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
