import { normalizeTag, readTags } from './normalize-tag.util';

/**
 * Open Trivia DB's categories as the app's seed tags, and the one derivation
 * every reader of a question's topic goes through (`FEAT-052`).
 *
 * **The tag is the only topic the app has.** Each of Open Trivia DB's
 * twenty-four categories became one normalised tag, held in the table below:
 * the setup screen offers them as its suggestions, the Open Trivia adapter
 * stamps a fetched question with its one, and the request runs the table the
 * other way to turn a chosen tag back into the API's numeric `category`. The
 * table is first-party — nothing fetches `api_category.php` any more — so the
 * vocabulary cannot change under the app, and retiring Open Trivia DB would
 * not take it away.
 *
 * **A question that stores no tags is read as carrying the tag derived from
 * its category.** Every question written before topics replaced categories has
 * a `category` and no `tags`, and so does every Open Trivia question sitting in
 * an offline pool filled before this change. {@link topicTagsOf} is the one
 * function that answers "what is this question about" for every reader — the
 * quiz card's pill, the recap, the reviewer's card, `/my-questions`, and the
 * offline pool's narrowing — so they cannot disagree, and tags win whenever a
 * question has both.
 *
 * **What the derivation cannot do is serve the draw.** The community draw
 * filters on `tags` in the query, and a document with no `tags` array matches
 * no `array-contains-any` clause whatever a reader would derive for it — which
 * is why `scripts/backfill-category-tags.mjs` writes the derived tag onto every
 * stored question, through this same function (`docs/data-model.md`).
 *
 * Pure and dependency-free apart from the normaliser, like
 * `normalize-tag.util.ts` beside it — the backfill script imports this file
 * directly, so it must stay something Node can load without Angular.
 */

/** One Open Trivia DB category, and the seed tag it became. */
export interface SeedCategory {
  /** Open Trivia DB's id — what `api.php`'s `category` parameter takes. */
  readonly id: number;
  /**
   * The name as Open Trivia DB spells it, **entity-decoded**: the API encodes
   * `&` as `&amp;` in a question's `category`, and `decodeOpenTriviaText`
   * decodes it before anything compares a name against this column.
   */
  readonly name: string;
  /** {@link seedTagRule} applied to `name` — `category-tags.spec.ts` pins every row. */
  readonly tag: string;
}

/**
 * Open Trivia DB's twenty-four categories, ids 9 to 32.
 *
 * Taken from the `FEAT-052` spec's table rather than from `api_category.php`,
 * which was not reachable from where this was written — the endpoint is the
 * thing to check against when one of these is in doubt. The tag column is not
 * free text either way: it is the rule below applied to the name, and the spec
 * fails on any row that drifts from it.
 *
 * **Exported for the generator** (`FEAT-020`), beside `FEAT-021`'s starter
 * list: a generation run for a former category is a run handed that category's
 * seed tag.
 */
// i18n-exempt: Open Trivia DB's own category names — data its API is matched against, never shown
export const OPEN_TRIVIA_CATEGORIES: readonly SeedCategory[] = [
  { id: 9, name: 'General Knowledge', tag: 'general-knowledge' },
  { id: 10, name: 'Entertainment: Books', tag: 'books' },
  { id: 11, name: 'Entertainment: Film', tag: 'film' },
  { id: 12, name: 'Entertainment: Music', tag: 'music' },
  { id: 13, name: 'Entertainment: Musicals & Theatres', tag: 'musicals-theatres' },
  { id: 14, name: 'Entertainment: Television', tag: 'television' },
  { id: 15, name: 'Entertainment: Video Games', tag: 'video-games' },
  { id: 16, name: 'Entertainment: Board Games', tag: 'board-games' },
  { id: 17, name: 'Science & Nature', tag: 'science-nature' },
  { id: 18, name: 'Science: Computers', tag: 'computers' },
  { id: 19, name: 'Science: Mathematics', tag: 'mathematics' },
  { id: 20, name: 'Mythology', tag: 'mythology' },
  { id: 21, name: 'Sports', tag: 'sports' },
  { id: 22, name: 'Geography', tag: 'geography' },
  { id: 23, name: 'History', tag: 'history' },
  { id: 24, name: 'Politics', tag: 'politics' },
  { id: 25, name: 'Art', tag: 'art' },
  { id: 26, name: 'Celebrities', tag: 'celebrities' },
  { id: 27, name: 'Animals', tag: 'animals' },
  { id: 28, name: 'Vehicles', tag: 'vehicles' },
  { id: 29, name: 'Entertainment: Comics', tag: 'comics' },
  { id: 30, name: 'Science: Gadgets', tag: 'gadgets' },
  { id: 31, name: 'Entertainment: Japanese Anime & Manga', tag: 'japanese-anime-manga' },
  { id: 32, name: 'Entertainment: Cartoon & Animations', tag: 'cartoon-animations' },
];

