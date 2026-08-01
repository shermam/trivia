export interface CustomQuestionSeed {
  id?: string;
  category: string;
  type: 'multiple' | 'boolean';
  difficulty: 'easy' | 'medium' | 'hard';
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
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
