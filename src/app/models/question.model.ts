export type QuestionType = 'multiple' | 'boolean';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type QuestionSource = 'open_trivia' | 'custom' | 'mixed';

/**
 * How a question's text is meant to be read (`FEAT-019`).
 *
 * **Two values, and the absent one is the interesting part.** It is tempting to
 * add a third for Open Trivia DB's entity-encoded text, so that one field
 * describes every kind of text the app renders. It would be wrong: no Open
 * Trivia question is ever stored. `TriviaService` maps them at fetch time and
 * the decoder runs in that adapter, which is where `CLAUDE.md` §4.4 wants a
 * per-source transformation. A stored field cannot describe a source with no
 * stored documents, and reaching for one would move the decode away from the
 * adapter for nothing.
 *
 * An **absent** field means `'plain'`, everywhere and permanently. That is what
 * makes the field free to add: nothing has to be backfilled, because nothing
 * dereferences it.
 */
export type QuestionFormat = 'plain' | 'markdown';

/**
 * One option as presented to the player.
 *
 * Answers used to be plain strings, and the whole option list was a
 * `string[]`. That made the *text* the identity, which broke in two places at
 * once when a question carried the same text twice: `@for`'s `track` saw
 * duplicate keys, and — because scoring compared the clicked string against
 * `correct_answer` — clicking the **wrong** option scored as correct. Both
 * follow from asking a display value to also be an identifier and a truth
 * flag.
 *
 * So each answer now carries its own `id`, unique within the question and
 * derived from its position in the source data rather than its text, and
 * states `isCorrect` outright instead of leaving it to be re-derived by string
 * comparison at three separate call sites.
 */
export interface Answer {
  id: string;
  text: string;
  isCorrect: boolean;
}

/**
 * What the player did on one question — answered it, let the clock run out, or
 * skipped it with the Skip lifeline (`FEAT-002`).
 *
 * **The id, not the text.** Two options can carry the same string, and matching
 * on display text once let a wrong answer score as correct (`CLAUDE.md` §4.4),
 * so identity is the id here as everywhere else. Correctness is still derived
 * rather than stored — `all_answers.find(a => a.id === id).isCorrect` — because
 * two fields that can disagree are worse than one in a record that goes to disk
 * and comes back.
 *
 * **A discriminated union rather than the `string | null` this started as.**
 * That scalar had exactly one spare value, `null`, and it was already spent on
 * "timed out". Skip is a third outcome and the only room left was a magic
 * string — which TypeScript widens straight back to `string`, giving a runtime
 * case the compiler can never make anyone handle. That is the shape §4.4 calls
 * "a runtime type that only one consumer checks is a type nobody checks". Three
 * outcomes, three variants, and `switch` exhaustiveness does the enforcing.
 *
 * The persisted shape changes with it. No `SCHEMA_VERSION` bump, same call as
 * every additive field before it: a save written by the previous build fails
 * validation, so its history is dropped and the *game* survives with no recap —
 * see `isUsableAnswerHistory`. Bumping would discard the game itself.
 */
export type PickedAnswer =
  | { readonly kind: 'answered'; readonly id: string }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'skipped' };

export const TIMED_OUT: PickedAnswer = { kind: 'timedOut' };
export const SKIPPED: PickedAnswer = { kind: 'skipped' };

export function answeredWith(id: string): PickedAnswer {
  return { kind: 'answered', id };
}

/**
 * The three single-use lifelines (`FEAT-002`). Availability lives on
 * `GameControllerService` and rides the persisted snapshot, so a reload does
 * not refund one.
 */
export type LifelineId = 'fiftyFifty' | 'extraTime' | 'skip';

export const LIFELINE_IDS: readonly LifelineId[] = ['fiftyFifty', 'extraTime', 'skip'];

/** `true` means still available. */
export type LifelineState = Readonly<Record<LifelineId, boolean>>;

export const ALL_LIFELINES_AVAILABLE: LifelineState = {
  fiftyFifty: true,
  extraTime: true,
  skip: true,
};

