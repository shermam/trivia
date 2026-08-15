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
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     node scripts/migrate-leaderboard-to-boards.mjs --project intellectura-3b26a
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

// The credential decides which project is actually reached; --project is the
// operator's statement of intent. Requiring both and checking they agree is
// what stops a stale ambient credential pointing this at the wrong database —
// the same reasoning as deriving Stripe's live/test mode from the key rather
// than from a project name (`CLAUDE.md` §4.3).
const credentialsPath = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
if (!credentialsPath) {
  fail('GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at a service-account JSON key.');
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(credentialsPath, 'utf8'));
} catch (error) {
  fail(`Could not read GOOGLE_APPLICATION_CREDENTIALS (${credentialsPath}): ${error.message}`);
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
