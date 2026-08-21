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
 *
 * The rule itself lives in `csp-rules.mjs`, as a pure function, because the
 * preview e2e suite enforces the same rule against the policy a deployed
 * channel actually *serves* — a different input, and one this script cannot
 * see. They were separate implementations for exactly one PR and had already
 * drifted apart; see that file's header.
 */
import { readFileSync } from 'node:fs';

import { RUNTIME_ORIGINS, SUBRESOURCE_DIRECTIVES, findCspProblems } from './csp-rules.mjs';

const CONFIG = 'firebase.json';

function fail(message) {
  console.error(`\u2717 ${message}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const hosting = Array.isArray(config.hosting) ? config.hosting[0] : config.hosting;
const rule = hosting?.headers?.find((entry) => entry.source === '**');
const header = rule?.headers?.find((h) => h.key.toLowerCase() === 'content-security-policy');

if (!header) {
  fail(`No Content-Security-Policy on the '**' rule in ${CONFIG} \u2014 has it moved?`);
}

const problems = findCspProblems(header.value);

if (problems.length > 0) {
  console.error(`\u2717 ${problems.length} origin(s) missing from connect-src:\n`);
  for (const { origin, detail, why } of problems) {
    console.error(`    ${origin}`);
    console.error(`      ${detail}`);
    console.error(`      ${why}\n`);
  }
  console.error(
    `  Add each to connect-src in ${CONFIG}. For an origin already allowed by another\n` +
      `  directive this grants strictly less than it already has \u2014 fetching bytes from a host\n` +
      `  you may already execute scripts from is not a widening.\n`,
  );
  process.exit(1);
}

console.log(
  `\u2713 CSP: ${RUNTIME_ORIGINS.length} runtime origin(s) reachable, and every subresource origin ` +
    `across ${SUBRESOURCE_DIRECTIVES.length} directives is re-fetchable by the service worker.`,
);
