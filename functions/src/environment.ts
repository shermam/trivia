/**
 * Which Firebase project this code is actually running against, and what that
 * licences it to do.
 *
 * Isolated as pure functions for the same reason as `role.ts` and
 * `account-policy.ts`: the decision "may this deployment skip the real Stripe
 * call" is a security decision, so it gets a direct unit test rather than
 * being inferred from an integration run.
 */

/**
 * The project ID as the Functions runtime reports it.
 *
 * `GCLOUD_PROJECT` is set by the Cloud Functions runtime and by the Firebase
 * emulator alike; `FIREBASE_CONFIG` is the fallback the Admin SDK itself
 * reads, and is parsed defensively because a malformed value should read as
 * "unknown project", never throw on a path that gates a security check.
 */
export function resolveProjectId(env: Record<string, string | undefined>): string | undefined {
  const direct = env['GCLOUD_PROJECT'] ?? env['GOOGLE_CLOUD_PROJECT'];
  if (direct) {
    return direct;
  }
  const raw = env['FIREBASE_CONFIG'];
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { projectId?: unknown };
    return typeof parsed.projectId === 'string' && parsed.projectId ? parsed.projectId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A throwaway project — `demo-trivia-app-e2e` for the Cypress/Lighthouse
 * emulator runs, `demo-rules-*` for the rules suite.
 *
 * The `demo-` prefix is not a convention this repo invented: the Firebase
 * emulator treats it as meaning "this project does not exist", refuses to
 * reach any real backend for it, and requires no credentials. So it is a
 * property a real, Stripe-backed deployment structurally cannot have —
 * which is exactly what makes it safe to hang a test-mode switch on.
 */
export function isDemoProject(projectId: string | undefined): boolean {
  return projectId !== undefined && projectId.startsWith('demo-');
}

/**
 * Whether `createCheckoutSession` / `createPortalSession` may skip Stripe and
 * write back a fake session.
 *
 * Requires **both** the opt-in flag and a demo project. The flag alone used
 * to be enough, which meant one stray environment variable — a copy-pasted
 * `.env`, a mistyped deploy target, a CI secret set on the wrong workflow —
 * would have made production hand out fake checkout URLs that take money from
 * nobody while looking like they worked. An environment variable can be set
 * anywhere; a project ID cannot.
 */
export function isMockCheckoutEnabled(
  projectId: string | undefined,
  flag: string | undefined,
): boolean {
  return flag === 'true' && isDemoProject(projectId);
}

/**
 * Which Stripe a secret key talks to, read from the key's own shape.
 *
 * Stripe's key format encodes the mode (`sk_test_…`, `sk_live_…`, and the
 * restricted `rk_` variants of both), so this is the deployment's own statement
 * of which Stripe it is configured against — not an inference about it.
 * Matched on the `_live_`/`_test_` infix rather than a `sk_`/`rk_` prefix so a
 * new key *type* doesn't silently become unclassifiable.
 *
 * The key itself must never be logged or returned; only this classification.
 */
export function stripeModeOfKey(secretKey: string | undefined): 'live' | 'test' | null {
  if (!secretKey) {
    return null;
  }
  if (secretKey.includes('_live_')) {
    return 'live';
  }
  if (secretKey.includes('_test_')) {
    return 'test';
  }
  return null;
}

/**
 * Whether a Stripe event belongs to the environment receiving it.
 *
 * Stripe lets the same URL be registered as a webhook endpoint in **both** test
 * and live mode, each with its own signing secret. Normally the wrong-mode
 * delivery fails signature verification and never gets here — but the two
 * secrets are one `firebase functions:secrets:set` apart, and if the test one
 * is ever set alongside a *live* secret key, every test-mode event a developer
 * triggers starts verifying cleanly and writing to real customers: cancelling
 * live subscriptions, revoking real `stripeRole` claims, rewriting the price
 * catalogue the pricing page reads.
 *
 * The expectation comes from **the deployed secret key**, not from the project.
 * An earlier version of this derived it from the project ID — a real project
 * must mean live mode — which is wrong, and expensively so: this project runs
 * deliberately in Stripe test mode before launch (`PROJECT_OVERVIEW.md` §6), so
 * that rule rejected every genuine delivery and would have stopped checkout
 * granting anyone Pro. The key is the right authority because it *defines*
 * which Stripe the deployment talks to, so this check can never contradict
 * reality: with a live key installed a test event is still refused, and with a
 * test key installed there is no live state to protect in the first place.
 *
 * A demo project is pinned to test mode regardless — the emulator runs on
 * placeholder secrets that classify as neither.
 *
 * An unclassifiable key accepts nothing. Failing closed costs a dropped event
 * on a misconfigured deploy; failing open costs live billing state mutated by
 * a test.
 */
export function isEventForThisEnvironment(
  eventLivemode: boolean,
  secretKey: string | undefined,
  projectId: string | undefined,
): boolean {
  if (isDemoProject(projectId)) {
    return eventLivemode === false;
  }
  const mode = stripeModeOfKey(secretKey);
  if (mode === null) {
    return false;
  }
  return eventLivemode === (mode === 'live');
}
