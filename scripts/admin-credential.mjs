import { cert, initializeApp } from 'firebase-admin/app';
import { readFileSync } from 'node:fs';

/**
 * Shared setup for the Admin SDK maintenance scripts in this directory.
 *
 * These scripts exist precisely because they bypass `firestore.rules` — that
 * is what lets them write fields no client may write and touch documents no
 * client owns. The usual guardrails are therefore absent, so the one guardrail
 * they do have has to be right: **the credential decides which project is
 * actually reached, and `--project` is the operator's statement of intent.**
 * Requiring both and refusing to run when they disagree is what stops a stale
 * ambient credential quietly pointing a migration at the wrong database. Same
 * reasoning as deriving Stripe's live/test mode from the key rather than from
 * a project name (`CLAUDE.md` §4.3): the credential cannot contradict reality,
 * while a name is a guess about configuration that configuration is free to
 * disagree with.
 *
 * Extracted from `migrate-leaderboard-to-boards.mjs` when the question-status
 * backfill needed the same 120 lines. Two copies of credential handling is two
 * places for the project check to rot out of step, and the check is the whole
 * safety story.
 *
 * The credential can be supplied either way, because both are normal:
 *
 *   # a file on disk
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     node scripts/<script>.mjs --project intellectura-3b26a
 *
 *   # the key's JSON itself, e.g. from a Codespaces or CI secret, where there
 *   # is no file to point at
 *   GOOGLE_APPLICATION_CREDENTIALS_JSON="$SERVICE_ACCOUNT_JSON" \
 *     node scripts/<script>.mjs --project intellectura-3b26a
 *
 * `GOOGLE_APPLICATION_CREDENTIALS` also accepts inline JSON, even though
 * Google's own convention is that it names a path. That is a deliberate
 * kindness rather than sloppiness: a secret store hands you a value, not a
 * file, so putting the JSON in the variable whose name you already know is the
 * obvious thing to try — and the failure when the script assumed a path was
 * `ENAMETOOLONG`, which says nothing at all about what went wrong.
 */

/** Prints a message the way these scripts print failures, and stops. */
export function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/** `--project <id>` and `--dry-run`, the two flags every script here takes. */
export function parseArgs(argv) {
  const args = { dryRun: false, project: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--project') args.project = argv[++i] ?? '';
  }
  return args;
}

/**
 * Parses a service-account key, saying something useful when it will not parse.
 *
 * The control-character case is called out by name because it is the one a
 * secret store actually produces: a key's `private_key` is a single JSON
 * string containing `\n` escapes, and pasting it somewhere that turns those
 * into real newlines yields JSON that is invalid in a way the default message
 * ("Bad control character in string literal") does not explain.
 */
function parseServiceAccount(raw, source) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const hint = /control character/i.test(error.message)
      ? ' — the key looks like it was pasted with real newlines inside private_key. ' +
        'Store the file\'s exact bytes, so the "\\n" escapes stay escaped.'
      : '';
    fail(`${source} is not valid JSON: ${error.message}${hint}`);
  }
}

/**
 * Resolves the credential from either a file path or inline JSON.
 *
 * Inline is detected by shape rather than by a flag: a service-account key is
 * a JSON object, and no filesystem path begins with `{`, so the two cases
 * cannot be confused for one another.
 */
function loadServiceAccount() {
  const inline = process.env['GOOGLE_APPLICATION_CREDENTIALS_JSON'];
  if (inline?.trim()) {
    return parseServiceAccount(inline, 'GOOGLE_APPLICATION_CREDENTIALS_JSON');
  }

  const fromEnv = process.env['GOOGLE_APPLICATION_CREDENTIALS']?.trim();
  if (!fromEnv) {
    fail(
      'No credential supplied. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account ' +
        "JSON file's path, or GOOGLE_APPLICATION_CREDENTIALS_JSON to the key's JSON itself.",
    );
  }

  if (fromEnv.startsWith('{')) {
    // Unset it before any Google library sees it. The variable is Google's own
    // convention for a *path*, so leaving several kilobytes of JSON in it
    // invites some other code path to hand it to open(2) and fail exactly the
    // way this script used to.
    delete process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    return parseServiceAccount(fromEnv, 'GOOGLE_APPLICATION_CREDENTIALS (read as inline JSON)');
  }

  try {
    return parseServiceAccount(readFileSync(fromEnv, 'utf8'), `The key file at ${fromEnv}`);
  } catch (error) {
    fail(`Could not read GOOGLE_APPLICATION_CREDENTIALS (${fromEnv}): ${error.message}`);
  }
}

/**
 * Parses the arguments, resolves and cross-checks the credential, initializes
 * the Admin app, and hands back `{ dryRun, project }`.
 *
 * Every exit path here is a `process.exit(1)` with an explanation, so a script
 * that gets a value back from this has a credential that is real, parseable,
 * and for the project the operator named.
 */
export function initAdminApp(argv) {
  const { dryRun, project } = parseArgs(argv);

  if (!project) {
    fail('--project is required. Refusing to guess which Firestore to write to.');
  }

  const serviceAccount = loadServiceAccount();

  if (!serviceAccount.project_id) {
    fail('That credential has no project_id — it does not look like a service-account key.');
  }

  if (serviceAccount.project_id !== project) {
    fail(
      `Credential is for project "${serviceAccount.project_id}" but --project says "${project}". ` +
        'Refusing to run against a project you did not name.',
    );
  }

  initializeApp({ credential: cert(serviceAccount), projectId: project });
  return { dryRun, project };
}
