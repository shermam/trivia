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
