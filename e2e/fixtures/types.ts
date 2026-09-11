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
  /**
   * Moderation status. Defaults to `'approved'` in the seeding helper, which
   * is what every question in the real bank carries once
   * `scripts/backfill-question-status.mjs` has run — a fixture without one
   * would model a state that no longer exists. Overridable so a spec can seed
   * a pending or rejected question.
   */
  status?: 'approved' | 'pending' | 'rejected';
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
 * doc — without ever calling Stripe. See `firebase-backend.ts`.
 */
export interface ProSubscriptionSeed {
  uid: string;
}
