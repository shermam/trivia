import { registerHooks } from 'node:module';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { initAdminApp } from './admin-credential.mjs';

/**
 * One-off migration for `FEAT-052`: writes onto every `custom_questions`
 * document the tag its `category` derives, when the document does not carry it
 * already.
 *
 * **Why a write is needed at all, when every reader already derives the tag.**
 * The quiz card, the recap, the reviewer's card, `/my-questions` and the
 * offline pool read a question's topic through `topicTagsOf()`, which falls
 * back to the category — but the community *draw* cannot. It filters in the
 * query, with an `array-contains-any` on `tags`, and a document with no `tags`
 * array matches no such clause whatever a reader would derive for it. With the
 * category picker gone, a player who picks `history` would be served the
 * community questions somebody tagged and none of the bank's existing History
 * questions. Only a write fixes that — the same shape that made `status` need
 * `backfill-question-status.mjs`.
 *
 * **One derivation, not a copy of it.** The tag comes from `categoryTag()` in
 * `src/app/utils/category-tags.ts` — the function every reader uses — imported
 * straight from the app's source through Node's own type stripping, so the
 * tag written here can never differ from the tag a reader would have derived.
 * The resolve hook below is what lets that file's extensionless relative
 * import (`./normalize-tag.util`) load outside the Angular build, and it tells
 * Node the files are TypeScript modules rather than leaving it to guess.
 *
 * **What it does, per document, and nothing else:**
 *
 * - **Appends** the derived tag when the document has a category, does not
 *   carry the tag already, and holds fewer than eight tags. `arrayUnion`, so a
 *   tag an author added in the meantime is never written twice.
 * - **Skips and counts** a tag already present, a list already at eight (the
 *   most `firestore.rules` stores), a category that derives nothing (`!!`, or
 *   a string past the normaliser's 32 characters), and a document with no
 *   category at all — every contribution written since topics replaced
 *   categories.
 * - **Reports and leaves alone** a `tags` value that is not a well-formed list
 *   — not a list, an element the rules would refuse, a duplicate, more than
 *   eight. Reshaping data this script did not write is how a migration turns
 *   into a bug; the precedent reports a status it does not recognise for the
 *   same reason.
 *
 * It touches no other field — the category stays where it is, because an
 * owner edit is what retires it — and it is idempotent: a second run appends
 * nothing.
 *
 * It runs through the Admin SDK, which bypasses `firestore.rules` — that is
 * the point, since no client may write another author's question. Credential
 * handling, the `--project` cross-check and why it exists all live in
 * `admin-credential.mjs`.
 *
 * **A dry run unless told to write.** Without `--write` it reads, prints what
 * it would append and the counted report, and writes nothing — so the command
 * that is typed first is the one that cannot change anything:
 *
 *   node scripts/backfill-category-tags.mjs --project trivimind-dev
 *   node scripts/backfill-category-tags.mjs --project trivimind-dev --write
 *
 * `docs/data-model.md` carries the runbook: both projects, `trivimind-dev`
 * first, a dry run before each write, and one more pass after the deploy.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromTypeScript = context.parentURL?.endsWith('.ts') ?? false;
    if (fromTypeScript && specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return { ...nextResolve(`${specifier}.ts`, context), format: 'module-typescript' };
    }
    const resolved = nextResolve(specifier, context);
    return resolved.url.endsWith('.ts') ? { ...resolved, format: 'module-typescript' } : resolved;
  },
});

const { categoryTag } = await import('../src/app/utils/category-tags.ts');
const { MAX_TAGS_PER_QUESTION, isNormalizedTag } =
  await import('../src/app/utils/normalize-tag.util.ts');

const COLLECTION = 'custom_questions';

/** Firestore's own ceiling on a batched write — see `backfill-question-status.mjs`. */
const BATCH_LIMIT = 500;