export interface TriviaQuestion {
  id: string;
  /**
   * The category the question was written under, where it has one
   * (`FEAT-052`). Open Trivia DB names one on every question; a contribution
   * written since topics replaced categories carries none.
   *
   * **Nothing displays or filters on it directly.** A reader that wants to
   * know what a question is about asks `topicTagsOf()` (`category-tags.ts`),
   * which reads `tags` and falls back to the tag this derives — so a question
   * cached or stored before the change still shows a topic.
   */
  category?: string;
  type: QuestionType;
  difficulty: Difficulty;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
  all_answers: Answer[];
  source: 'open_trivia' | 'custom';
  /**
   * Where a contributed question says its answer comes from (`FEAT-022`).
   *
   * Optional, and absent on the overwhelming majority of questions: Open Trivia
   * DB exposes no citation, and it is the default source. That is why the UI
   * shows a link where one exists and **nothing** where one does not — a badge
   * would read as "the others are unverified", which is a claim about the
   * upstream API rather than about the question.
   */
  sourceUrl?: string;
  /** A human label for `sourceUrl`, or a citation with no link at all. */
  sourceTitle?: string;
  /**
   * The contributor's own justification for the question, its correct answer
   * and its distractors — for the "tricky" question where none of that is
   * obvious even to somebody who knows the subject.
   *
   * Named for `FEAT-006`, which owns this field's later life: a reviewer will
   * be able to edit it at review time. The form labels it **Justification**,
   * which is what a contributor is being asked for; the field keeps the name
   * the two features share so the second one does not have to introduce a
   * near-duplicate.
   */
  explanation?: string;
  /**
   * How `question`, `correct_answer`, the answer texts and `explanation` are
   * meant to be read (`FEAT-019`). Absent on every Open Trivia question by
   * construction and on every contribution written before the toggle existed,
   * and absent means plain.
   */
  format?: QuestionFormat;
  /**
   * Normalised topic tags (`FEAT-021`).
   *
   * A bank question carries what its contributor chose. An Open Trivia DB
   * question carries its category's **seed tag**, stamped in memory by the
   * adapter from the table in `category-tags.ts` (`FEAT-052`) — the API has no
   * such field, so this is a property of the fetch, like the entity decoding
   * beside it, and a category the table does not know yields none. Absent on a
   * question that predates topics; readers go through `topicTagsOf()`, which
   * derives one from `category` then.
   *
   * Rendered as plain-text chips and **never** through the Markdown renderer: a
   * tag is a key the filter compares, not prose.
   */
  tags?: string[];
  /**
   * How many times this question has been answered in a banked game, and how
   * many of those answers were right (`FEAT-023`) — the two counters
   * `recordGameResult` keeps on a `custom_questions` document, carried exactly
   * as the draw found them. `difficultyScore()` derives the question's
   * calibrated difficulty from them; nothing else reads them.
   *
   * **A snapshot, not a live value**, and that is the point rather than a
   * compromise: the recap shows the difficulty the question had when the
   * player was dealt it, from the document the game already read, with no
   * second read per question (`CLAUDE.md` §4.1). Absent on every Open Trivia
   * question — there is no document to count against — and on any community
   * question nobody has yet finished a signed-in game with, which scores
   * exactly its label.
   */
  answered?: number;
  correct?: number;
  /**
   * Present only on a community question the generation pipeline wrote
   * (`FEAT-020`), and then only the one fact a reader needs from the stored
   * map: that a machine wrote it, which the recap's source line says
   * ("Machine-generated from …"). The model, the run and the rest of the
   * stored `provenance` stay on the document — carried here they would be
   * copied into the saved game and the offline pool for nothing to read.
   */
  provenance?: Pick<QuestionProvenance, 'source'>;
}

