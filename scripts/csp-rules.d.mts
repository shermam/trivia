/**
 * Types for `csp-rules.mjs`, so the Cypress spec that shares the rule can
 * import it under `strict` without `allowJs` loosening the whole project.
 */

/** `[projectId, which deployment it is]`. */
export declare const DEPLOY_TARGETS: readonly (readonly [string, string])[];

/** `https://{projectId}.firebaseapp.com` — the Firebase Auth `authDomain`. */
export declare function authDomainOrigin(projectId: string): string;

/** `https://us-central1-{projectId}.cloudfunctions.net` — what `httpsCallable` targets. */
export declare function callableOrigin(projectId: string): string;

/** `[origin, why the app requests it]`. */
export declare const RUNTIME_ORIGINS: readonly (readonly [string, string])[];

export declare const SUBRESOURCE_DIRECTIVES: readonly string[];

export declare function directivesOf(csp: string): Map<string, string[]>;

export interface CspProblem {
  /** The origin at fault, or `'connect-src'` when the directive itself is missing. */
  readonly origin: string;
  /** What is wrong with it. */
  readonly detail: string;
  /** What breaks as a result. */
  readonly why: string;
}

/** Every way `csp` fails the rule; empty means it passes. */
export declare function findCspProblems(csp: string): CspProblem[];

/**
 * Every way `csp` fails to serve **this particular deployment** — its own
 * `authDomain` in `frame-src` and `connect-src`, its own Cloud Functions
 * origin in `connect-src`. Empty means it passes.
 */
export declare function findDeploymentOriginProblems(
  csp: string,
  deployment: { readonly projectId: string; readonly authDomain: string },
): CspProblem[];
