import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { getFirestore } from 'firebase-admin/firestore';
import { fail, initAdminApp } from './admin-credential.mjs';

/**
 * Writes one curated quiz (`FEAT-024`) from a JSON definition file — the way a
 * quiz gets into `quizzes/{id}` besides typing it into the Firebase console.
 *
 * **Why a script at all.** `firestore.rules` refuses every client write to
 * `quizzes`, so there is no screen to make one in, and that is deliberate: a
 * collection with no client write path has nothing for a rule to defend. It
 * also has no rule to *validate* with, which makes this script the only thing
 * that checks a quiz before it is written — the definition goes through
 * `validateQuizDefinition()` from `src/app/utils/quiz-definition.util.ts`,
 * imported from the app's own source through Node's type stripping, so the
 * bounds the script writes within and the ones `quiz-definition.util.spec.ts`
 * pins are one set rather than two that can drift.
 *
 * **What it does:**
 *
 * - Validates the file and reports **every** problem at once, before any
 *   credential is read.
 * - Reads each question the quiz names and reports its state. A question that
 *   does not exist **stops the run** — in a hand-written file that is a typo,
 *   and the app would silently skip it. A question that exists but is not
 *   approved is reported and allowed: the quiz plays without it until a
 *   reviewer approves it, which is the app's own rule. A *published* quiz with
 *   no approved question at all is refused, since it could only ever say it
 *   cannot start.
 * - Writes the whole document with `set()`, so a field removed from the file
 *   is removed from the quiz. `createdAt` is the one field it does not take
 *   from the file: it is stamped on the first write and kept on every rewrite,
 *   so re-running the script to fix a typo or to publish a draft does not make
 *   an old quiz look new to the list on `/`, which is ordered by it.
 *
 * It runs through the Admin SDK, which bypasses `firestore.rules` — that is the
 * point. Credential handling and the `--project` cross-check live in
 * `admin-credential.mjs`.
 *
 * **A dry run unless told to write**, like `backfill-category-tags.mjs`: the
 * command typed first is the one that cannot change anything.
 *
 *   node scripts/seed-quiz.mjs --project trivimind-dev --file quiz.json
 *   node scripts/seed-quiz.mjs --project trivimind-dev --file quiz.json --write
 *
 * The definition file:
 *
 *   {
 *     "id": "world-cup-1998",
 *     "title": "The 1998 World Cup",
 *     "description": "Ten questions, in the order the tournament played them.",
 *     "questionIds": ["<custom_questions id>", "..."],
 *     "createdBy": "<the curator's uid, or a name you will recognise>",
 *     "isPublished": false
 *   }
 *
 * plus, optionally, `tags`, `language`, `sponsorId` and `suggestedTimeLimit`
 * (15, 30 or "unlimited"). `docs/data-model.md` carries the runbook.
 *
 * Needs Node 22.18 or later for the type stripping — the repo's 24 is what it
 * was run with — for the reason `backfill-category-tags.mjs` gives.
 */

// Lets the app's TypeScript load outside the Angular build: its relative
// imports carry no extension, and Node is told the files are TypeScript
// modules rather than left to guess. The same hook `backfill-category-tags.mjs`
// registers, for the same reason.
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

const { validateQuizDefinition } = await import('../src/app/utils/quiz-definition.util.ts');
const { QUIZZES_COLLECTION } = await import('../src/app/models/quiz.model.ts');

const QUESTIONS_COLLECTION = 'custom_questions';

/** `--file <path>`: the one flag this script takes beyond the shared three. */
function definitionPath(argv) {
  const index = argv.indexOf('--file');
  const path = index === -1 ? '' : (argv[index + 1] ?? '');
  if (!path || path.startsWith('--')) {
    fail('--file <path> is required: the JSON file describing the quiz.');
  }
  return path;
}

function readDefinition(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`Could not read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${path} is not valid JSON: ${error.message}`);
  }
}

const argv = process.argv.slice(2);
const path = definitionPath(argv);
const result = validateQuizDefinition(readDefinition(path));
if (!result.ok) {
  fail(
    `${path} is not a quiz this script will write:\n\n    - ${result.problems.join('\n    - ')}`,
  );
}
const { definition } = result;

const { dryRun: dryRunFlag, project, write } = initAdminApp(argv);
// `--dry-run` alongside `--write` is a contradiction, and the safe reading of a
// contradiction is the one that writes nothing.
const dryRun = dryRunFlag || !write;
const firestore = getFirestore();

async function main() {
  console.log(`\nProject    : ${project}`);
  console.log(`Quiz       : ${QUIZZES_COLLECTION}/${definition.id}`);
  console.log(`Title      : ${definition.title}`);
  console.log(
    `Published  : ${definition.isPublished ? 'yes' : 'no (a draft — no client can read it)'}`,
  );
  console.log(
    dryRun
      ? 'Mode       : DRY RUN — nothing will be written (add --write to write)\n'
      : 'Mode       : WRITING\n',
  );

  const quizRef = firestore.collection(QUIZZES_COLLECTION).doc(definition.id);
  const [existing, ...questions] = await firestore.getAll(
    quizRef,
    ...definition.questionIds.map((id) => firestore.collection(QUESTIONS_COLLECTION).doc(id)),
  );

  let missing = 0;
  let approved = 0;
  console.log('Questions, in the order the quiz plays them:');
  questions.forEach((question, index) => {
    const position = String(index + 1).padStart(2);
    if (!question.exists) {
      missing += 1;
      console.log(`  ${position}. ${question.id}  MISSING — no such question`);
      return;
    }
    const status = question.get('status');
    if (status === 'approved') {
      approved += 1;
      console.log(`  ${position}. ${question.id}  approved`);
    } else {
      console.log(
        `  ${position}. ${question.id}  ${JSON.stringify(status ?? null)} — skipped until a reviewer approves it`,
      );
    }
  });

  if (missing > 0) {
    fail(
      `${missing} of the quiz's questions do not exist. Fix the ids in ${path} — the app would ` +
        'skip them without saying which, so a typo here is a question nobody ever plays.',
    );
  }
  if (definition.isPublished && approved === 0) {
    fail(
      "None of the quiz's questions is approved, so a published quiz could only say it cannot " +
        'start. Approve them first, or write it as a draft ("isPublished": false).',
    );
  }

  const createdAt = existing.exists ? existing.get('createdAt') : undefined;
  const document = {
    ...definition,
    createdAt: typeof createdAt === 'number' ? createdAt : Date.now(),
  };
  // The id is the document's address, not one of its fields.
  delete document.id;

  console.log(
    `\n${existing.exists ? 'Replacing the existing quiz' : 'Creating a new quiz'} ` +
      `(${approved} of ${questions.length} questions playable now).`,
  );
  if (dryRun) {
    console.log(`\nWould write:\n${JSON.stringify(document, null, 2)}`);
    console.log('\nDry run: nothing was written.\n');
    return;
  }
  await quizRef.set(document);
  console.log(`\nWritten. It plays at /quiz/${definition.id}.\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