/**
 * How long the player gets per question, and therefore which leaderboard the
 * game's score belongs on (finding G7).
 *
 * A fixed 15-second limit with no way to adjust, extend or turn it off is a
 * WCAG 2.2.1 failure — `'unlimited'` is what actually satisfies it; the 30
 * option exists because "a bit longer" is a far more common need than "no
 * clock at all", and the standard is met either way.
 *
 * The numeric members are seconds, so `String(option)` is the board key
 * (`'15'`, `'30'`, `'unlimited'`) that `firestore.rules` validates and that
 * appears in the `leaderboards/{limit}/entries` path. One representation, no
 * mapping table to fall out of sync.
 */
export type TimeLimitOption = 15 | 30 | 'unlimited';

export const TIME_LIMIT_OPTIONS: readonly TimeLimitOption[] = [15, 30, 'unlimited'];

/** The default, and what every game played before this feature used. */
export const DEFAULT_TIME_LIMIT: TimeLimitOption = 15;

/** The `{limit}` path segment / `timeLimit` field for a board. */
export function boardKey(option: TimeLimitOption): string {
  return String(option);
}

export function isTimeLimitOption(value: unknown): value is TimeLimitOption {
  return TIME_LIMIT_OPTIONS.includes(value as TimeLimitOption);
}

export interface GameConfig {
  amount: number;
  difficulty: Difficulty | '';
  source: QuestionSource;
  timeLimit: TimeLimitOption;
  /**
   * The topics the game was drawn under (`FEAT-021`, `FEAT-052`) — the only
   * topic choice there is, since the category picker went. Empty or absent
   * means any topic: no tag clause in the community query and no `category` in
   * the Open Trivia request.
   *
   * **It records what applied and nothing else.** An `open_trivia` game holds
   * at most one seed tag, because that API takes one category per request; a
   * `mixed` game holds up to ten tags, its Open Trivia half following the
   * first seed tag among them; a `custom` game up to ten of any kind. A tag the
   * draw did not use is not here, so a resumed game never claims a filter it
   * was not drawn under.
   *
   * There is no `category` any more. A save written before topics replaced it
   * still carries one, which `parseSavedGame` accepts and drops.
   */
  tags?: string[];
}

export interface LeaderboardEntry {
  id?: string;
  /** Firebase Auth uid — also the Firestore document ID (one entry per user *per board*, best score kept). */
  uid: string;
  name: string;
  /**
   * The point total, streak multipliers included (`FEAT-004`) — **not** the
   * number of correct answers, which it can exceed by up to
   * `MAX_SCORE_MULTIPLIER`. What ranks the board, and what `firestore.rules`
   * bounds against `totalQuestions`.
   */
  score: number;
  totalQuestions: number;
  /**
   * Raw accuracy, correct answers over questions asked, and never multiplied —
   * so it cannot be derived from `score`, and the rules bound it at 100 rather
   * than deriving it. The number a player compares against themselves, where
   * `score` is the one they compare against everybody else.
   */
  percentage: number;
  createdAt: number;
  /**
   * The board this entry belongs to — `'15'`, `'30'` or `'unlimited'`.
   * Redundant with the document's path and stored anyway: the rules' exact-key
   * allowlist cannot be widened later without rejecting every existing
   * document, so a field that might be wanted has to be there from the start.
   * `firestore.rules` requires it to equal the path segment.
   */
  timeLimit: string;
}

/**
 * A leaderboard entry published under a country as well as a time limit
 * (`FEAT-028`) — `leaderboards/{timeLimit}/regions/{region}/entries/{uid}`.
 *
 * A separate type rather than an optional field on `LeaderboardEntry`, because
 * the two are separate documents under separate rules: the global entry's
 * exact-key allowlist has no `region` in it and refuses one, and the regional
 * entry's requires it. A single optional field would compile everywhere and be
 * refused at exactly one of the two paths.
 *
 * The value is the player's own declaration from the picker, never an
 * inference — see `RegionService`.
 */
export interface RegionalLeaderboardEntry extends LeaderboardEntry {
  /** ISO 3166-1 alpha-2, and equal to the `{region}` path segment. */
  region: string;
}

