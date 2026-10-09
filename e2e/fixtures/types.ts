export interface CustomQuestionSeed {
  id?: string;
  /**
   * The free-text category a question written before topics replaced
   * categories carries (`FEAT-052`). Optional, as it is in the schema: a
   * contribution written since has none, and a spec that seeds one is standing
   * in for a question from before the change.
   */
  category?: string;
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
  /**
   * A reviewer's note on a rejected question (`FEAT-007`) — seeded for the
   * spec that needs a rejection a reviewer already explained, to prove a
   * later action leaves it alone.
   */
  rejectionReason?: string;
  createdAt?: number;
  /**
   * The optional contributor fields (`FEAT-022`): where the answer comes from,
   * and why it is the answer. Optional in the schema too, not merely here —
   * almost no question in the bank carries any of them, so a spec asserting
   * their *absence* is testing the common case.
   */
  sourceUrl?: string;
  sourceTitle?: string;
  explanation?: string;
  /**
   * How the text is meant to be read (`FEAT-019`). Absent — which is every
   * other seed in the suite — means plain, so a spec that says nothing about
   * formatting is seeding the shape the whole bank has today.
   */
  format?: 'plain' | 'markdown';
  /**
   * Normalised topic tags (`FEAT-021`) — the only topic a question has since
   * they replaced categories (`FEAT-052`), and what isolates a spec's game in
   * a bank every worker shares: a spec that seeds its questions under a tag it
   * minted itself (`e2e/support/topics.ts`) owns every question that can match
   * it. Optional here although a client's create must carry one, because these
   * seeds go in through the Admin SDK and a spec may want a question that has
   * none.
   */
  tags?: string[];
  /**
   * The difficulty counters (`FEAT-023`) — how many times the question has
   * been answered in a banked game, and how many of those answers were right.
   * Only `recordGameResult` writes them in the app, on the Admin SDK, and no
   * client may; seeding them is how a spec stands in for a question players
   * have already answered.
   */
  answered?: number;
  correct?: number;
}

/**
 * A curated quiz to seed (`FEAT-024`) — what `scripts/seed-quiz.mjs` writes,
 * written straight through the Admin SDK instead.
 *
 * Every field but `id` and `questionIds` has a default, and `isPublished`
 * defaults to `true` because a published quiz is what nearly every spec plays;
 * a spec about a draft says so. Nothing here is validated, deliberately: the
 * console can write any shape at all, and a spec standing in for one of those
 * documents needs to be able to as well.
 */
export interface QuizSeed {
  id: string;
  questionIds: string[];
  title?: string;
  description?: string;
  createdBy?: string;
  /** Epoch ms. Defaults to now; the list on `/` orders by it, newest first. */
  createdAt?: number;
  isPublished?: boolean;
  /** 15, 30 or `'unlimited'` — pre-selects the quiz page's picker. */
  suggestedTimeLimit?: 15 | 30 | 'unlimited' | null;
}

/**
 * A question's difficulty counters as stored (`FEAT-023`), or `null` for a
 * question whose document does not exist — which is a different fact from one
 * nobody has answered, where both counts are simply absent.
 */
export type QuestionCountersRecord = { answered?: unknown; correct?: unknown } | null;

export interface VerifiedUserSeed {
  email: string;
  password: string;
  displayName?: string;
  /**
   * The profile photo a Google sign-in would have left on the account
   * (`FEAT-038`). The emulator stores it like any other profile field, so an
   * email/password account can stand in for a Google one in the avatar specs.
   */
  photoURL?: string;
}

/**
 * Drives the app into a "Pro" state the same way our Stripe webhook handler
 * would — a `stripeRole: 'pro'` custom claim plus a synced `subscriptions`
 * doc — without ever calling Stripe. See `firebase-backend.ts`.
 */
export interface ProSubscriptionSeed {
  uid: string;
}

/**
 * One monthly Pro price, as `stripeWebhook` would mirror it.
 *
 * A currency is a **separate Stripe Price** on the same product rather than a
 * `currency_options` entry on one — Stripe freezes a price once it has been
 * used — so seeding a second currency means seeding a second price here too
 * (`docs/data-model.md`, `products`).
 */
