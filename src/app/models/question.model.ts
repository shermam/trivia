export type QuestionType = 'multiple' | 'boolean';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type QuestionSource = 'open_trivia' | 'custom' | 'mixed';

export interface TriviaQuestion {
  id: string;
  category: string;
  type: QuestionType;
  difficulty: Difficulty;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
  all_answers: string[];
  source: 'open_trivia' | 'custom';
}

export interface GameConfig {
  amount: number;
  category: string;
  difficulty: Difficulty | '';
  source: QuestionSource;
}

export interface LeaderboardEntry {
  id?: string;
  /** Firebase Auth uid — also the Firestore document ID (one entry per user, best score kept). */
  uid: string;
  name: string;
  score: number;
  totalQuestions: number;
  percentage: number;
  createdAt: number;
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
