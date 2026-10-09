import { type TimeLimitOption, isTimeLimitOption } from '../models/question.model';
import {
  type Quiz,
  QUIZ_DESCRIPTION_MAX_LENGTH,
  QUIZ_MAX_QUESTIONS,
  QUIZ_MAX_TAGS,
  QUIZ_MIN_QUESTIONS,
  QUIZ_TITLE_MAX_LENGTH,
} from '../models/quiz.model';
import { isNormalizedTag, readTags } from './normalize-tag.util';

/**
 * The shape of a curated quiz (`FEAT-024`), checked in the two places a quiz
 * meets code: the seed script that writes one, and the app that reads one.
 *
 * **There is no client write rule, so the script is the only validator.**
 * `firestore.rules` refuses every client write to `quizzes`, which is what
 * leaves the collection with no exact-key allowlist and no field bounds of its
 * own — there is nothing for a rule to guard. A quiz is written from the
 * console or by `scripts/seed-quiz.mjs`, and the script imports
 * {@link validateQuizDefinition} from here through Node's type stripping, so
 * the bounds live in one file and `quiz-definition.util.spec.ts` pins every one
 * of them at both edges.
 *
 * **The app reads more leniently than the script writes, on purpose.** A quiz
 * typed into the console never meets the validator, and the reader has to be
 * right regardless of the writer (`CLAUDE.md` §4.4): {@link readQuiz} drops
 * what it cannot use rather than taking the quiz offline over a field it does
 * not need, and refuses only a quiz with no title to show.
 */

/** A quiz as a definition file describes it: everything but `createdAt`, which the writer stamps. */
export type QuizDefinition = Omit<Quiz, 'createdAt'>;

export type QuizDefinitionResult =
  { ok: true; definition: QuizDefinition } | { ok: false; problems: string[] };

/** The keys a definition may carry — anything else is a typo, and is named as one. */
const DEFINITION_KEYS: readonly string[] = [
  'id',
  'title',
  'description',
  'questionIds',
  'createdBy',
  'isPublished',
  'tags',
  'language',
  'sponsorId',
  'suggestedTimeLimit',
];

/**
 * A quiz id the seed script will write: lower-case kebab-case, 3–64 characters.
 *
 * A slug rather than an auto-id because the id **is** the address —
 * `/quiz/world-cup-1998` — and because the script is re-run to update a quiz,
 * which needs a name the operator can type again. The app itself accepts any
 * id that can name a document ({@link isQuizDocumentId}), so a quiz typed into
 * the console under an auto-id plays too.
 */
export const QUIZ_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const QUIZ_SLUG_MIN_LENGTH = 3;
const QUIZ_SLUG_MAX_LENGTH = 64;

/** The longest `createdBy` or `sponsorId` the script writes — a uid is 28. */
const REFERENCE_MAX_LENGTH = 128;

/**
 * A BCP-47 tag's shape — a two- or three-letter language and optional subtags,
 * `pt`, `pt-BR`, `es-419`. A shape check rather than a registry lookup:
 * `FEAT-030` owns what the field means, and this only keeps a value it could
 * never parse out of the document.
 */
const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const LANGUAGE_TAG_MAX_LENGTH = 35;

/**
 * Whether a value can name one document: a string of 1–128 characters with no
 * `/`, and neither `.`, `..` nor a reserved `__…__` id.
 *
 * Stricter than the REST client's own `isDocumentId`, which only refuses the
 * slash, because these ids reach a `__name__` filter and an id Firestore
 * refuses there fails the **whole** query — one malformed entry in a quiz would
 * take every question down with it. `recordGameResult` makes the same check
 * for the same reason.
 */
export function isDocumentReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= REFERENCE_MAX_LENGTH &&
    !value.includes('/') &&
    value !== '.' &&
    value !== '..' &&
    !/^__.*__$/.test(value)
  );
}

