import { defineConfig, devices } from '@playwright/test';

/**
 * The Playwright end-to-end suite, run against the local Firebase Emulator
 * Suite exactly as the Cypress suite is: `npm run pw:e2e` wraps this in
 * `firebase emulators:exec --project demo-trivia-app-e2e`, so the emulators are
 * started and torn down outside the runner and no real project is ever
 * touched. The Angular dev server is the one thing Playwright starts itself,
 * through `webServer` below.
 *
 * `docs/ci-cd.md` §4.3 carries the rest: which suite runs where, and why there
 * are two of them at the moment.
 */
export default defineConfig({
  testDir: './e2e/specs',

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
   * Measured on a 4-vCPU box, wall clock over a **fourteen-test slice** of the
   * suite — the two specs that existed when the sweep was run, not the suite as
   * it stands: **2 workers 67s, 4 workers 45s, 6 workers 33s, 8 workers 33s.**
   * So on that slice the knee is at six,
   * not four, and the reason is that these tests are *wait*-bound rather than
   * CPU-bound — a five-question game spends ten of its twelve seconds sitting
   * out the result banner's 2s pause, doing nothing a core could help with.
   *
   * Four is still the setting, and the argument is the one thing over-
   * subscription puts at risk here: the app's own **15-second per-question
   * countdown** is a real deadline, so a worker starved past it loses the
   * question and fails a test for a reason that has nothing to do with the
   * code. With `retries: 0` that is a red build, and the evidence for six is
   * two runs of a fourteen-test slice — thin next to a suite that is going to
   * be several times larger and therefore more contended, not less. Revisit
   * the number against the whole suite, not against this one.
   */
  workers: 4,

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
     * `getByTestId()` resolves `data-cy`, so every attribute already in the
     * templates works unchanged and neither suite has to grow a second set of
     * hooks while both exist.
     */
    testIdAttribute: 'data-cy',

    actionTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  /**
   * Chromium only, matching what Cypress ran. Cross-browser coverage is a
   * separate question from this migration and is not answered by switching
   * runners.
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
