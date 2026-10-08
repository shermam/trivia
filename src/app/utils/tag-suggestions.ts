import { SEED_TAGS } from './category-tags';

/**
 * The starter tags offered on the contribute form after the seed tags
 * (`FEAT-021`, `FEAT-052`).
 *
 * **A hint, never a gate.** Nothing validates against this list: a tag outside
 * it is perfectly valid, `firestore.rules` has never heard of it, and a
 * contributor may ignore the picker entirely. What it buys is coherence —
 * somebody who sees `world-war-2` in the picker does not type `ww2` — and it
 * buys it for the cost of a constant in the bundle.
 *
 * **The two alternatives both cost more than they are worth.** Reading the bank
 * to discover which tags exist is a query over a public collection billed per
 * document, which `CLAUDE.md` §4.1 rules out; maintaining a `usageCount` per
 * tag is a Cloud Function, a volume cap and an idempotency problem for a number
 * whose only job is ordering an autocomplete list.
 *
 * **Exported for the generator** (`FEAT-020`), which will be given this list
 * in its prompt beside the seed tags and told to prefer an existing tag over
 * inventing one — which is where the great majority of tags will come from once
 * the pipeline runs. That is why it is a plain constant in `utils/` rather than
 * something private to the selector component.
 *
 * Every entry is already normalised, so the picker never surprises anybody with
 * a chip that differs from the label they clicked. `normalize-tag.util.spec.ts`
 * asserts exactly that — beside the normaliser, so the two cannot be checked
 * against different rules — which is what keeps a hand-edited entry from
 * becoming a suggestion that cannot be selected.
 *
 * Grouped under the subjects Open Trivia DB's categories cover, because those
 * are now the seed tags (`category-tags.ts`) and therefore what a contributor
 * is most likely to be writing for: the starters are the finer topics beneath
 * them. Five of them — `mythology`, `film`, `television`, `video-games` and
 * `board-games` — are seed tags in their own right, which is why the contribute
 * form's list is deduplicated rather than concatenated.
 */
export const TAG_SUGGESTIONS: readonly string[] = [
  // History
  'ancient-history',
  'world-war-1',
  'world-war-2',
  'cold-war',
  'roman-empire',
  // Geography
  'capitals',
  'flags',
  'rivers',
  'mountains',
  'oceans',
  // Science & Nature
  'astronomy',
  'biology',
  'chemistry',
  'physics',
  'anatomy',
  'periodic-table',
  'weather',
  // Mathematics
  'algebra',
  'geometry',
  'calculus',
  'statistics',
  'probability',
  // Computers
  'programming',
  'algorithms',
  'networking',
  'databases',
  'cybersecurity',
  'artificial-intelligence',
  // Arts & Literature
  'painting',
  'architecture',
  'poetry',
  'mythology',
  'philosophy',
  // Entertainment
  'film',
  'television',
  'music-theory',
  'video-games',
  'board-games',
  // Sport
  'football',
  'olympics',
  'motorsport',
  // Everyday
  'food-and-drink',
  'languages',
];

/**
 * What the contribute form and `/my-questions`' edit dialog offer: the seed
 * tags first, then the starters above, each once (`FEAT-052` §0).
 *
 * **Seed tags lead because they are the ones a player can ask for by name.**
 * A contribution tagged `history` is one tap away for every player who picks
 * that topic on the setup screen — whose suggestions are the seed tags and
 * nothing else — and it narrows both halves of a Mixed game, where a finer
 * starter narrows only the community half.
 */
export const QUESTION_TAG_SUGGESTIONS: readonly string[] = [
  ...new Set([...SEED_TAGS, ...TAG_SUGGESTIONS]),
];
