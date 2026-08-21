/**
 * Forces the browser to re-install `ngsw-worker.js` whenever the CSP changes,
 * by making the script's bytes depend on the policy served alongside it.
 *
 * ## The hole this closes
 *
 * A service worker's CSP is fixed when its **script is installed**, not when it
 * runs. The policy delivered with `/ngsw-worker.js` is stored in that worker's
 * policy container at install time and governs every `fetch()` it makes for the
 * rest of its life — and `ngsw-worker.js` re-issues almost everything the page
 * requests (`Driver.handleFetch` → `safeFetch`), so that policy is the one that
 * decides what the app can load.
 *
 * `ngsw-worker.js` is a **static file**, copied verbatim out of
 * `node_modules/@angular/service-worker/` by the build. It is byte-for-byte
 * identical across every deploy that does not bump `@angular/service-worker`.
 * The service worker Update algorithm fetches the script, compares it
 * byte-for-byte with the installed one, and — finding no difference — aborts
 * without installing anything. **A header-only change therefore never reaches
 * an already-installed worker.** Not after a reload, not after the 24-hour
 * update check, not ever.
 *
 * That is not theoretical. PR #112 added `https://apis.google.com` to
 * `connect-src` to fix Google sign-in. It fixed it for new visitors and for
 * fresh profiles, and did nothing at all for anyone whose worker predated the
 * deploy: their worker went on refusing the gapi script under the old policy,
 * `safeFetch` went on turning each refusal into a synthetic `504`, the
 * `<script>` element's `onerror` went on rejecting with `auth/internal-error`,
 * and the console went on quoting a `connect-src` that no longer existed
 * anywhere on the server. A hard reload "fixed" it only because that bypasses
 * the service worker entirely.
 *
 * ## What this does
 *
 * Appends a fingerprint of the CSP to the built worker. The bytes then change
 * exactly when the policy changes, so the update check finds a difference,
 * installs a new worker, and the new policy takes effect — including for
 * clients currently stuck on an old one, at their next update check.
 *
 * Deliberately a fingerprint of the policy rather than a build timestamp: a
 * timestamp would re-install the worker on every deploy, which is churn nobody
 * asked for. The CSP is the only response header that governs what the worker
 * may fetch, so it is the only one whose staleness is load-bearing. If a header
 * that also governs worker fetches is ever added (`Cross-Origin-Embedder-Policy`
 * is the realistic candidate), it belongs in `FINGERPRINTED_HEADERS` below.
 *
 * Safe to append to: `/ngsw-worker.js` is not listed in `ngsw.json`'s
 * `hashTable` or any asset group — the worker does not cache or hash itself —
 * so there is no manifest entry to keep in sync. Verified against a real build.
 *
 * Idempotent: an existing stamp is stripped before the new one is written, so
 * running this twice on the same build is a no-op rather than a pile-up.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const CONFIG = 'firebase.json';
const WORKER = 'dist/trivia-app/browser/ngsw-worker.js';

/** Response headers that govern what the service worker itself may fetch. */
const FINGERPRINTED_HEADERS = ['Content-Security-Policy'];

const STAMP_PREFIX = '// service-worker-policy-fingerprint:';
const STAMP_PATTERN = /\n*\/\/ service-worker-policy-fingerprint:.*\n?$/;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const hosting = Array.isArray(config.hosting) ? config.hosting[0] : config.hosting;
const rule = hosting.headers?.find((entry) => entry.source === '**');

if (!rule) {
  fail(`No '**' headers rule in ${CONFIG} — has it moved? The worker's policy comes from it.`);
}

const fingerprinted = FINGERPRINTED_HEADERS.map((key) => {
  const header = rule.headers?.find((h) => h.key.toLowerCase() === key.toLowerCase());
  if (!header) {
    fail(`No ${key} on the '**' rule in ${CONFIG} — nothing to fingerprint.`);
  }
  return `${key}: ${header.value}`;
});

const fingerprint = createHash('sha256')
  .update(fingerprinted.join('\n'))
  .digest('hex')
  .slice(0, 16);

if (!existsSync(WORKER)) {
  fail(
    `${WORKER} does not exist. This runs after a build that emits a service worker ` +
      `(the 'production' and 'lighthouse' configurations in angular.json). If a build ` +
      `stopped emitting one, that is the thing to fix — silently skipping would let the ` +
      `stamp quietly stop applying, which is the failure mode this script exists to prevent.`,
  );
}

const original = readFileSync(WORKER, 'utf8');
const stripped = original.replace(STAMP_PATTERN, '\n');
writeFileSync(WORKER, `${stripped}${STAMP_PREFIX} ${fingerprint}\n`);

console.log(
  `✓ Service worker stamped with policy fingerprint ${fingerprint}. A CSP change now changes ` +
    `the worker's bytes, so browsers re-install it and pick the new policy up.`,
);
