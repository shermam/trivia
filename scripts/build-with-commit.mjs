/**
 * Runs `ng build` with the current commit substituted into the bundle.
 *
 * Two `--define` values reach `src/app/build-info.ts`, which the footer renders
 * as a tooltip — so "which build is this deployment running?" is answerable
 * from the page instead of by inference. That question had no answer when
 * `trivimind-dev.web.app` was serving a months-old bundle while every preview
 * channel was current (`ci-cd.md` §4.2), and the absence is most of why that
 * took a round trip to diagnose.
 *
 * **A script rather than `$(git rev-parse …)` inline in `package.json`.** Shell
 * command substitution would be shorter, and it would be a shell dependency in
 * a place nothing else in this repo has one: npm runs scripts through `cmd` on
 * Windows, where neither `$( )` nor `git log --format=%cd` survives. The
 * fallback also belongs in a language with `try`/`catch` — building outside a
 * git checkout (a source tarball, a Docker context with no `.git`) has to
 * degrade to an unstamped build, not fail the build.
 *
 * **Commit date, not build time**, and the distinction is load-bearing: a clock
 * in the bundle makes every rebuild of the same commit emit different bytes,
 * hence a different content hash, a different `ngsw.json`, and a
 * service-worker update pushed to every client for a deploy that changed
 * nothing. The commit date answers the same "how stale is this?" question and
 * is a property of the commit.
 */
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const configuration = process.argv[2];
if (!configuration) {
  console.error('✗ Usage: node scripts/build-with-commit.mjs <angular-configuration>');
  process.exit(1);
}

/** A git fact, or an empty string when this is not a checkout. */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .replace(/'/g, '');
  } catch {
    return '';
  }
}

const commit = git(['rev-parse', '--short', 'HEAD']);
const commitDate = git(['log', '-1', '--format=%cd', '--date=format:%Y-%m-%d']);

if (!commit) {
  console.warn(
    "⚠ No git commit available — building unstamped. The footer will read 'local build'.",
  );
}

// esbuild takes the value as a JS expression, so a string has to arrive
// already quoted. Both values are git output matched against a strict shape
// before use, so there is nothing here that could close the quote.
const safe = (value) => (/^[A-Za-z0-9._-]*$/.test(value) ? value : '');
const define = [`NG_BUILD_COMMIT='${safe(commit)}'`, `NG_BUILD_COMMIT_DATE='${safe(commitDate)}'`];

const result = spawnSync(
  process.execPath,
  [
    require.resolve('@angular/cli/bin/ng.js'),
    'build',
    '--configuration',
    configuration,
    ...define.flatMap((value) => ['--define', value]),
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error(`✗ Could not run ng build: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