export interface ProPriceSeed {
  id: string;
  currency: string;
  /** Smallest unit of that currency: 99 for $0.99, 590 for R$ 5,90. */
  unitAmount: number;
}

/**
 * One donation preset to seed — a single one-time Stripe Price on the donation
 * product.
 *
 * `kind: 'donation'` is the marker the mirror copies from Stripe metadata onto
 * both the product and the price, and it is what keeps the Pro catalog and the
 * tip jar from matching each other's prices (`functions/src/checkout-request.ts`).
 * Seeded here rather than assumed, because `stripeWebhook` never fires against
 * the emulator.
 */
export interface DonationPriceSeed {
  id: string;
  currency: string;
  /** Smallest unit of that currency: 500 for $5.00, 2500 for R$ 25,00. */
  unitAmount: number;
}

/** A donation-session document as the client wrote it, read back for assertions. */
export interface DonationSessionRecord {
  id: string;
  price: string;
  origin: string;
}

/** A checkout-session document as the client wrote it, read back for assertions. */
export interface CheckoutSessionRecord {
  id: string;
  price: string;
  origin: string;
}

/**
 * A `question_reports` document as read back by `getQuestionReports`, ID
 * included — the ID carries the `{window}-{slot}-{uid}` volume cap, so specs
 * assert on its shape as well as on the payload (finding H4).
 */
export interface QuestionReportRecord {
  id: string;
  questionId: string;
  reason: 'incorrect' | 'inappropriate' | 'spam' | 'other';
  detail?: string;
  reportedBy: string;
  createdAt: number;
}

/**
 * A report written straight into the collection, for a spec that needs more of
 * them than filing them through the UI could reasonably produce — paging.
 *
 * Identical to what is read back, and the **ID is the caller's** rather than
 * generated, because the queue orders by document ID: a spec that wants to know
 * which of its reports land on which page has to choose where they sort.
 */
export type QuestionReportSeed = QuestionReportRecord;

/**
 * A board entry as Firestore holds it, read back for assertions.
 *
 * The whole document rather than "does a row exist", because the thing worth
 * checking about a save is the numbers it wrote: a score, its denominator and
 * the accuracy derived from neither. `timeLimit` is included because the entry
 * carries the board it belongs to as a field as well as in its path
 * (`docs/data-model.md`), and the two disagreeing is a real failure mode.
 */
export interface LeaderboardEntryRecord {
  name: string;
  score: number;
  totalQuestions: number;
  percentage: number;
  createdAt: number;
  timeLimit: string;
  /**
   * The declared country, on a regional entry only (`FEAT-028`). Optional
   * rather than a separate record type because the assertion worth writing is
   * that it is **absent** on a global entry — `firestore.rules` refuses the
   * key there — and a type that could not express the absence could not
   * express that.
   */
  region?: string;
}

/** Which entry to read back. One document per account per board. */
export interface LeaderboardEntryQuery {
  uid: string;
  /** Which board to read. Defaults to the 15-second board. */
  timeLimit?: string;
}

/** The same, one path segment deeper: one document per account per country per board. */
export interface RegionalLeaderboardEntryQuery extends LeaderboardEntryQuery {
  /** ISO 3166-1 alpha-2, as the player declared it (`FEAT-028`). */
  region: string;
}

/**
 * The boards, one per timing constraint (finding G7). Must match `isValidBoard`
 * in `firestore.rules`. Seeding and cleanup both have to visit every one of
 * them, so the list lives here rather than at each call site.
 */
export const LEADERBOARD_BOARDS = ['15', '30', 'unlimited'] as const;

export interface LeaderboardSeed {
  uid: string;
  name: string;
  score: number;
  totalQuestions: number;
  percentage: number;
  createdAt?: number;
  /** Which board to seed into. Defaults to the 15-second board. */
  timeLimit?: string;
}

/**
 * One account's avatar choice (`FEAT-038`), written where `setAvatar` writes
 * it — the `avatar` field of `users/{uid}`, beside any totals.
 */
export interface AvatarSeed {
  uid: string;
  avatar: { kind: 'initials' | 'photo' | 'built'; seed?: string; showPublicly: boolean };
}

