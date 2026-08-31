export type QuestionType = 'multiple' | 'boolean';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type QuestionSource = 'open_trivia' | 'custom' | 'mixed';

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
  category: string;
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
  category: string;
  difficulty: Difficulty | '';
  source: QuestionSource;
  timeLimit: TimeLimitOption;
}

export interface LeaderboardEntry {
  id?: string;
  /** Firebase Auth uid — also the Firestore document ID (one entry per user *per board*, best score kept). */
  uid: string;
  name: string;
  score: number;
  totalQuestions: number;
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
  category: string;
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
}

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

/** Raw shape of a question as returned by the Open Trivia DB API. */
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
