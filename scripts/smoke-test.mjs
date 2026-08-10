#!/usr/bin/env node
/**
 * Post-deploy smoke test: asks the *deployed* site whether it actually works.
 *
 * Finding D3. The merge-to-deploy pipeline had nothing checking its own
 * outcome, and it showed: four consecutive deploys failed after Hosting had
 * already shipped, leaving production running a new client against functions
 * four merges stale, and nobody noticed until someone happened to watch a run.
 *
 * Deliberately a standalone script rather than steps inlined in the workflow.
 * Workflow YAML can only be tested by merging it; this can be run against
 * production (or any preview URL) from a laptop, which is the difference
 * between a check that was verified and one that was merely written:
 *
 *     node scripts/smoke-test.mjs https://trivimind.com
 *
 * What it deliberately does **not** do: assert that the deployed *code* is the
 * commit that just built. Hosting has no version endpoint to ask, and adding a
 * build-stamp file only to assert on it would be inventing a fact to check.
 * The deploy step failing is what catches "did not ship"; this catches "shipped
 * and is broken", which is the case nothing else covers.
 */

const DEFAULT_ORIGIN = 'https://trivimind.com';
const PROJECT_ID = 'intellectura-3b26a';
const FUNCTIONS_ORIGIN = `https://us-central1-${PROJECT_ID}.cloudfunctions.net`;
const TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 5_000;

const origin = (process.argv[2] ?? DEFAULT_ORIGIN).replace(/\/$/, '');

/** Every check that must hold for a deploy to count as good. */
const checks = [
  {
    name: 'app shell is served',
    async run() {
      const response = await get('/');
      expect(response.status === 200, `expected 200, got ${response.status}`);
      expect(response.body.includes('<app-root'), 'index.html has no <app-root> element');
    },
  },
  {
    // A8/A9. The CSP is the app's only defence against injected script and
    // against being framed, and a weakened one is invisible: the app boots and
    // renders identically either way.
    name: 'security headers are intact',
    async run() {
      const response = await get('/');
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp !== '', 'no Content-Security-Policy header');
      expect(csp.includes("frame-ancestors 'none'"), 'CSP no longer forbids framing');
      expect(!csp.includes('unsafe-inline'), "CSP has regained 'unsafe-inline'");
      expect(!csp.includes('unsafe-eval'), "CSP has regained 'unsafe-eval'");
      expect(
        response.headers.get('x-content-type-options') === 'nosniff',
        'X-Content-Type-Options is not nosniff',
      );
      expect(
        (response.headers.get('referrer-policy') ?? '') === 'strict-origin-when-cross-origin',
        'Referrer-Policy is not strict-origin-when-cross-origin',
      );
    },
  },
  {
    // The app fetches its Firebase config at runtime instead of committing it
    // (§2.3), so this endpoint failing means a booting app with no backend —
    // and it is served by Hosting, not by the bundle, so a build cannot catch it.
    name: 'runtime Firebase config resolves',
    async run() {
      const response = await get('/__/firebase/init.json');
      expect(response.status === 200, `expected 200, got ${response.status}`);
      const config = JSON.parse(response.body);
      expect(
        config.projectId === PROJECT_ID,
        `init.json points at ${config.projectId}, expected ${PROJECT_ID}`,
      );
    },
  },
  {
    // Referenced by index.html as a render-blocking <script src>. It lives in
    // public/, so it is copied rather than bundled — a build cannot tell you it
    // stopped being copied, and a 404 here means every visit flashes the wrong
    // theme (§1.7).
    name: 'theme initialiser is reachable',
    async run() {
      const response = await get('/theme-init.js');
      expect(response.status === 200, `expected 200, got ${response.status}`);
    },
  },
  {
    // Proves the functions package is deployed *and* that its authorisation
    // boundary holds, without executing anything: the callable rejects an
    // unauthenticated caller before it does any work. A 404 here is exactly the
    // failure mode that went unnoticed for four merges.
    name: 'callable functions are deployed and reject unauthenticated callers',
    async run() {
      const response = await post(`${FUNCTIONS_ORIGIN}/deleteAccount`, { data: {} });
      expect(
        response.status !== 404,
        'deleteAccount returned 404 — the functions package is not deployed',
      );
      expect(response.status === 401, `expected 401 UNAUTHENTICATED, got ${response.status}`);
      expect(
        response.body.includes('UNAUTHENTICATED'),
        'callable did not reject with UNAUTHENTICATED',
      );
    },
  },
];

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function get(path) {
  return request(path.startsWith('http') ? path : `${origin}${path}`, { method: 'GET' });
}

async function post(url, body) {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * One bounded retry, and only for a *timed-out* attempt (issue #87): a fresh
 * Hosting deploy can leave a cold CDN edge that hangs the first fetch of a
 * path while the site is perfectly healthy, and a smoke test that files a
 * deploy-failure issue over warmup teaches people to ignore the real one.
 * Everything else stays exactly as loud as before — assertion failures happen
 * in the checks and never reach this path, an HTTP error status is a
 * *response* (never retried), and a second timeout fails the check.
 */
async function request(url, init) {
  try {
    return await attempt(url, init);
  } catch (error) {
    if (!isTimeout(error)) {
      throw error;
    }
    console.log(`        (request timed out, retrying once in ${RETRY_DELAY_MS / 1000}s)`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return attempt(url, init);
  }
}

async function attempt(url, init) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

function isTimeout(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

const failures = [];
console.log(`Smoke-testing ${origin}\n`);

for (const check of checks) {
  try {
    await check.run();
    console.log(`  ok    ${check.name}`);
  } catch (error) {
    failures.push({ name: check.name, message: error.message });
    console.log(`  FAIL  ${check.name}`);
    console.log(`        ${error.message}`);
  }
}

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} of ${checks.length} checks failed against ${origin}.`);
  console.log('The deploy has already shipped — see INFRASTRUCTURE.md §6.3a for the rollback.');
  process.exit(1);
}
console.log(`All ${checks.length} checks passed.`);