/**
 * The seed tags, in Open Trivia DB's own id order — the only tags that narrow
 * both sources, which is why they are what the setup screen suggests.
 */
export const SEED_TAGS: readonly string[] = OPEN_TRIVIA_CATEGORIES.map((row) => row.tag);

const BY_NAME = new Map(OPEN_TRIVIA_CATEGORIES.map((row) => [row.name, row]));
const BY_TAG = new Map(OPEN_TRIVIA_CATEGORIES.map((row) => [row.tag, row]));

/**
 * The family prefix two of Open Trivia DB's groups carry — `Entertainment: Film`,
 * `Science: Computers`. Dropped before normalising, or every entertainment
 * topic would be a twenty-character tag beginning `entertainment-`, which
 * nobody types. `Science & Nature` has no colon and keeps its whole name.
 *
 * Case-insensitive and tolerant of spacing around the colon, because the rule
 * also runs over the free-text categories contributors typed — where
 * `science: physics` is the same intention as `Science: Physics`.
 */
const FAMILY_PREFIX = /^\s*(?:entertainment|science)\s*:\s*/i;

/**
 * The table's rule, applicable to any string: drop the family prefix, then
 * {@link normalizeTag}. `null` when nothing usable is left.
 *
 * It is how every row's tag column was produced, and it is what turns a
 * category nobody put in the table — the contribute form took free text, so a
 * stored category can be anything (`Science` is the one its own tests
 * submitted) — into the tag a contributor typing the same word would get.
 */
export function seedTagRule(name: string): string | null {
  return normalizeTag(name.replace(FAMILY_PREFIX, ''));
}

/**
 * The seed tag for one of Open Trivia DB's category names, or `null` for a
 * name the table does not hold.
 *
 * **Table only, deliberately.** This is what the Open Trivia adapter stamps a
 * fetched question with, and a category Open Trivia DB adds tomorrow is not a
 * seed tag the setup screen offers or the request can turn back into an id —
 * so it yields no tag there, and the question is still served.
 */
export function seedTagForCategoryName(name: string): string | null {
  return BY_NAME.get(name)?.tag ?? null;
}

/**
 * The tag a stored category derives: the table's tag for one of Open Trivia
 * DB's names, and the table's rule for any other string. `null` for a value
 * that is not a string, or that normalises to nothing.
 *
 * The two branches agree by construction — every row's tag is the rule applied
 * to its name, pinned row by row — so the lookup is the table speaking for its
 * own names rather than a second opinion.
 */
export function categoryTag(category: unknown): string | null {
  if (typeof category !== 'string') {
    return null;
  }
  return BY_NAME.get(category)?.tag ?? seedTagRule(category);
}

/** Whether a tag is one of the twenty-four the table holds. */
export function isSeedTag(tag: string): boolean {
  return BY_TAG.has(tag);
}

/**
 * The table run the other way: Open Trivia DB's category id for a seed tag, or
 * `undefined` for any other tag — which the request then omits, rather than
 * guessing.
 */
export function openTriviaCategoryId(tag: string): number | undefined {
  return BY_TAG.get(tag)?.id;
}

/**
 * The first seed tag in a selection, or `null` when it holds none.
 *
 * What an Open Trivia draw follows (`FEAT-052` §0): the API takes one
 * `category` per request and refuses a second request inside five seconds, so
 * a game asks it for one topic at most — the first one it can honour.
 */
export function firstSeedTag(tags: readonly string[]): string | null {
  return tags.find(isSeedTag) ?? null;
}

/** The two fields of a question the derivation reads. Loose on purpose — see {@link topicTagsOf}. */
export interface TopicSource {
  readonly tags?: unknown;
  readonly category?: unknown;
}

/**
 * What a question is about: its own tags when it stores any, otherwise the one
 * tag its category derives, otherwise nothing.
 *
 * **Tags win.** A question carrying both was tagged by somebody who chose the
 * tags; the category is the older, coarser statement of the same thing.
 *
 * **Both fields are read as `unknown`**, because the callers hand over
 * documents a console can write anything into — `readTags` re-checks the
 * stored list (`CLAUDE.md` §4.4: the reader has to be right regardless of the
 * writer), and a category that is not a string derives nothing.
 */
export function topicTagsOf(question: TopicSource): string[] {
  const tags = readTags(question.tags);
  if (tags) {
    return tags;
  }
  const derived = categoryTag(question.category);
  return derived ? [derived] : [];
}

/** The question's first topic — what the quiz card's pill and the recap's label show — or `null`. */
export function firstTopicTag(question: TopicSource): string | null {
  return topicTagsOf(question)[0] ?? null;
}
