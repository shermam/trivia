import { getFirestore } from 'firebase-admin/firestore';
import { initAdminApp } from './admin-credential.mjs';

/**
 * One-off migration for `BACKLOG.md` item 4b: stamps `status: 'approved'` onto
 * every `custom_questions` document written before the field existed.
 *
 * **`'approved'` is the honest value, not a default.** Every question already
 * in the bank was published the moment it was written and has been served to
 * players ever since — that is exactly what review-before-publish is changing.
 * Recording them as approved states what already happened. Contrast `createdBy`
 * (A10), which could never be backfilled because nobody recorded who wrote
 * those documents and no value would have been true.
 *
 * **Idempotent, and it must be run between two deploys.** The ordering is the
 * whole hazard, so it is worth stating plainly:
 *
 *   1. Deploy the PR that adds `status` to the rules allowlist and makes the
 *      client write it. Nothing reads the field yet, so nothing can break.
 *   2. **Run this script.** Old documents get their status.
 *   3. Only then deploy the PR that makes the client filter on
 *      `status == 'approved'`.
 *
 * Run at step 3 instead of step 2 and every question that predates the change
 * vanishes from the game, because a document with no `status` matches no
 * equality filter on it. There is no partial-credit failure mode here: it is
 * the whole bank.
 *
 * It runs through the Admin SDK, which bypasses `firestore.rules` — that is
 * the point, since `custom_questions` is create-only for every client and no
 * client may set this field on a document it already wrote. Credential
 * handling, the `--project` cross-check and why it exists all live in
 * `admin-credential.mjs`.
 *
 * Add `--dry-run` to print what it would write and exit without writing. Do
 * that first.
 */

const COLLECTION = 'custom_questions';
const STATUS = 'approved';

/**
 * Firestore's own ceiling on a batched write. Batching matters here in a way
 * it did not for the leaderboard migration, which wrote one document per user
 * and had a few hundred at most: this touches every question in the bank, and
 * a write-per-document round trip would be both slow and needlessly billed as
 * separate operations.
 */
const BATCH_LIMIT = 500;

const { dryRun, project } = initAdminApp(process.argv.slice(2));
const firestore = getFirestore();

async function main() {
  console.log(`\nProject    : ${project}`);
  console.log(`Collection : ${COLLECTION}`);
  console.log(`Setting    : status = "${STATUS}" on documents that have none`);
  console.log(
    dryRun ? 'Mode       : DRY RUN — nothing will be written\n' : 'Mode       : WRITING\n',
  );

  const snapshot = await firestore.collection(COLLECTION).get();
  if (snapshot.empty) {
    console.log('Nothing to do: the collection is empty.\n');
    return;
  }

  // Documents that already carry a status are left completely alone — that is
  // what makes re-running safe, and it also means a question a reviewer has
  // since rejected can never be silently re-approved by a second run.
  const needsStatus = snapshot.docs.filter((document) => document.get('status') === undefined);

  // A document whose status is present but is not one of the values the app
  // knows is reported rather than corrected. Reshaping data this script did not
  // write is how a migration turns into a bug: report it and let a human look.
  const unexpected = snapshot.docs.filter((document) => {
    const value = document.get('status');
    return value !== undefined && !['approved', 'pending', 'rejected'].includes(value);
  });
  for (const document of unexpected) {
    console.warn(`  ? ${document.id}  unexpected status ${JSON.stringify(document.get('status'))}`);
  }

  console.log(
    `${snapshot.size} question${snapshot.size === 1 ? '' : 's'} in the bank, ` +
      `${needsStatus.length} without a status.\n`,
  );

  if (needsStatus.length === 0) {
    console.log('Nothing to do: every question already has a status.\n');
    return;
  }

  let written = 0;
  for (let start = 0; start < needsStatus.length; start += BATCH_LIMIT) {
    const chunk = needsStatus.slice(start, start + BATCH_LIMIT);

    if (dryRun) {
      for (const document of chunk) {
        console.log(`  + ${document.id}  ${String(document.get('question')).slice(0, 60)}`);
      }
      written += chunk.length;
      continue;
    }

    const batch = firestore.batch();
    // `update`, not `set(..., { merge: true })`: update fails on a document
    // that has been deleted since the snapshot was taken, which is what should
    // happen. A merging set would recreate it, holding nothing but a status.
    for (const document of chunk) {
      batch.update(document.ref, { status: STATUS });
    }
    await batch.commit();
    written += chunk.length;
    console.log(`  committed ${written}/${needsStatus.length}`);
  }

  console.log(
    `\n${dryRun ? 'Would set' : 'Set'} status on ${written} question${written === 1 ? '' : 's'}` +
      `${unexpected.length ? `, left ${unexpected.length} with an unexpected status alone` : ''}. ` +
      'No question content was touched.\n',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