const { dryRun: dryRunFlag, project, write } = initAdminApp(process.argv.slice(2));
// `--dry-run` alongside `--write` is a contradiction, and the safe reading of
// a contradiction is the one that writes nothing.
const dryRun = dryRunFlag || !write;
const firestore = getFirestore();

/** A stored `tags` value the rules would accept, or `null` for anything else. */
function wellFormedTags(value) {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_TAGS_PER_QUESTION ||
    !value.every(isNormalizedTag) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return value;
}

/** What the script will do with one document, decided before anything is written. */
function planFor(document) {
  const category = document.get('category');
  if (category === undefined) {
    return { kind: 'noCategory' };
  }
  const tags = wellFormedTags(document.get('tags'));
  if (tags === null) {
    return { kind: 'unexpectedTags', value: document.get('tags') };
  }
  const tag = categoryTag(category);
  if (tag === null) {
    return { kind: 'derivesNothing', category };
  }
  if (tags.includes(tag)) {
    return { kind: 'alreadyPresent', tag };
  }
  if (tags.length >= MAX_TAGS_PER_QUESTION) {
    return { kind: 'listFull', tag };
  }
  return { kind: 'append', tag, category };
}

async function main() {
  console.log(`\nProject    : ${project}`);
  console.log(`Collection : ${COLLECTION}`);
  console.log("Appending  : the tag each question's category derives, where it is missing");
  console.log(
    dryRun
      ? 'Mode       : DRY RUN — nothing will be written (add --write to write)\n'
      : 'Mode       : WRITING\n',
  );

  const snapshot = await firestore.collection(COLLECTION).get();
  const plans = snapshot.docs.map((document) => ({ document, plan: planFor(document) }));
  const count = (kind) => plans.filter(({ plan }) => plan.kind === kind).length;

  for (const { document, plan } of plans) {
    if (plan.kind === 'derivesNothing') {
      console.warn(`  ? ${document.id}  category ${JSON.stringify(plan.category)} derives no tag`);
    } else if (plan.kind === 'listFull') {
      console.warn(`  ! ${document.id}  already holds eight tags; #${plan.tag} not appended`);
    } else if (plan.kind === 'unexpectedTags') {
      console.warn(`  ? ${document.id}  unexpected tags ${JSON.stringify(plan.value)}, left alone`);
    }
  }

  const toAppend = plans.filter(({ plan }) => plan.kind === 'append');
  let appended = 0;
  for (let start = 0; start < toAppend.length; start += BATCH_LIMIT) {
    const chunk = toAppend.slice(start, start + BATCH_LIMIT);

    if (dryRun) {
      for (const { document, plan } of chunk) {
        console.log(`  + ${document.id}  ${JSON.stringify(plan.category)} → #${plan.tag}`);
      }
      appended += chunk.length;
      continue;
    }

    const batch = firestore.batch();
    // `update`, not `set(..., { merge: true })`: update fails on a document
    // deleted since the snapshot was taken, which is what should happen — a
    // merging set would recreate it holding nothing but a tag. `arrayUnion`
    // appends only what is missing, so an author's own edit landing between
    // the read and this write cannot be turned into a duplicate.
    for (const { document, plan } of chunk) {
      batch.update(document.ref, { tags: FieldValue.arrayUnion(plan.tag) });
    }
    await batch.commit();
    appended += chunk.length;
    console.log(`  committed ${appended}/${toAppend.length}`);
  }

  const rows = [
    ['Documents read', snapshot.size],
    [dryRun ? 'Tags that would be appended' : 'Tags appended', appended],
    ['Skipped — tag already present', count('alreadyPresent')],
    ['Skipped — list already at eight', count('listFull')],
    ['Skipped — category derives nothing', count('derivesNothing')],
    ['Skipped — no category to derive from', count('noCategory')],
    ['Left alone — unexpected tags value', count('unexpectedTags')],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  console.log(`\n${dryRun ? 'Report (dry run)' : 'Report'}`);
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(width)}  ${value}`);
  }
  console.log('\nNo field other than tags was touched.\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
