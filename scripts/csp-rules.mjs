/**
 * The CSP rule itself, as a pure function — no filesystem, no `process.exit`,
 * no Node built-ins — so the two things that need to enforce it can share one
 * implementation instead of each keeping their own.
 *
 * There are two of them, and they check the same rule against different inputs:
 *
 * - `verify-csp.mjs` applies it to the policy **written in `firebase.json`**,
 *   in `lint.yml`, before anything is built.
 * - `cypress/e2e/unauthenticated/service-worker-oauth-origins.cy.ts` applies it
 *   to the policy **actually served by a deployed Hosting channel**, which is a
 *   different question: a headers rule that stops matching `**`, a deploy that
 *   didn't take, or a CDN rewriting the header are all invisible on disk.
 *
 * They used to be separate implementations, and that went wrong immediately in
 * the way duplicated rules do. PR #112 wrote the first version; #114 copied it
 * into the spec; #113 then corrected it — removing `frame-src`, adding
 * `default-src` and the rest of the fallback directives, matching directive
 * names case-insensitively, and adding the runtime-origins check — in the
 * script only. For the span of one PR the two disagreed about what the rule
 * *was*: the spec would have failed a policy the script passed, and passed an
 * origin written only in `default-src` that the script caught. Neither would
 * have been wrong about its own copy. That is the whole argument for this file.
 *
 * Keep it dependency-free. The spec is bundled into a browser by Cypress, so
 * anything imported here has to survive that.
 */

/**
 * Every Firebase project this one `firebase.json` is deployed to.
 *
 * There is one policy and more than one project, and three of the origins in
 * it are **named after the project** — so a policy that is correct for one
 * deployment is silently wrong for another. That is not hypothetical: the CSP
 * named the production project only, so on `trivimind-dev` (and on every PR
 * preview channel, which is the same project) Google sign-in was refused with
 * `Framing 'https://trivimind-dev.firebaseapp.com/' violates ... "frame-src
 * https://intellectura-3b26a.firebaseapp.com"`, and `deleteAccount` /
 * `exportAccountData` would have been refused the same way.
 *
 * `docs/dev-environment.md` said the headers were "the same by construction
 * rather than by discipline". They were the same; being the same was the bug.
 *
 * Listing the projects here rather than the origins keeps the two derivations
 * below in one place, so adding a third deployment is one line and cannot be
 * half-done.
 */
export const DEPLOY_TARGETS = [
  ['intellectura-3b26a', 'production — `.firebaserc` default, `npm run firebase:deploy`'],
  [
    'trivimind-dev',
    'dev and every PR preview channel — `firebase:deploy:dev`, `firebase-preview.yml`',
  ],
];

/**
 * The Firebase Auth `authDomain` for a project, as an origin.
 *
 * `FirebaseAppService` builds exactly this string for the emulator, and a real
 * deployment reads it from Hosting's `/__/firebase/init.json` — which returns
 * the same default. `browserPopupRedirectResolver` **frames** it
 * (`/__/auth/iframe`), so it belongs in `frame-src`, and the service worker
 * re-fetches it, so it belongs in `connect-src` too.
 */
export const authDomainOrigin = (projectId) => `https://${projectId}.firebaseapp.com`;

/**
 * The origin `httpsCallable` builds: `https://{region}-{project}.cloudfunctions.net`.
 *
 * There is no Hosting rewrite for functions here and no region override, so
 * `DEFAULT_REGION` from `@firebase/functions` applies. Setting a region on the
 * functions means changing this.
 */
export const callableOrigin = (projectId) => `https://us-central1-${projectId}.cloudfunctions.net`;

/**
 * Origins this app requests at runtime, and what requests them. Every one of
 * these is a `fetch`/`XHR` and therefore governed by `connect-src`.
 *
 * Hand-maintained, and it has to be: nothing can derive it, because the URLs
 * are built inside third-party SDKs and grepping `src/` for `https://` never
 * finds them. Adding a call to a new host means adding it here.
 *
 * Keep the reason attached to each entry — an origin nobody can explain is one
 * nobody can safely remove.
 */
export const RUNTIME_ORIGINS = [
  ['https://opentdb.com', 'Open Trivia DB — TriviaService, via HttpClient'],
  ['https://firestore.googleapis.com', 'every Firestore read and write — FirestoreRestClient'],
  ['https://identitytoolkit.googleapis.com', 'Firebase Auth — sign-in, sign-up, profile'],
  ['https://securetoken.googleapis.com', 'Firebase Auth — ID token refresh'],
  [
    'https://apis.google.com',
    'gapi loader for the OAuth popup resolver — browserPopupRedirectResolver',
  ],
  // Per-deployment, and derived rather than written out: `httpsCallable`
  // targets the project the app was loaded from, so each deployment needs its
  // own. Hardcoding one project's is what made the policy production-only.
  ...DEPLOY_TARGETS.map(([projectId, why]) => [
    callableOrigin(projectId),
    `httpsCallable: deleteAccount, exportAccountData and recordGameResult — AccountService (${why})`,
  ]),
];

/**
 * Directives naming origins the page may load a **subresource** from, which the
 * service worker will therefore re-fetch.
 *
 * `frame-src` is excluded on purpose: a cross-origin `<iframe>` is a navigation,
 * and a navigation is matched to a service worker by the *target* URL's origin,
 * so the embedding page's worker never sees it and can never re-fetch it. The
 * same goes for a popup.
 *
 * `default-src` is included because it is the fallback for every fetch
 * directive *absent* from the policy (`media-src`, `child-src`,
 * `script-src-elem`, `prefetch-src`, …), so an origin written only there is
 * still loadable as a subresource.
 */
