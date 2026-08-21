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
  [
    'https://us-central1-intellectura-3b26a.cloudfunctions.net',
    'httpsCallable: deleteAccount and exportAccountData — AccountService. ' +
      'Region is @firebase/functions DEFAULT_REGION; setting a region on the functions ' +
      'means changing this.',
  ],
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

  const problems = [];

  for (const [origin, reason] of RUNTIME_ORIGINS) {
    if (!connectSrc.has(origin)) {
      problems.push({
        origin,
        detail: `requested at runtime by ${reason}`,
        why: 'A fetch to it will be refused outright, in production only.',
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