/**
 * Where a submitted question sits in moderation (`BACKLOG.md` item 4).
 *
 * Only `'approved'` is reachable today — `firestore.rules`' `statusOnSubmission()`
 * accepts nothing else on create, and nothing can update a question at all.
 * The other two are declared now because the field exists now, and because a
 * union that grows later is a union every `switch` over it has to be revisited
 * for.
 */
export type QuestionStatus = 'approved' | 'pending' | 'rejected';

/** The question content itself, independent of who submitted it or when. */
export interface CustomQuestionContent {
  /**
   * The free-text category every question written before `FEAT-052` carries.
   *
   * **Optional, and nothing writes it any more.** The contribute form asks for
   * topics instead; `firestore.rules` keeps the key in its allowlist with the
   * bounds it always had, so every existing document stays valid and its
   * author can still edit it — and the edit drops it, because the form has no
   * field to carry it back. Readers derive a tag from it through
   * `topicTagsOf()`, and `scripts/backfill-category-tags.mjs` writes that tag
   * onto the document so the draw can see it too.
   */
  category?: string;
  type: QuestionType;
  difficulty: Difficulty;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
  /**
   * Where the contributor says the answer comes from (`FEAT-022`). Optional on
   * both the read and the write shape — unlike `createdBy`, this one is
   * genuinely optional rather than legacy-optional: a question with no citation
   * is a normal question, not one predating a field.
   *
   * `firestore.rules` requires `https://` and caps the length; `http://` is
   * refused because the CSP would not load it and a citation the reader cannot
   * open is worse than none.
   */
  sourceUrl?: string;
  /** A label for `sourceUrl`, or a citation with no link — a book, an edition. */
  sourceTitle?: string;
  /**
   * The contributor's justification for the question and its answers
   * (`FEAT-006`'s `explanation`, offered on the form as **Justification**).
   * Optional; `firestore.rules` caps it at 1000 characters and refuses an
   * empty string, so "none given" is an absent key.
   */
  explanation?: string;
  /**
   * Whether the contributor wrote Markdown (`FEAT-019`). Written only when the
   * form's toggle is on Markdown: the field is optional and absent means plain,
   * so writing `'plain'` explicitly would put a value in every future document
   * to say what its absence already says.
   *
   * `firestore.rules` accepts either value or none, and refuses anything else.
   */
  format?: QuestionFormat;
  /**
   * Free-form topic tags, normalised by `normalizeTag()` before they are
   * stored (`FEAT-021`) — and, since topics replaced categories, the question's
   * only topic (`FEAT-052`).
   *
   * **Required on create, optional on the shape.** `firestore.rules` refuses a
   * new question with no tags, because a question the topic filter can never
   * reach is a question nobody asking for a topic is served; the contribute
   * form asks for at least one for the same reason. The field stays optional
   * here because the bank still holds documents written before either rule —
   * an untagged question is still drawn by every unfiltered game, and its
   * author may still edit it.
   *
   * `firestore.rules` bounds it at eight entries, each a distinct lower-case
   * kebab-case string of 2–32 characters. The rule cannot call the normaliser,
   * so it enforces the *shape* the normaliser produces.
   */
  tags?: string[];
}

/**
 * Raw shape of a question as *read back* from the `custom_questions`
 * collection.
 *
 * Attribution is optional here and required in `NewCustomQuestionDoc` below,
 * and the asymmetry is deliberate rather than sloppy: documents created before
 * attribution existed have no `createdBy`, and no backfill can invent one —
 * nobody recorded who wrote them. Typing the read shape as if every document
 * has an author would be a lie the compiler then helps propagate. Anything
 * consuming this must handle the legacy case.
 */