/** Whether a `/quiz/:quizId` segment can name a quiz at all, before anything is read. */
export const isQuizDocumentId = isDocumentReference;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks a quiz definition — the JSON file `scripts/seed-quiz.mjs` is handed —
 * against every bound a quiz is written within, and reports **all** the
 * problems at once rather than the first, so a file is fixed in one pass.
 *
 * What passes is returned cleaned: the title, description and `createdBy`
 * trimmed, and an absent description written as the empty string the schema
 * stores. Nothing is coerced — a number where a string belongs is a problem,
 * not a value to stringify.
 */
export function validateQuizDefinition(input: unknown): QuizDefinitionResult {
  if (!isPlainObject(input)) {
    return { ok: false, problems: ['The definition must be a JSON object.'] };
  }
  const problems: string[] = [];

  for (const key of Object.keys(input)) {
    if (key === 'createdAt') {
      problems.push('createdAt is stamped by the script when it writes the quiz; remove it.');
    } else if (!DEFINITION_KEYS.includes(key)) {
      problems.push(`Unknown field "${key}". A quiz carries ${DEFINITION_KEYS.join(', ')}.`);
    }
  }

  const id = input['id'];
  if (
    typeof id !== 'string' ||
    id.length < QUIZ_SLUG_MIN_LENGTH ||
    id.length > QUIZ_SLUG_MAX_LENGTH ||
    !QUIZ_SLUG_PATTERN.test(id)
  ) {
    problems.push(
      `id must be lower-case kebab-case, ${QUIZ_SLUG_MIN_LENGTH}–${QUIZ_SLUG_MAX_LENGTH} ` +
        'characters (it is the /quiz/<id> address).',
    );
  }

  const title = typeof input['title'] === 'string' ? input['title'].trim() : null;
  if (title === null || title.length === 0 || title.length > QUIZ_TITLE_MAX_LENGTH) {
    problems.push(`title must be a string of 1–${QUIZ_TITLE_MAX_LENGTH} characters.`);
  }

  const rawDescription = input['description'];
  const description =
    rawDescription === undefined
      ? ''
      : typeof rawDescription === 'string'
        ? rawDescription.trim()
        : null;
  if (description === null || description.length > QUIZ_DESCRIPTION_MAX_LENGTH) {
    problems.push(
      `description, when present, must be a string of at most ${QUIZ_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }

  const questionIds = input['questionIds'];
  if (
    !Array.isArray(questionIds) ||
    questionIds.length < QUIZ_MIN_QUESTIONS ||
    questionIds.length > QUIZ_MAX_QUESTIONS
  ) {
    problems.push(
      `questionIds must be a list of ${QUIZ_MIN_QUESTIONS}–${QUIZ_MAX_QUESTIONS} question ids.`,
    );
  } else {
    questionIds.forEach((questionId, index) => {
      if (!isDocumentReference(questionId)) {
        problems.push(
          `questionIds[${index}] is not a usable document id: ${JSON.stringify(questionId)}.`,
        );
      }
    });
    if (new Set(questionIds).size !== questionIds.length) {
      problems.push('questionIds must not name the same question twice.');
    }
  }

  const createdBy = typeof input['createdBy'] === 'string' ? input['createdBy'].trim() : null;
  if (createdBy === null || createdBy.length === 0 || createdBy.length > REFERENCE_MAX_LENGTH) {
    problems.push(
      `createdBy must name the curator, as a string of 1–${REFERENCE_MAX_LENGTH} characters.`,
    );
  }

  const isPublished = input['isPublished'];
  if (typeof isPublished !== 'boolean') {
    problems.push('isPublished must be true or false — say which, rather than leave it out.');
  }

  const tags = input['tags'];
  if (
    tags !== undefined &&
    (!Array.isArray(tags) ||
      tags.length > QUIZ_MAX_TAGS ||
      !tags.every(isNormalizedTag) ||
      new Set(tags).size !== tags.length)
  ) {
    problems.push(
      `tags, when present, must be at most ${QUIZ_MAX_TAGS} distinct normalised tags ` +
        '(lower-case kebab-case, 2–32 characters).',
    );
  }

  const language = input['language'];
  if (
    language !== undefined &&
    (typeof language !== 'string' ||
      language.length > LANGUAGE_TAG_MAX_LENGTH ||
      !LANGUAGE_TAG_PATTERN.test(language))
  ) {
    problems.push('language, when present, must be a BCP-47 tag such as "en" or "pt-BR".');
  }

  const sponsorId = input['sponsorId'];
  if (
    sponsorId !== undefined &&
    sponsorId !== null &&
    (typeof sponsorId !== 'string' ||
      sponsorId.length === 0 ||
      sponsorId.length > REFERENCE_MAX_LENGTH)
  ) {
    problems.push(
      `sponsorId, when present, must be null or a string of 1–${REFERENCE_MAX_LENGTH} characters.`,
    );
  }

  const suggestedTimeLimit = input['suggestedTimeLimit'];
  if (
    suggestedTimeLimit !== undefined &&
    suggestedTimeLimit !== null &&
    !isTimeLimitOption(suggestedTimeLimit)
  ) {
    problems.push('suggestedTimeLimit, when present, must be 15, 30, "unlimited" or null.');
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    definition: {
      id: id as string,
      title: title as string,
      description: description as string,
      questionIds: [...(questionIds as string[])],
      createdBy: createdBy as string,
      isPublished: isPublished as boolean,
      ...(tags === undefined ? {} : { tags: [...(tags as string[])] }),
      ...(language === undefined ? {} : { language: language as string }),
      ...(sponsorId === undefined ? {} : { sponsorId: sponsorId as string | null }),
      ...(suggestedTimeLimit === undefined
        ? {}
        : { suggestedTimeLimit: suggestedTimeLimit as TimeLimitOption | null }),
    },
  };
}

/**
 * A stored quiz as the app uses it, or `null` when it has no title to show.
 *
 * Everything else that cannot be used is **dropped rather than refused**: a
 * question id that cannot name a document, a duplicate, anything past the
 * twenty-fifth — the bound one `IN` query resolves — a description that is not
 * a string, a tag of the wrong shape, a time limit that is not an option. Each
 * of those is unreachable through the seed script and reachable through the
 * console, and none of them is a reason to take a quiz offline; the quiz page
 * says how many of its questions it can actually play.
 *
 * `isPublished` is read rather than assumed, although `firestore.rules`
 * serves nothing else: the rule is one deploy from being widened, and a reader
 * that trusted it would start showing drafts the day it was.
 */
export function readQuiz(id: string, data: Record<string, unknown>): Quiz | null {
  const title = typeof data['title'] === 'string' ? data['title'].trim() : '';
  if (title.length === 0) {
    return null;
  }

  const ids = Array.isArray(data['questionIds']) ? data['questionIds'] : [];
  const questionIds = [...new Set(ids.filter(isDocumentReference))].slice(0, QUIZ_MAX_QUESTIONS);

  const createdAt = data['createdAt'];
  const tags = readTags(data['tags']);
  const language = data['language'];
  const sponsorId = data['sponsorId'];
  const suggestedTimeLimit = data['suggestedTimeLimit'];

  return {
    id,
    title,
    description: typeof data['description'] === 'string' ? data['description'].trim() : '',
    questionIds,
    createdBy: typeof data['createdBy'] === 'string' ? data['createdBy'] : '',
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
    isPublished: data['isPublished'] === true,
    ...(tags ? { tags } : {}),
    ...(typeof language === 'string' && LANGUAGE_TAG_PATTERN.test(language) ? { language } : {}),
    ...(sponsorId === null || typeof sponsorId === 'string' ? { sponsorId } : {}),
    ...(suggestedTimeLimit === null || isTimeLimitOption(suggestedTimeLimit)
      ? { suggestedTimeLimit }
      : {}),
  };
}
