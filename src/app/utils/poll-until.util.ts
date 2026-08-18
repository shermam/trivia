/**
 * Repeats `attempt` until it produces a result, or the deadline passes.
 *
 * This exists because REST has no `onSnapshot`. Two things in
 * `SubscriptionService` used a real-time listener to wait for a Cloud Function
 * to write something — the checkout/portal URL handshake, and Pro status
 * appearing after the Stripe webhook lands — and polling is what replaces
 * both. `FIRESTORE_SDK_VS_REST.md` §4 costs this out: a listener bills the
 * initial read plus every change delivered for as long as the tab lives,
 * whereas a bounded poll bills a fixed handful of reads on an action a user
 * takes rarely, and then stops.
 *
 * Three properties it has to have, each of them a rule from `CLAUDE.md` §4.4
 * that something in this repo has broken before:
 *
 * - **The deadline reads the wall clock.** Accumulating `setTimeout` ticks
 *   drifts, and a background tab has its timers throttled — so a poll built
 *   that way would silently keep going long past the bound it advertises.
 * - **The timer is always cleared.** Every path out of here, including the
 *   throwing one, leaves nothing armed.
 * - **It waits between attempts, not around them.** The interval starts when
 *   an attempt finishes, so a slow request cannot overlap the next one or turn
 *   a 20-second bound into a queue of pending reads.
 * - **The bound is the whole bound.** `attempt` is handed the time left, so a
 *   caller with its own per-request deadline can shrink it to fit rather than
 *   composing two 20-second timeouts into 40 seconds of wall clock. Advertising
 *   one bound and enforcing another is the kind of thing nobody notices until
 *   a user is staring at a spinner.
 *
 * `attempt` returning `null`/`undefined` means "not yet, ask again". Anything
 * else is the answer. A throw propagates immediately and is **not** retried,
 * because whether a failed attempt is a not-yet is the caller's judgement, not
 * this helper's — both call sites in `SubscriptionService` decide it
 * explicitly, and both decide "yes", for reasons written down where they are.
 */
export async function pollUntil<T>(
  attempt: (remainingMs: number) => Promise<T | null | undefined>,
  options: { intervalMs: number; timeoutMs: number },
): Promise<T | null> {
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const result = await attempt(Math.max(0, deadline - Date.now()));
    if (result !== null && result !== undefined) {
      return result;
    }
    // Checked after the attempt, so the deadline bounds how long the caller
    // waits rather than cutting an in-flight request short — and so a single
    // attempt always happens even at `timeoutMs: 0`. `>=` rather than `>`, so
    // no attempt ever *starts* on the deadline itself: at 1s over 5s that is
    // five attempts, which is the count the arithmetic reads as.
    if (Date.now() + options.intervalMs >= deadline) {
      return null;
    }
    await delay(options.intervalMs);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(() => {
      clearTimeout(handle);
      resolve();
    }, ms);
  });
}
