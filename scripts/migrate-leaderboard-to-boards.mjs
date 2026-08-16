import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

/**
 * One-off migration for finding G7: copies the pre-G7 flat `leaderboard`
 * collection into the 15-second board at `leaderboards/15/entries`.
 *
 * Every entry in the old collection was won under the fixed 15-second limit —
 * it was the only limit the game had — so that is the board they honestly
 * belong on. Nothing is deleted: the old collection is left exactly as it is,
 * so this can be re-run, and so a mistake here costs nothing.
 *
 * **Idempotent, and safe to run more than once.** It is meant to be: run it
 * once after the rules ship, and again after the client switches over, to
 * sweep up any score saved into the old collection in between. Re-running
 * writes an entry only when the old score actually beats what is already on
 * the board, which is the same rule the client plays by.
 *
 * It runs through the Admin SDK, which bypasses `firestore.rules` — that is
 * the point, since `timeLimit` is not a field the old documents have and no
 * client may write another user's entry. It also means the usual guardrails
 * are absent here, so the script refuses to touch anything unless it is told
 * exactly which project to talk to.
 *
 * The credential can be supplied either way, because both are normal:
 *
 *   # a file on disk
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     node scripts/migrate-leaderboard-to-boards.mjs --project intellectura-3b26a
 *
 *   # the key's JSON itself, e.g. from a Codespaces or CI secret, where there
 *   # is no file to point at
 *   GOOGLE_APPLICATION_CREDENTIALS_JSON="$SERVICE_ACCOUNT_JSON" \
 *     node scripts/migrate-leaderboard-to-boards.mjs --project intellectura-3b26a
 *
 * `GOOGLE_APPLICATION_CREDENTIALS` also accepts inline JSON, even though
 * Google's own convention is that it names a path. That is a deliberate
 * kindness rather than sloppiness: a secret store hands you a value, not a
 * file, so putting the JSON in the variable whose name you already know is
 * the obvious thing to try — and the failure when the script assumed a path
 * was `ENAMETOOLONG`, which says nothing at all about what went wrong.
 *
 * Add `--dry-run` to print what it would write and exit without writing. Do
 * that first.
 */

const BOARD = '15';
const BOARD_PATH = `leaderboards/${BOARD}/entries`;
const OLD_COLLECTION = 'leaderboard';

/** Exactly the keys `isValidBoardEntry` allows — anything else is dropped, not carried over. */
const ENTRY_KEYS = [
  'uid',
  'name',
  'score',
  'totalQuestions',
  'percentage',
  'createdAt',
  'timeLimit',
];

function parseArgs(argv) {
  const args = { dryRun: false, project: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--project') args.project = argv[++i] ?? '';
  }
  return args;
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const { dryRun, project } = parseArgs(process.argv.slice(2));

if (!project) {
  fail('--project is required. Refusing to guess which Firestore to write to.');
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

// The credential decides which project is actually reached; --project is the
// operator's statement of intent. Requiring both and checking they agree is
// what stops a stale ambient credential pointing this at the wrong database —
// the same reasoning as deriving Stripe's live/test mode from the key rather
// than from a project name (`CLAUDE.md` §4.3).
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
const firestore = getFirestore();

/** Shapes an old flat entry into a board entry, keeping only the allowed keys. */
function toBoardEntry(uid, data) {
  const entry = { ...data, uid, timeLimit: BOARD };
  return Object.fromEntries(Object.entries(entry).filter(([key]) => ENTRY_KEYS.includes(key)));
}

async function main() {
  console.log(`\nProject : ${project}`);
  console.log(`Source  : ${OLD_COLLECTION}`);
  console.log(`Target  : ${BOARD_PATH}`);
  console.log(dryRun ? 'Mode    : DRY RUN — nothing will be written\n' : 'Mode    : WRITING\n');

  const snapshot = await firestore.collection(OLD_COLLECTION).get();
  if (snapshot.empty) {
    console.log('Nothing to migrate: the old collection is empty.\n');
    return;
  }

  let copied = 0;
  let skipped = 0;
  let malformed = 0;

  for (const document of snapshot.docs) {
    const uid = document.id;
    const data = document.data();

    if (typeof data['score'] !== 'number' || typeof data['name'] !== 'string') {
      // Report rather than guess. A document the client could not have written
      // is a thing to look at, not a thing to reshape.
      console.warn(
        `  ? ${uid}  malformed (score=${data['score']}, name=${data['name']}) — skipped`,
      );
      malformed++;
      continue;
    }

    const targetRef = firestore.doc(`${BOARD_PATH}/${uid}`);
    const existing = await targetRef.get();

    if (existing.exists && existing.data()['score'] >= data['score']) {
      skipped++;
      continue;
    }

    const entry = toBoardEntry(uid, data);
    if (dryRun) {
      console.log(`  + ${uid}  ${entry.score}/${entry.totalQuestions}  ${entry.name}`);
    } else {
      await targetRef.set(entry);
    }
    copied++;
  }

  console.log(
    `\n${dryRun ? 'Would copy' : 'Copied'} ${copied}, left ${skipped} already-better entries ` +
      `alone${malformed ? `, skipped ${malformed} malformed` : ''}. ` +
      `The ${OLD_COLLECTION} collection is untouched.\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
