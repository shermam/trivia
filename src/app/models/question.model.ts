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

/** Raw shape of a question as stored in the Firestore "custom_questions" collection. */
export interface CustomQuestionDoc {
  category: string;
  type: QuestionType;
  difficulty: Difficulty;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
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
