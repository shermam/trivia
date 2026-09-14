/**
 * The tag normaliser (`FEAT-021`), and the bounds `firestore.rules` enforces
 * on what it produces.
 *
 * Tags are free-form: nothing validates them against a vocabulary, no document
 * holds a list of the ones that exist, and a writer may invent any tag they
 * like. What keeps "free-form" from meaning "unbounded" is this one function —
 * every tag the app stores, filters on or compares goes through it, so
 * `World War 2`, `world_war_2` and ` WORLD WAR 2 ` all become `world-war-2`
 * and the filter, the recommender and the generator are all comparing the same
 * strings.
 *
 * It is a **pure function** deliberately, and it lives in `utils/` rather than
 * on a service for the reason `shuffle.util.ts` does: the contribute form, the
 * setup screen's filter and — later — the generator's output validation all
 * need the identical answer, and a shared function is the only way two of them
 * cannot drift.
 *
 * **A client is not a place to enforce anything** (`CLAUDE.md` §4.1). This
 * function decides what the app *writes*; `firestore.rules` independently
 * enforces the *shape* it produces, because a rule cannot call it. The two
 * agree by construction — {@link isNormalizedTag} is the shape, and the rule is
 * that same shape spelled in the rules language — and both suites pin it.
 */

/**
 * How many tags one question may carry. Enough for a topic, a period, a
 * sub-domain and a few specifics; few enough that `firestore.rules` can check
 * every element by index without the per-element clauses becoming a wall.
 */
export const MAX_TAGS_PER_QUESTION = 8;

/** Shorter than this and there is no topic in it, so the normaliser drops it. */
export const MIN_TAG_LENGTH = 2;

/**
 * The length cap, and it is what stops a free-text field becoming a second
 * question body: a tag cannot carry a sentence, a URL or a script, and a bad
 * actor cannot use the field as storage.
 */
export const MAX_TAG_LENGTH = 32;

/**
 * The shape a stored tag has: lower-case alphanumeric words joined by single
 * hyphens, with no leading, trailing or doubled hyphen.
 *
 * Spelled here and again in `firestore.rules`, which cannot import it. The
 * duplication is the point at which the two could drift, so the rules tests
 * probe the same strings this file's spec does.
 */
const TAG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Combining marks left behind by an NFD decomposition. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Whitespace and underscores, which both mean "word boundary" to a writer. */
const WORD_SEPARATORS = /[\s_]+/g;

/** Everything a tag may not contain, once the separators above are hyphens. */
const DISALLOWED = /[^a-z0-9-]+/g;

/**
 * Whether a value is already exactly what this module produces — the predicate
 * `firestore.rules` mirrors.
 *
 * Exported because the **readers** need it as well as the writers. A tag array
 * read back out of Firestore was written by somebody, and `custom_questions` is
 * a public API that a console can write to directly, so a chip renderer that
 * trusted the stored value would be trusting a writer it has never met
 * (`CLAUDE.md` §4.4: be right regardless of the writer).
 */
export function isNormalizedTag(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_TAG_LENGTH &&
    value.length <= MAX_TAG_LENGTH &&
    TAG_PATTERN.test(value)
  );
}

/**
 * One writer's text as a stored tag, or `null` when there is no tag in it.
 *
 * The steps, in order: strip diacritics, lower-case, turn whitespace and
 * underscores into hyphens, drop everything outside `[a-z0-9-]`, collapse
 * repeated hyphens, trim the hyphens off both ends. Then two rejections —
 * shorter than {@link MIN_TAG_LENGTH}, or longer than {@link MAX_TAG_LENGTH}.
 *
 * **Diacritics are folded rather than dropped**, and that is the one place this
 * goes beyond "keep `[a-z0-9-]`". Dropping the character outright turns
 * `matemática` into `matemtica` — a tag nobody will ever type a second time,
 * which is the precise failure a normaliser exists to prevent. Folding it turns
 * it into `matematica`, which the next contributor writing `matematica` will
 * match. The stored shape is identical either way; only the coherence differs.
 *
 * **Too long is `null` rather than truncated.** A truncated tag is a different
 * tag, silently — and the caller can tell the two rejections apart by measuring
 * the input, which is what the selector does to say *why* a chip was refused
 * instead of just refusing it.
 */
export function normalizeTag(input: string): string | null {
  const normalized = input
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(WORD_SEPARATORS, '-')
    .replace(DISALLOWED, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return isNormalizedTag(normalized) ? normalized : null;
}

/**
 * A whole list of writer input as the tags a question stores: normalised,
 * blanks dropped, duplicates collapsed, and cut to {@link MAX_TAGS_PER_QUESTION}.
 *
 * Order is the writer's, first occurrence wins. `firestore.rules` refuses a
 * duplicate outright (`toSet().size() == size()`), so collapsing here is what
 * keeps two entries that normalise to the same tag from becoming a
 * `permission-denied` the contributor cannot act on — the same reason the
 * answer fields check for a duplicate before submitting.
 */
export function normalizeTags(inputs: readonly string[]): string[] {
  const tags: string[] = [];
  for (const input of inputs) {
    const tag = normalizeTag(input);
    if (tag && !tags.includes(tag) && tags.length < MAX_TAGS_PER_QUESTION) {
      tags.push(tag);
    }
  }
  return tags;
}

/**
 * The tags of a document read back from Firestore, or `undefined` when it has
 * none worth rendering.
 *
 * Everything unusable is dropped rather than rendered: a non-array, a
 * non-string element, a tag that does not match the shape the rules enforce,
 * a duplicate, and anything past the eighth. All of those are refused by
 * `firestore.rules` on any write the app can make — and all of them are
 * writable from the Firebase console, which the rules do not govern.
 *
 * `undefined` rather than `[]` so a caller can render nothing at all with
 * `@if`, the way `SourceLinkComponent` and `QuestionJustificationComponent`
 * already do for their own optional fields.
 */
export function readTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags = [...new Set(value.filter(isNormalizedTag))].slice(0, MAX_TAGS_PER_QUESTION);
  return tags.length > 0 ? tags : undefined;
}
