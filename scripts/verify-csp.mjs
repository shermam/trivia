/**
 * Checks the Content-Security-Policy in `firebase.json` against one invariant
 * that is invisible in a browser until a specific, rare thing breaks:
 *
 *   **Every origin the page may load a subresource from must also appear in
 *   `connect-src`.**
 *
 * That reads like belt-and-braces. It is not. This app registers an Angular
 * service worker, and `ngsw-worker.js` responds to *every* fetch the page makes
 * — cross-origin ones included. Its handler ends in `safeFetch`, which
 * **re-issues the request as a `fetch()` from inside the worker**
 * (`node_modules/@angular/service-worker/ngsw-worker.js`, `Driver.handleFetch`
 * → `safeFetch`). A service worker's `fetch()` is governed by the CSP delivered
 * with the *worker script*, and inside a worker every request is a connection —
 * so it is checked against `connect-src`, not against `script-src` or
 * `frame-src`, whichever directive the page itself would have used.
 *
 * The consequence is a resource that loads perfectly until a service worker
 * takes control, and then stops. That is exactly how Google sign-in broke: the
 * OAuth popup resolver loads `https://apis.google.com/js/api.js` (allowed by
 * `script-src`) and frames the Firebase `authDomain` (allowed by `frame-src`),
 * and neither was in `connect-src`. Once the service worker was controlling the
 * page, both fetches were refused inside the worker, `safeFetch` turned each
 * refusal into a synthetic `504 Gateway Timeout`, the resolver could not
 * initialise, and sign-in failed with an error the client could not explain.
 *
 * Everything about that failure is quiet. The page's own CSP is not violated,
 * so nothing is reported against it; the refusal is logged in the service
 * worker's console, not the page's; the request appears as a 504, which reads
 * like Google's fault; and a hard reload — which bypasses the service worker —
 * makes it go away, which is the worst possible property for a bug to have.
 *
 * `firebase.json` applies its CSP to `**`, which is what puts it on
 * `/ngsw-worker.js` in the first place. Narrowing that is the alternative fix
 * and a worse one: the worker would then have no CSP at all.
 */

import { readFileSync } from 'node:fs';

const CONFIG = 'firebase.json';

/**
 * Directives naming origins the page may fetch from. `worker-src` and
 * `manifest-src` are here for completeness; today both are `'self'`.
 */
const SUBRESOURCE_DIRECTIVES = [
  'script-src',
  'style-src',
  'img-src',
  'font-src',
  'frame-src',
  'worker-src',
  'manifest-src',
];

function directivesOf(csp) {
  const directives = new Map();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) {
      directives.set(name, values);
    }
  }
  return directives;
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const hosting = Array.isArray(config.hosting) ? config.hosting[0] : config.hosting;
const rule = hosting.headers?.find((entry) => entry.source === '**');
const header = rule?.headers?.find((h) => h.key === 'Content-Security-Policy');

if (!header) {
  console.error(`✗ No Content-Security-Policy on the '**' rule in ${CONFIG} — has it moved?`);
  process.exit(1);
}

const directives = directivesOf(header.value);
const connectSrc = new Set(directives.get('connect-src') ?? []);

if (connectSrc.size === 0) {
  console.error(`✗ No connect-src directive in the CSP — nothing to check against.`);
  process.exit(1);
}

const missing = [];
for (const directive of SUBRESOURCE_DIRECTIVES) {
  for (const value of directives.get(directive) ?? []) {
    // Only real origins. Keywords ('self', 'none', 'unsafe-inline') and hashes
    // are not things a service worker can be told to connect to.
    if (!value.startsWith('https://') && !value.startsWith('http://')) {
      continue;
    }
    if (!connectSrc.has(value)) {
      missing.push({ directive, value });
    }
  }
}

if (missing.length > 0) {
  console.error(
    `✗ ${missing.length} origin(s) are loadable by the page but not by the service worker:\n`,
  );
  for (const { directive, value } of missing) {
    console.error(`    ${value}`);
    console.error(`      allowed by ${directive}, missing from connect-src`);
  }
  console.error(
    `\n  The Angular service worker re-fetches every request from inside the worker, where\n` +
      `  ${'`connect-src`'} is the directive that applies. Any origin above will load fine until the\n` +
      `  service worker takes control of the page, then fail as a synthetic 504 — with the CSP\n` +
      `  refusal logged in the worker's console rather than the page's.\n\n` +
      `  Add each origin to connect-src in ${CONFIG}. This grants strictly less than the\n` +
      `  directive that already allows it: being able to fetch bytes from an origin you are\n` +
      `  already permitted to execute scripts from, or frame, is not a widening.\n`,
  );
  process.exit(1);
}

console.log(
  `✓ CSP: all ${SUBRESOURCE_DIRECTIVES.length} subresource directives are covered by connect-src ` +
    `(${connectSrc.size} origin(s)), so the service worker can re-fetch everything the page can load.`,
);