export interface CustomQuestionDoc extends CustomQuestionContent {
  /** Firebase uid of the submitter. Absent on documents predating attribution. */
  createdBy?: string;
  /** Epoch ms at submission. Absent on documents predating attribution. */
  createdAt?: number;
  /**
   * Moderation status. Optional here for the same reason `createdBy` is:
   * documents written before the field existed do not have one until
   * `scripts/backfill-question-status.mjs` has run over them. Unlike
   * `createdBy`, this one *is* backfillable — every question already in the
   * bank was published, so `'approved'` is the honest value rather than a
   * guess — which is why it is a migration and not a permanent asymmetry.
   */
  status?: QuestionStatus;
  /**
   * Why a reviewer rejected the question, in their own words (`FEAT-007`).
   *
   * **Reviewer-authored and shown to the author**, on `/my-questions` — except
   * on a question the generation pipeline wrote, which has no author to show
   * it to, so there it stays on the record for the reviewers. Optional
   * in every direction: a reviewer may reject without giving one, every
   * question rejected before this field existed has none, and
   * `firestore.rules` refuses it on any document that is not `rejected` — so
   * "no reason given" is an absent key rather than a blank string, and it is
   * the normal case rather than an error.
   *
   * Not writable by the author at either end: the create rule refuses it and
   * the owner's own edit clears it, because an edit replaces the text the note
   * was about.
   */
  rejectionReason?: string;
  /**
   * The difficulty counters (`FEAT-023`): how many times the question has been
   * answered in a banked game, and how many of those answers were right.
   *
   * **Read-only to every client, and deliberately absent from the write
   * shapes below.** `recordGameResult` writes them on the Admin SDK and
   * nothing else may: `firestore.rules` refuses either on a create, and the
   * author's own edit must leave both exactly as stored — which
   * `FirebaseService.updateUserQuestion` does by never naming them in its
   * patch.
   */
  answered?: number;
  correct?: number;
  /**
   * Where a machine-generated question came from (`FEAT-020`): the map the
   * question-generation pipeline writes on every question it promotes into the
   * bank. **Absent means a person wrote it**, so no question already in the
   * bank changed meaning when the field arrived.
   *
   * **Written on the Admin SDK and never through a rule.** No client may write
   * it — the create allowlist has no such key — nothing in `firestore.rules`
   * reads it, and the reviewer's status write leaves it exactly as it was.
   * That makes the pipeline the only thing that ever validated it, and the
   * console can write any shape here, so every reader goes through
   * `question-provenance.util.ts` rather than trusting this type
   * (`CLAUDE.md` §4.4).
   */
  provenance?: QuestionProvenance;
}

/**
 * The `provenance` map, as the pipeline writes it on a question it promotes
 * (design §3 in `shermam/trivia-project`): `FEAT-020` §0's block, plus the
 * provider, minus a requester. The pipeline's `promoted-document.ts` is the
 * writer and the validator; this is the shape it promises, not one anybody
 * here checks on the way in.
 */
export interface QuestionProvenance {
  source: 'ai';
  provider: string;
  /** The model the run asked for. */
  model: string;
  /** The model that answered, as its response named it — a dated snapshot, where there is one. */
  modelVersion: string;
  /** Epoch ms: when the generation call returned with this question. */
  generatedAt: number;
  /** The run that produced it — what makes a bad batch one query rather than an archaeology exercise. */
  runId: string;
}

/**
 * What `deleteAccount` writes into `createdBy` when an author erases their
 * account — `ANONYMISED_AUTHOR` in `functions/src/account-policy.ts`, and the
 * value `firestore.rules`' `isQuestionAuthor()` refuses by name. The question
 * survives; the person does not.
 *
 * **Not a uid, so nothing that looks an account up by it may treat it as one.**
 * Every erased author shares it, so "everything this account contributed"
 * (`FEAT-006`) asked of the sentinel would be the contributions of everybody
 * who ever left, presented as one account's. `firestore-tests` pins the three
 * copies equal, since nothing else would notice them drift.
 */
export const DELETED_AUTHOR = '[deleted-user]';

