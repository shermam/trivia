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

/** The question content itself, independent of who submitted it or when. */
export interface CustomQuestionContent {
  category: string;
  type: QuestionType;
  difficulty: Difficulty;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
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
