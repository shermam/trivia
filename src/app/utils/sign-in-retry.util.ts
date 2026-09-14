/**
 * When to try again after an attempt to mint an anonymous session has failed.
 *
 * **The schedule is bounded on purpose, and the bound is the interesting
 * part.** The failures worth retrying divide into two kinds and only one of
 * them wants persistence: a round trip that was slow, dropped or offline is
 * very likely to work a few seconds later, while a refusal — a throttle, a
 * disabled provider, an exhausted quota — is not, and a client that keeps
 * knocking makes a throttle worse rather than better. Four attempts spread
 * over fifty-two seconds covers the first kind twice over and stops well
 * short of being the second kind's problem.
 *
 * **Stopping is not giving up**, which is what makes the bound affordable:
 * `AuthService.ensureSignedIn()` is called by gestures too — opening the auth
 * menu, opening the donation dialog — so a reader who does anything that
 * needs a uid re-attempts on the spot, however long the page has been sitting
 * there. What ends is only the unattended schedule.
 *
 * The first delay is two seconds rather than zero for the same reason the
 * gaps widen afterwards: the attempt that just failed had ten seconds of its
 * own (`ANONYMOUS_SIGN_IN_TIMEOUT_MS`), so an immediate second one is
 * indistinguishable from a client with no timeout at all.
 */
export const ANONYMOUS_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];

/**
 * How long to wait before the next attempt, or `null` to stop scheduling.
 *
 * `failedAttempts` counts the attempts that have **already failed**, so the
 * first retry is decided with `1`. Nothing having failed leaves nothing to
 * schedule, which is why anything below that — and any non-integer, since a
 * count is one — answers `null` rather than a delay.
 *
 * Pure, and separate from the service, so the policy can be read and tested
 * without a Firebase SDK, a timer or an injector anywhere near it
 * (`CLAUDE.md` §4.6).
 */
export function nextAnonymousRetryDelayMs(failedAttempts: number): number | null {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) {
    return null;
  }
  return ANONYMOUS_RETRY_DELAYS_MS[failedAttempts - 1] ?? null;
}