/**
 * What the question-generation pipeline writes into `createdBy` on a question
 * it promotes into the bank (`FEAT-020`; `GENERATED_AUTHOR` in
 * `shermam/trivia-pipeline`, after the `[deleted-user]` precedent) — beside
 * `GENERATED_AUTHOR` in `functions/src/account-policy.ts`, and the value
 * `firestore.rules`' `isQuestionAuthor()` refuses by name.
 *
 * **Not a uid, and not a person.** A generated question belongs to the bank,
 * so nobody may edit or withdraw it from `/my-questions`; and every question
 * every run promotes shares it, so "everything this account contributed"
 * (`FEAT-006`) asked of it would be the pipeline's whole output presented as
 * one account's. Nor is there anything of anybody's for `deleteAccount` to
 * anonymise or `exportAccountData` to return. `firestore-tests` pins the three
 * copies equal, as it does `DELETED_AUTHOR`'s.
 */
export const GENERATED_AUTHOR = '[generated]';

/**
 * What the client writes. `firestore.rules` requires `createdBy` to equal the
 * caller's own uid and `createdAt` to sit near server time, so neither can be
 * spoofed or backdated — see `isValidCustomQuestion()`.
 */
export interface NewCustomQuestionDoc extends CustomQuestionContent {
  createdBy: string;
  createdAt: number;
}

/**
 * What actually reaches Firestore: {@link NewCustomQuestionDoc} plus the
 * moderation status, which `FirebaseService.addCustomQuestion` supplies rather
 * than the caller.
 *
 * Deliberately not part of `NewCustomQuestionDoc`. A submitter has no
 * legitimate choice about the status of their own submission, so putting it on
 * the caller's interface would be offering a decision that `firestore.rules`
 * exists to refuse — and it would mean every call site changes when 4c flips
 * the value, instead of one line in the service.
 */
export interface CustomQuestionWrite extends NewCustomQuestionDoc {
  status: QuestionStatus;
}

export type QuestionReportReason = 'incorrect' | 'inappropriate' | 'spam' | 'other';

/**
 * What the client writes to `question_reports` (finding H4). `firestore.rules`
 * requires `reportedBy` to equal the caller's own uid and `createdAt` to sit
 * near server time — same self-asserting attribution as `custom_questions` —
 * and requires `questionId` to name a document that actually exists in the
 * bank. `detail` is optional and must be **omitted**, not `undefined`, when
 * empty: Firestore rejects `undefined` field values outright.
 */
export interface NewQuestionReportDoc {
  questionId: string;
  reason: QuestionReportReason;
  detail?: string;
  reportedBy: string;
  createdAt: number;
}

/**
 * A filed report as the review queue reads it back (`FEAT-026`).
 *
 * **`reportedBy` is absent on purpose, and its absence is the feature.** A
 * reviewer needs the complaint, not the complainant, and the uid is the one
 * field in the document that identifies a person. `firestore.rules` cannot
 * return a subset of a document, so the narrowing happens in
 * `ReviewerService.getQuestionReports` — and leaving the field off this type is
 * what stops a template ever being written that renders it.
 */
export interface QuestionReport {
  /**
   * The `{window}-{slot}-{uid}` document ID: the stable key a `@for` tracks by
   * (`CLAUDE.md` §4.4). It **ends in the reporter's uid**, so it is a key and
   * never something to render — the same uid the field above deliberately
   * leaves out.
   */
  id: string;
  questionId: string;
  reason: QuestionReportReason;
  detail?: string;
  /**
   * Epoch ms, or `null` for a value that is not a number — which the rules make
   * unreachable through the app and a console-written document does not. The
   * queue says "Unknown" rather than rendering a date it does not have, the
   * same way an unattributed question does.
   */
  createdAt: number | null;
}

/**
 * Raw shape of a question as returned by the Open Trivia DB API. `category`
 * is the API's own and always present; the adapter turns it into the
 * question's seed tag (`category-tags.ts`).
 */
export interface OpenTriviaApiQuestion {
  category: string;
  type: QuestionType;
  difficulty: Difficulty;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
}

export interface OpenTriviaApiResponse {
  response_code: number;
  results: OpenTriviaApiQuestion[];
}