export const SUBRESOURCE_DIRECTIVES = [
  'default-src',
  'script-src',
  'script-src-elem',
  'style-src',
  'style-src-elem',
  'img-src',
  'font-src',
  'media-src',
  'worker-src',
  'manifest-src',
  'child-src',
  'prefetch-src',
];

/** CSP directive names are ASCII case-insensitive; `Script-Src` is valid. */
export function directivesOf(csp) {
  const directives = new Map();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) {
      directives.set(name.toLowerCase(), values);
    }
  }
  return directives;
}

/**
 * One way a policy fails. `detail` says what is wrong and `why` says what
 * breaks as a result, because every caller reports to someone who has to act
 * on it and none of these failures is guessable from the origin alone.
 *
 * Declared as a typedef rather than left to inference because the preview spec
 * imports these functions into a **TypeScript** file compiled under `strict`,
 * where a `const problems = []` in here lands as `any[]` and destructuring it
 * at the call site is an implicit-any error.
 *
 * @typedef {{ origin: string, detail: string, why: string }} CspProblem
 */

/** Keywords ('self', 'none') and hashes are not things a worker can connect to. */
const isOrigin = (value) => value.startsWith('https://') || value.startsWith('http://');

/**
 * Every way the given policy fails the rule. An empty array means it passes.
 *
 * Each problem carries `detail` (what is wrong) and `why` (what breaks as a
 * result), because both callers report to someone who has to act on it and
 * neither failure mode is guessable from the origin alone.
 */
export function findCspProblems(csp) {
  const directives = directivesOf(csp);
  const connectSrc = new Set(directives.get('connect-src') ?? []);

  if (connectSrc.size === 0) {
    return [
      {
        origin: 'connect-src',
        detail: 'the directive is absent or lists no origins',
        why: 'There is nothing to check against, and every cross-origin fetch is refused.',
      },
    ];
  }

  /** @type {CspProblem[]} */
  const problems = [];

  for (const [origin, reason] of RUNTIME_ORIGINS) {
    if (!connectSrc.has(origin)) {
      problems.push({
        origin,
        detail: `requested at runtime by ${reason}`,
        why: 'A fetch to it will be refused outright, on a real deployment only.',
      });
    }
  }

  for (const directive of SUBRESOURCE_DIRECTIVES) {
    for (const value of directives.get(directive) ?? []) {
      if (isOrigin(value) && !connectSrc.has(value)) {
        problems.push({
          origin: value,
          detail: `allowed by ${directive}, missing from connect-src`,
          why: 'It will load until a service worker controls the page, then 504.',
        });
      }
    }
  }

  return problems;
}

/**
 * Whether the policy is usable by a deployment of **this specific project** —
 * as opposed to `findCspProblems`, which asks whether the policy is
 * self-consistent and covers the hosts the app talks to on some deployment.
 *
 * The distinction is the whole point, and it is why the CSP could be
 * production-only for as long as it was. Every existing check compares the
 * policy against itself or against a fixed list: `frame-src` naming *a*
 * `firebaseapp.com` origin looks fine to all of them, and nothing ever asked
 * *which* project's. `csp:verify` passed, `lint` passed, and the preview e2e
 * suite passed while running against the very deployment whose sign-in was
 * broken.
 *
 * So this takes the project identity as an argument. `verify-csp.mjs` passes
 * every entry in {@link DEPLOY_TARGETS}; the preview spec passes what the
 * deployed channel's own `/__/firebase/init.json` reports, which is the
 * stronger version — derived from the running deployment rather than from a
 * list somebody has to remember to extend.
 *
 * `authDomain` is checked in **both** `frame-src` and `connect-src`, for two
 * unrelated reasons. `frame-src` is what `browserPopupRedirectResolver`'s
 * `/__/auth/iframe` needs and what broke; `connect-src` is what the service
 * worker needs when it re-fetches, and it is a different failure with a
 * different symptom (a synthetic 504 rather than a console violation).
 */
export function findDeploymentOriginProblems(csp, { projectId, authDomain }) {
  const directives = directivesOf(csp);
  const frameSrc = new Set(directives.get('frame-src') ?? []);
  const connectSrc = new Set(directives.get('connect-src') ?? []);

  // A deployment reports its authDomain as a bare host; the policy names an
  // origin. Accept either from the caller so the runtime value can be passed
  // through untouched.
  const authOrigin = authDomain.startsWith('https://') ? authDomain : `https://${authDomain}`;
  /** @type {CspProblem[]} */
  const problems = [];

  if (!frameSrc.has(authOrigin)) {
    problems.push({
      origin: authOrigin,
      detail: `the Firebase authDomain for ${projectId}, missing from frame-src`,
      why:
        'browserPopupRedirectResolver frames it at /__/auth/iframe, so every OAuth sign-in on ' +
        'this deployment is refused before the popup opens.',
    });
  }

  if (!connectSrc.has(authOrigin)) {
    problems.push({
      origin: authOrigin,
      detail: `the Firebase authDomain for ${projectId}, missing from connect-src`,
      why: 'A service worker re-fetching it gets ngsw’s synthetic 504 (PR #112).',
    });
  }

  const functions = callableOrigin(projectId);
  if (!connectSrc.has(functions)) {
    problems.push({
      origin: functions,
      detail: `the Cloud Functions origin for ${projectId}, missing from connect-src`,
      why:
        'httpsCallable targets the project the app was loaded from, so deleteAccount, ' +
        'exportAccountData and recordGameResult are refused on this deployment only.',
    });
  }

  return problems;
}
