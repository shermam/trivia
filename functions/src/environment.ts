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
 * Whether a Stripe event belongs to the environment receiving it.
 *
 * Stripe lets the same URL be registered as a webhook endpoint in **both** test
 * and live mode, each with its own signing secret. Normally the wrong-mode
 * delivery fails signature verification and never gets here — but the two
 * secrets are one `firebase functions:secrets:set` apart, and if the test one
 * is ever set on production, every test-mode event a developer triggers starts
 * verifying cleanly and writing to real customers: cancelling live
 * subscriptions, revoking real `stripeRole` claims, rewriting the price
 * catalogue the pricing page reads.
 *
 * Checking `livemode` against the project makes that structurally impossible
 * rather than dependent on which secret happens to be installed — the same
 * reasoning as gating mock checkout on a `demo-` project ID (A7), and the same
 * asymmetry: a secret can be pasted anywhere, a project ID cannot.
 *
 * An unidentifiable project accepts nothing. Failing closed here costs a
 * dropped event on a misconfigured deploy; failing open costs live billing
 * state mutated by a test.
 */
export function isEventForThisEnvironment(
  eventLivemode: boolean,
  projectId: string | undefined,
): boolean {
  if (projectId === undefined) {
    return false;
  }
  return eventLivemode === !isDemoProject(projectId);
}
