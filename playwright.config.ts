import { defineConfig, devices } from '@playwright/test';

/**
 * The end-to-end suite, run against the local Firebase Emulator Suite:
 * `npm run e2e` wraps this in `firebase emulators:exec --project
 * demo-trivia-app-e2e`, so the emulators are started and torn down outside the
 * runner and no real project is ever touched. The Angular dev server is the
 * one thing Playwright starts itself, through `webServer` below.
 *
 * `docs/ci-cd.md` §4.3 carries the rest: the fixtures, the isolation model and
 * the slice that runs against a real deployed channel instead.
 */

/**
 * CI splits the suite across two runners with `PLAYWRIGHT_SHARD=n/2`.
 *
 * An environment variable rather than the `--shard` flag, because the command
 * line belongs to the emulator wrapper: `npm run e2e -- --shard=1/2` appends
 * the flag to `firebase emulators:exec`, not to the `playwright test` it wraps.
 * A variable passes through unchanged, which keeps `npm run e2e` the single
 * entry point on CI and locally.
 *
 * A malformed value throws rather than being ignored: silently running the
 * whole suite on both runners would double the wall clock this exists to halve
 * and look like a pass.
 */
function shardFromEnvironment(): { current: number; total: number } | null {
  const value = process.env['PLAYWRIGHT_SHARD'];
  if (!value) {
    return null;
  }
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) {
    throw new Error(
      `PLAYWRIGHT_SHARD is "${value}", which is not of the form "<current>/<total>" (e.g. "1/2").`,
    );
  }
  return { current: Number(match[1]), total: Number(match[2]) };
}

export default defineConfig({
  testDir: './e2e/specs',

  /**
   * `service-worker-oauth-origins.spec.ts` is preview-only, and this runner has
   * nothing for it to test: `ng serve --configuration=e2e` sets no
   * `serviceWorker` in `angular.json`, so no `ngsw-worker.js` is emitted to
   * register, and a dev server sends none of `firebase.json`'s headers. It runs
   * against a real deployed Hosting channel only —
   * `playwright.preview.config.ts` replaces this list with its own, which does
   * not name it. Excluding at discovery rather than skipping inside the spec
   * means naming the file on the command line cannot run it here either.
   */
  testIgnore: ['**/service-worker-oauth-origins.spec.ts'],

  /**
   * Every test file runs in parallel, against **one shared emulator**. There is
   * no `resetBackend()` between tests here and there deliberately never will
   * be: a blanket wipe from one worker would delete the users and documents
   * another worker is mid-assertion on. Isolation comes from each test owning
   * unique ids instead — a unique email, a unique question id — which is the
   * same discipline the preview suite already needs against the real
   * `trivimind-dev` project, so one spec body serves both targets.
   *
   * A spec that genuinely cannot share the backend puts
   * `test.describe.configure({ mode: 'serial' })` at the top of its own file
   * and says why in a comment; that serialises one file, not the run.
   */
  fullyParallel: true,

  /**
   * Four workers, one per vCPU on the runners this has to fit.
   *
   * Six is faster on a 4-vCPU box — measured over the full suite, 4 workers
   * 134s wall against 6 workers 109s — because these tests are *wait*-bound
   * rather than CPU-bound: a five-question game spends ten of its twelve
   * seconds sitting out the result banner's 2s pause, doing nothing a core
   * could help with.
   *
   * Four is still the setting, and the argument is the one thing
   * over-subscription puts at risk here: the app's own **15-second
   * per-question countdown** is a real deadline, so a worker starved past it
   * loses the question and fails a test for a reason that has nothing to do
   * with the code. With `retries: 0` that is a red build. CI buys its wall
   * clock by sharding across two runners instead (`.github/workflows/e2e.yml`),
   * which is more parallelism without more contention per runner — the same
   * ~20% the sixth worker offered, without spending the countdown's headroom
   * to get it.
   */
  workers: 4,

  /**
   * Set by CI to split the suite across two runners; `null` locally, where the
   * whole suite runs in one process. Playwright shards whole parallel groups,
   * so a `mode: 'serial'` file stays intact on one runner.
   */
  shard: shardFromEnvironment(),

  /**
   * **Zero retries, here and on CI.** A retry turns a real intermittent defect
   * into a green run that hides it, and this repo's whole §4.6 contract is
   * about assertions that stop testing what they name without saying so. When
   * a test fails, the failure is the finding.
   */
  retries: 0,

  /** A `test.only` left in a spec must fail CI, not silently skip the rest. */
  forbidOnly: !!process.env['CI'],

  /**
   * Generous, because the app's own 15-second per-question countdown sets the
   * floor: a timeout below it means giving up on a button that is still there
   * and still clickable. On a loaded runner (emulators + dev server + four
   * browsers on four vCPUs) the runner itself can be starved for seconds at a
   * time, which is a slow test rather than a broken one.
   */
  timeout: 120_000,
  expect: { timeout: 20_000 },

  reporter: process.env['CI']
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://localhost:4200',

    /**
     * `getByTestId()` resolves `data-cy`, which is the attribute the templates
     * carry. The name is historical and the attributes are the test ids: they
     * are what every spec addresses a clickable element by (`CLAUDE.md` §4.6),
     * so renaming them across `src/` would be a large, entirely mechanical
     * diff through the application for no change in behaviour.
     */
    testIdAttribute: 'data-cy',

    actionTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  /**
   * Chromium only. Cross-browser coverage is a separate question from what this
   * suite is for, and adding browsers multiplies a suite that is already the
   * slowest check on a PR.
   *
   * The browser binary is **not** pinned here to a path. `@playwright/test` is
   * pinned to an exact version instead, and that version decides which
   * Chromium build `npx playwright install` fetches — so the browser is a
   * property of the lockfile rather than of whoever's machine is running.
   * `docs/ci-cd.md` §4.3 records the constraint that follows from it.
   */
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  /**
   * The Angular dev server, built with the `e2e` configuration
   * (`environment.e2e.ts`, `useEmulators: true`) so the app talks to the
   * emulators this run started. Locally an already-running server is reused,
   * which makes a single-spec re-run near-instant; on CI it never is, so a
   * stale server can't serve a stale build.
   */
  webServer: {
    command: 'npm run e2e:serve',
    url: 'http://localhost:4200',
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
