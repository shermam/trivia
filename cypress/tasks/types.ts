export interface CustomQuestionSeed {
  id?: string;
  category: string;
  type: 'multiple' | 'boolean';
  difficulty: 'easy' | 'medium' | 'hard';
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
  /**
   * Attribution (see `docs/data-model.md` §3). Optional here even though
   * `firestore.rules` requires it on a client create, because these seeds go
   * in via the Admin SDK and bypass rules — which lets a spec deliberately
   * seed an unattributed question to stand in for one predating attribution.
   */
  createdBy?: string;
  createdAt?: number;
}

export interface LeaderboardSeed {
  uid: string;
  name: string;
  score: number;
  totalQuestions: number;
  percentage: number;
  createdAt?: number;
}

export interface VerifiedUserSeed {
  email: string;
  password: string;
  displayName?: string;
}

/**
 * Drives the app into a "Pro" state the same way our Stripe webhook handler
 * would — a `stripeRole: 'pro'` custom claim plus a synced `subscriptions`
 * doc — without ever calling Stripe. See `firebase-emulator-tasks.ts`.
 */
export interface ProSubscriptionSeed {
  uid: string;
}

/**
 * A `question_reports` document as read back by the `getQuestionReports`
 * task, ID included — the ID carries the `{window}-{slot}-{uid}` volume cap,
 * so specs assert on its shape as well as the payload (finding H4).
 */
export interface QuestionReportRecord {
  id: string;
  questionId: string;
  reason: 'incorrect' | 'inappropriate' | 'spam' | 'other';
  detail?: string;
  reportedBy: string;
  createdAt: number;
}

/** Which uid (and optionally which contributed question) to inspect after an account deletion. */
export interface AccountStateQuery {
  uid: string;
  questionId?: string;
}

/** What `inspectAccountState` reports back — see the task for why it reads all four at once. */
export interface AccountState {
  authUserExists: boolean;
  leaderboardExists: boolean;
  customerExists: boolean;
  questionExists: boolean;
  questionCreatedBy: string | null;
}
