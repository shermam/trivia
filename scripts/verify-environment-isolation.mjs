import { readFileSync, readdirSync } from 'node:fs';

/**
 * Fails when anything a developer runs locally, or anything built for a
 * non-production target, can reach the **production** Firebase project.
 *
 * **Why a script and not a paragraph.** This did not fail loudly, it failed
 * silently and for months: `angular.json`'s `development` build carried no
 * `fileReplacements`, so `ng serve` — the default configuration — loaded
 * `environment.ts` (`production: true`, `useEmulators: false`) and
 * `src/proxy.conf.json` forwarded `/__/firebase/init.json` to the live
 * Hosting site. `npm start` therefore initialised Firebase against
 * production, and `src/environments/environment.development.ts` sat in the
 * repo the whole time, never substituted, looking exactly like the thing that
 * prevented it. Nothing was red. Nothing could be: the app worked, which is
 * the problem — it worked against the real database.
 *
 * That is the shape this file exists for. The same reasoning as
 * `verify-csp.mjs` and `verify-motion.mjs`: a guardrail nothing enforces is a
 * comment, and this one guards the difference between a scratch database and
 * the users'.
 *
 * ## What it checks
 *
 * 1. **Every non-production build substitutes a non-production environment
 *    file.** A configuration that omits `fileReplacements` silently inherits
 *    `environment.ts`, which is exactly how this happened.
 * 2. **No dev-facing config names the production project.** The id lives in
 *    `.firebaserc` and nowhere else it can be reached from a dev server.
 * 3. **Every emulator project id carries the `demo-` prefix**, in the
 *    environment files and in the `--project` flags that start them. The
 *    prefix is not cosmetic: `isDemoProject()` keys the mock-checkout gate on
 *    it (audit A7), so a non-demo id turns real Stripe calls back on in a
 *    local emulator.
 * 4. **Every script that starts emulators passes an explicit `--project`.**
 *    Without one, Firebase resolves `.firebaserc`'s default — the production
 *    id — which is how `npm run firebase:emulate` came to run under it.
 * 5. **The app's emulator project id matches the one the emulators start
 *    with.** They are namespaced per project, so a mismatch is not an error;
 *    it is an empty database and a confusing hour.
 *
 * ## What it deliberately does not check
 *
 * The production build, `.firebaserc`, and `firebase:deploy` — production is
 * *supposed* to name the production project. The rule is about everything
 * else.
 *
 * And the `test` build, which deliberately inherits `environment.ts`. The
 * unit suite's `fetch` fakes are written against the production REST URL
 * shape, because that is the code path worth testing; a suite that asserted
 * emulator URLs would be asserting the arrangement rather than the app.
 * Nothing in it reaches a network, so there is no isolation to enforce.
 *
 * That configuration exists because of a real side effect, worth knowing
 * before touching `development` again: `@angular/build:unit-test` defaults
 * its `buildTarget` to `::development`, so putting a `fileReplacements` there
 * silently moved what the entire unit suite compiles against, and twenty-odd
 * specs went red at once. `test` now pins it explicitly.
 */

const PRODUCTION_PROJECT_ID = 'intellectura-3b26a';

/** Build configurations that must not run against production. */
const NON_PRODUCTION_BUILDS = ['development', 'e2e', 'lighthouse', 'dev-project'];

/** Files a developer's machine can reach that must never name production. */
const DEV_FACING_FILES = ['src/proxy.conf.json', 'package.json'];

const offences = [];
const fail = (where, what) => offences.push({ where, what });

// `angular.json` has JSON-with-comments in places, so strip them before parsing.
const stripComments = (source) => source.replace(/^\s*\/\/.*$/gm, '');
const angular = JSON.parse(stripComments(readFileSync('angular.json', 'utf8')));
const buildTarget = angular.projects['trivia-app'].architect.build;
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

// ---- 1. every non-production build substitutes an environment file --------
for (const name of NON_PRODUCTION_BUILDS) {
  const config = buildTarget.configurations[name];
  if (!config) {
    fail(`angular.json build:${name}`, 'configuration is missing');
    continue;
  }
  const replacements = config.fileReplacements ?? [];
  const replacesEnvironment = replacements.some(
    (r) =>
      r.replace === 'src/environments/environment.ts' &&
      r.with !== 'src/environments/environment.ts',
  );
  if (!replacesEnvironment) {
    fail(
      `angular.json build:${name}`,
      'no fileReplacements for src/environments/environment.ts — this configuration silently inherits the production environment',
    );
  }
}

// ---- 2. no dev-facing file names the production project ------------------
for (const file of DEV_FACING_FILES) {
  const source = readFileSync(file, 'utf8');
  // `firebase:deploy` is production's own script and is allowed to say so.
  const lines = source.split('\n').filter((line) => !/"firebase:deploy"/.test(line));
  if (lines.join('\n').includes(PRODUCTION_PROJECT_ID)) {
    fail(file, `names the production project (${PRODUCTION_PROJECT_ID})`);
  }
}

// ---- 3. emulator project ids are demo- prefixed --------------------------
const environmentIds = new Map();
for (const file of readdirSync('src/environments')) {
  const source = readFileSync(`src/environments/${file}`, 'utf8');
  const usesEmulators = /useEmulators:\s*true/.test(source);
  const id = /emulatorProjectId:\s*'([^']*)'/.exec(source)?.[1];
  if (id === undefined) {
    fail(
      `src/environments/${file}`,
      'declares no emulatorProjectId — every environment file has the same shape',
    );
    continue;
  }
  if (!usesEmulators) {
    continue;
  }
  environmentIds.set(file, id);
  if (!id.startsWith('demo-')) {
    fail(
      `src/environments/${file}`,
      `emulatorProjectId "${id}" is missing the demo- prefix, which is what isDemoProject() gates the mock checkout on (audit A7)`,
    );
  }
}

// ---- 4 + 5. emulator scripts pass an explicit demo- project, and it matches
const emulatorScripts = Object.entries(packageJson.scripts).filter(([, command]) =>
  /firebase emulators:(start|exec)/.test(command),
);
if (emulatorScripts.length === 0) {
  fail('package.json', 'no script starts the emulators — has one been renamed?');
}
const scriptProjectIds = new Set();
for (const [name, command] of emulatorScripts) {
  const id = /--project\s+(\S+)/.exec(command)?.[1];
  if (!id) {
    fail(
      `package.json scripts.${name}`,
      'starts emulators with no --project, so Firebase resolves .firebaserc — the production project',
    );
    continue;
  }
  scriptProjectIds.add(id);
  if (!id.startsWith('demo-')) {
    fail(`package.json scripts.${name}`, `--project ${id} is missing the demo- prefix`);
  }
}

const developmentId = environmentIds.get('environment.development.ts');
if (developmentId && !scriptProjectIds.has(developmentId)) {
  fail(
    'src/environments/environment.development.ts',
    `emulatorProjectId "${developmentId}" matches no emulator script's --project (${[...scriptProjectIds].join(', ') || 'none'}) — emulator data is namespaced per project, so this reads as an empty database rather than an error`,
  );
}

if (offences.length > 0) {
  console.error('\n  Environment isolation — something non-production can reach production.\n');
  for (const { where, what } of offences) {
    console.error(`    ${where}\n      ${what}\n`);
  }
  console.error('  The rule and its history are documented at the top of this file.\n');
  process.exit(1);
}

console.log(
  `✓ Environments: ${NON_PRODUCTION_BUILDS.length} non-production build(s) isolated, ` +
    `${emulatorScripts.length} emulator script(s) pinned to a demo- project`,
);