/**
 * Lifetime totals as the `recordGameResult` callable would have banked them.
 *
 * Writing `users/{uid}` directly is the Admin SDK's privilege — the collection
 * has no client write path at all (`docs/data-model.md`) — and it exists so a
 * spec whose subject is the *profile screen* can put a known set of numbers on
 * it in one round trip instead of playing the games that would produce them.
 * A spec whose subject is the callable plays the game: see
 * `lifetime-stats.spec.ts`.
 */
export interface GameplayStatsSeed {
  uid: string;
  gamesPlayed: number;
  questionsAnswered: number;
  correctAnswers: number;
  bestStreak: number;
  /** Epoch ms. Omitted to stand in for a document written before the field existed. */
  statsSince?: number;
  /**
   * Experience points (`FEAT-041`). Omitted to stand in for a document banked
   * before XP existed, which reads as none.
   */
  xp?: number;
}

/**
 * One account's XP alone (`FEAT-041`), written beside whatever the document
 * already holds — for a spec that needs a level without the totals, or needs
 * to move one under an avatar already stored.
 */
export interface XpSeed {
  uid: string;
  xp: number;
}

/**
 * A `question_votes` document as Firestore holds it (`FEAT-027`), read back
 * for assertions. The id is `{uid}_{questionId}`, so it says whose vote it is.
 */
export interface QuestionVoteRecord {
  id: string;
  questionId: string;
  /** `1` a like, `-1` a dislike. */
  value: number;
  /** Epoch ms of the first vote on the pair; a change of mind leaves it alone. */
  createdAt: number;
}

/**
 * A vote written straight into the collection, for the votes a test needs
 * that no browser in it can cast — another account's, above all, which is
 * what the deletion sweep must leave alone.
 *
 * `id` defaults to `{uid}_{questionId}`, the only shape the rules accept.
 */
export interface QuestionVoteSeed {
  uid: string;
  questionId: string;
  value: 1 | -1;
  createdAt?: number;
  id?: string;
}

/**
 * One question inside a `users/{uid}/plays/{gameId}` document (`FEAT-049`), as
 * `recordGameResult` wrote it.
 *
 * `questionId` and `tags` are optional here because they are optional in the
 * document: an Open Trivia DB question has no id worth keeping and an untagged
 * bank question has no tags, so a spec asserting their **absence** is asserting
 * the common case.
 */
export interface PlayAnswerRecord {
  questionId?: string;
  correct: boolean;
  ms: number;
  difficulty: 'easy' | 'medium' | 'hard';
  tags?: string[];
}

/** One completed game, read back for assertions. The id is the `gameId`. */
export interface PlayRecord {
  id: string;
  at: number;
  answers: PlayAnswerRecord[];
}

/** Grants (or explicitly withholds) the moderation role for one account. */
export interface ReviewerSeed {
  uid: string;
  /** `false` is a distinct fixture from absent — it is the H6 shape. */
  reviewer: boolean;
}

/** Which uid (and optionally which contributed question) to inspect after an account deletion. */
export interface AccountStateQuery {
  uid: string;
  questionId?: string;
}

/** What `inspectAccountState` reports back — see the method for why it reads all five at once. */
export interface AccountState {
  authUserExists: boolean;
  leaderboardExists: boolean;
  customerExists: boolean;
  questionExists: boolean;
  questionCreatedBy: string | null;
  /** `users/{uid}` in full, or null when the account has never finished a game. */
  gameplayStats: Record<string, unknown> | null;
}

/**
 * Who `signInAs` signs in as (`caller-gate.spec.ts`): a guest, an email and
 * password account in either verification state, or an account of an OAuth
 * provider named by its Firebase id — one the app offers, or one it does not.
 */
export type CallerIdentity =
  | { kind: 'anonymous' }
  | { kind: 'password'; emailVerified: boolean }
  | { kind: 'oauth'; providerId: string };

/** A session the Auth emulator signed: the account, and the ID token a callable carries. */
export interface SignedInCaller {
  uid: string;
  idToken: string;
}

/**
 * A callable's answer as its HTTP protocol carries it: `result` when the
 * function returned, `error` — with the HTTP status beside it — when it threw
 * an `HttpsError`.
 */
export interface CallableAnswer {
  status: number;
  result?: unknown;
  error?: { status?: string; message?: string };
}
