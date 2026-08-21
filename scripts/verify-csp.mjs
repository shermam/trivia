/**
 * Checks the Content-Security-Policy in `firebase.json` two ways, because the
 * same directive — `connect-src` — is load-bearing for two different reasons
 * and gets missed for two different reasons.
 *
 * ## Check 1: every origin the app requests at runtime is in `connect-src`
 *
 * `fetch`/`XHR` is governed by `connect-src`, and an origin that appears in no
 * directive at all inherits nothing, because `connect-src` is present and so
 * does not fall back to `default-src`. The failure is total and silent in
 * development: the emulator config points these calls at localhost, no CSP is
 * served by `ng serve`, and the e2e suite therefore cannot see it.
 *
 * That is not hypothetical. `httpsCallable` builds
 * `https://{region}-{project}.cloudfunctions.net/{name}` (there is no Hosting
 * rewrite for functions here, and no region override, so `DEFAULT_REGION` from
 * `@firebase/functions` applies), and that host was in no directive — so
 * `deleteAccount` and `exportAccountData`, the two paths the Privacy Policy
 * promises, were refused in production and nowhere else.
 *
 * `RUNTIME_ORIGINS` is therefore hand-maintained, and has to be: nothing can
 * derive it, since the origins live inside third-party SDKs. Adding a call to
 * a new host means adding it here.
 *
 * ## Check 2: every origin allowed for a *subresource* is also in `connect-src`
 *
 * This one is about the service worker. `ngsw-worker.js` responds to every
 * fetch the page makes, cross-origin included, and re-issues the ones it does
 * not cache as a `fetch()` **from inside the worker**
 * (`Driver.handleFetch` → `safeFetch`). A service worker's `fetch()` is
 * governed by the CSP delivered with the *worker script* — `firebase.json`
 * applies its CSP to `**`, so `/ngsw-worker.js` gets it — and inside a worker
 * every request is a connection, so `connect-src` applies rather than the
 * `script-src` the page itself would have used.
 *
 * So a script origin missing from `connect-src` loads perfectly until a service
 * worker takes control of the page, and then stops. Every property of that
 * failure is hostile: the page's own CSP is not violated so nothing is reported
 * against it, the refusal is logged in the worker's console rather than the
 * page's, `safeFetch` turns it into a synthetic `504` that reads like the
 * remote host's fault, and a hard reload — which bypasses the service worker —
 * makes it disappear. It cost weeks of intermittent Google sign-in failures on
 * `https://apis.google.com/js/api.js`.
 *
 * **`frame-src` is deliberately not in this list, and used to be.** A
 * cross-origin `<iframe>` is a navigation, and a navigation is matched to a
 * service worker by the *target* URL's origin — so the embedding page's worker
 * never sees it and can never re-fetch it. The same goes for a popup. Requiring
 * those origins in `connect-src` enforced a real rule for a false reason, which
 * is worth removing even though the extra entry was harmless.
 */

import { readFileSync } from 'node:fs';

const CONFIG = 'firebase.json';

/**
 * Origins this app requests at runtime, and what requests them. Every one of
 * these is a `fetch`/`XHR` and therefore governed by `connect-src`.
 *
 * Keep the reason attached to each entry — an origin nobody can explain is one
 * nobody can safely remove.
 */
const RUNTIME_ORIGINS = [
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
 * service worker will therefore re-fetch. `frame-src` is excluded on purpose —
 * see the header. `default-src` is included because it is the fallback for
 * every fetch directive *absent* from the policy (`media-src`, `child-src`,
 * `script-src-elem`, `prefetch-src`, …), so an origin written only there is
 * still loadable as a subresource.
 */
const SUBRESOURCE_DIRECTIVES = [
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
function directivesOf(csp) {
  const directives = new Map();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) {
      directives.set(name.toLowerCase(), values);
    }
  }
  return directives;
}

const isOrigin = (value) => value.startsWith('https://') || value.startsWith('http://');

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const hosting = Array.isArray(config.hosting) ? config.hosting[0] : config.hosting;
const rule = hosting?.headers?.find((entry) => entry.source === '**');
const header = rule?.headers?.find((h) => h.key.toLowerCase() === 'content-security-policy');

if (!header) {
  fail(`No Content-Security-Policy on the '**' rule in ${CONFIG} — has it moved?`);
}

const directives = directivesOf(header.value);
const connectSrc = new Set(directives.get('connect-src') ?? []);

if (connectSrc.size === 0) {
  fail('No connect-src directive in the CSP — nothing to check against.');
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

if (problems.length > 0) {
  console.error(`✗ ${problems.length} origin(s) missing from connect-src:\n`);
  for (const { origin, detail, why } of problems) {
    console.error(`    ${origin}`);
    console.error(`      ${detail}`);
    console.error(`      ${why}\n`);
  }
  console.error(
    `  Add each to connect-src in ${CONFIG}. For an origin already allowed by another\n` +
      `  directive this grants strictly less than it already has — fetching bytes from a host\n` +
      `  you may already execute scripts from is not a widening.\n`,
  );
  process.exit(1);
}

console.log(
  `✓ CSP: ${RUNTIME_ORIGINS.length} runtime origin(s) reachable, and every subresource origin ` +
    `across ${SUBRESOURCE_DIRECTIVES.length} directives is re-fetchable by the service worker.`,
);
