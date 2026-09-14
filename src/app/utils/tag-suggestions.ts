/**
 * The starter tags offered on the contribute form and the setup screen's
 * filter (`FEAT-021`).
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
 * **Exported for the generator** (`FEAT-020`), which will be given this same
 * list in its prompt and told to prefer an existing tag over inventing one —
 * which is where the great majority of tags will come from once the pipeline
 * runs. That is why it is a plain constant in `utils/` rather than something
 * private to the selector component.
 *
 * Every entry is already normalised, so the picker never surprises anybody with
 * a chip that differs from the label they clicked. `normalize-tag.util.spec.ts`
 * asserts exactly that — beside the normaliser, so the two cannot be checked
 * against different rules — which is what keeps a hand-edited entry from
 * becoming a suggestion that cannot be selected.
 *
 * The categories are the ones Open Trivia DB's category list actually offers,
 * since those are what the setup screen's picker shows and therefore what a
 * contributor is most likely to be writing for.
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
