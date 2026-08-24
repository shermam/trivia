import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, setDoc, writeBatch } from 'firebase/firestore';

const FIRESTORE_EMULATOR_HOST = '127.0.0.1';
const FIRESTORE_EMULATOR_PORT = 8080;

/**
 * Each spec file gets its own project ID so the files stay fully isolated and
 * can run in parallel — `clearFirestore()` wipes an entire project, so sharing
 * one would make two files racing each other's fixtures.
 */
export function createTestEnv(projectId: string): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId,
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: FIRESTORE_EMULATOR_HOST,
      port: FIRESTORE_EMULATOR_PORT,
    },
  });
}

/**
 * Auth-context factories, one per shape `firestore.rules` actually
 * distinguishes. Every one sets `firebase.sign_in_provider` explicitly:
 * omitting it yields a provider that satisfies `!= 'anonymous'`, so a test
 * relying on the default would pass for the wrong reason and would keep
 * passing if the anonymous check were deleted.
 */
export const asAnonymous = (env: RulesTestEnvironment, uid: string): RulesTestContext =>
  env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } });

export const asUnverifiedPassword = (env: RulesTestEnvironment, uid: string): RulesTestContext =>
  env.authenticatedContext(uid, {
    firebase: { sign_in_provider: 'password' },
    email_verified: false,
  });

export const asVerifiedPassword = (env: RulesTestEnvironment, uid: string): RulesTestContext =>
  env.authenticatedContext(uid, {
    firebase: { sign_in_provider: 'password' },
    email_verified: true,
  });

export const asOAuth = (env: RulesTestEnvironment, uid: string): RulesTestContext =>
  env.authenticatedContext(uid, { firebase: { sign_in_provider: 'google.com' } });

/** A verified, non-anonymous account carrying the `stripeRole: 'pro'` claim the webhook sets. */
export const asPro = (env: RulesTestEnvironment, uid: string): RulesTestContext =>
  env.authenticatedContext(uid, {
    firebase: { sign_in_provider: 'password' },
    email_verified: true,
    stripeRole: 'pro',
  });

/** Signed in, verified, but with a claim that isn't `pro` — guards against a truthiness check. */
export const asWrongRole = (env: RulesTestEnvironment, uid: string): RulesTestContext =>
  env.authenticatedContext(uid, {
    firebase: { sign_in_provider: 'password' },
    email_verified: true,
    stripeRole: 'basic',
  });

export const asSignedOut = (env: RulesTestEnvironment): RulesTestContext =>
  env.unauthenticatedContext();

/**
 * Grants the moderation role, the only way it can be granted: with rules
 * disabled. `user_roles` has no client write path at all, which is the point
 * of the collection rather than a testing inconvenience.
 */
export async function grantReviewer(
  env: RulesTestEnvironment,
  uid: string,
  reviewer = true,
): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'user_roles', uid), { reviewer });
  });
}

/**
 * A schema-valid `custom_questions` document; spread over it to build invalid
 * variants. `createdBy` must match the uid of whichever context writes it, so
 * it's a required argument rather than a default nobody notices is wrong.
 */
export function validQuestion(createdBy: string, overrides: Record<string, unknown> = {}) {
  return {
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question: 'What is the chemical symbol for water?',
    correct_answer: 'H2O',
    incorrect_answers: ['CO2', 'O2', 'NaCl'],
    createdBy,
    createdAt: Date.now(),
    // Mandatory since the review-status migration, and the only value
    // `statusOnSubmission()` accepts on create. It lives in the shared factory
    // rather than in each test so that 4c's flip to 'pending' is one edit here
    // — and so the tests that deliberately vary it have to say so.
    status: 'approved',
    ...overrides,
  };
}

/**
 * A document ID the session-document volume cap accepts: `{window}-{slot}`,
 * where the window is the current 5-minute bucket of wall-clock time and the
 * slot is a digit. This mirrors what `SubscriptionService.createSessionDoc`
 * computes, deliberately — if the two ever disagree about the arithmetic, the
 * real client can't create a session either, and these tests should say so.
 *
 * `windowOffset` steps whole windows forward or backward, for the tests that
 * probe how far outside the current one the rules will still reach.
 */
export function sessionDocId(slot: number | string = 0, windowOffset = 0): string {
  const SESSION_WINDOW_MS = 300_000;
  return `${Math.floor(Date.now() / SESSION_WINDOW_MS) + windowOffset}-${slot}`;
}

/**
 * A document ID the question-report volume cap accepts:
 * `{window}-{slot}-{uid}` — the session-document ID shape with the caller's
 * uid appended, because `question_reports` is a flat top-level collection and
 * the suffix is what stops one user's slots occupying another's. Mirrors
 * `FirebaseService.reportQuestion`, deliberately — see `sessionDocId` above.
 */
export function reportDocId(uid: string, slot: number | string = 0, windowOffset = 0): string {
  return `${sessionDocId(slot, windowOffset)}-${uid}`;
}

/**
 * A schema-valid `question_reports` document; spread over it for invalid
 * variants. `reportedBy` must match the uid of whichever context writes it,
 * and the default `questionId` must be seeded into `custom_questions` first —
 * the rules check it exists.
 */
export function validReport(reportedBy: string, overrides: Record<string, unknown> = {}) {
  return {
    questionId: 'reported-question',
    reason: 'incorrect',
    reportedBy,
    createdAt: Date.now(),
    ...overrides,
  };
}

/** A schema-valid `checkout_sessions` document; spread over it for invalid variants. */
export function validCheckoutSession(overrides: Record<string, unknown> = {}) {
  return { price: 'price_test_pro', origin: 'https://example.web.app', ...overrides };
}

/** A schema-valid `portal_sessions` document; spread over it for invalid variants. */
export function validPortalSession(overrides: Record<string, unknown> = {}) {
  return { origin: 'https://example.web.app', ...overrides };
}

/**
 * A schema-valid `leaderboard/{uid}` document; spread over it to build invalid
 * variants.
 *
 * `percentage` must now agree with `score`/`totalQuestions`, so it is derived
 * rather than hardcoded — otherwise overriding `score` alone would produce an
 * entry that fails for an inconsistent percentage instead of the reason the
 * test is actually about, and the test would pass for the wrong reason.
 * Pass `percentage` explicitly to test the consistency rule itself.
 */
export function validEntry(uid: string, overrides: Record<string, unknown> = {}) {
  const score = 'score' in overrides ? (overrides['score'] as number) : 7;
  const totalQuestions =
    'totalQuestions' in overrides ? (overrides['totalQuestions'] as number) : 10;
  return {
    uid,
    name: 'Ada',
    score,
    totalQuestions,
    percentage: Math.round((score / totalQuestions) * 100),
    createdAt: Date.now(),
    ...overrides,
  };
}

/** The hourly bucket `questionQuotaWindow()` in `firestore.rules` computes. */
export const questionQuotaWindow = (): string => String(Math.floor(Date.now() / 3_600_000));

export const questionQuotaId = (uid: string): string => `${questionQuotaWindow()}-${uid}`;

/**
 * Submits a question the way the app now has to: the question **and** its
 * hourly quota counter in a single batch (`BACKLOG.md` item 3).
 *
 * Every `custom_questions` create goes through here, including the ones
 * expected to fail. That is the point. `firestore.rules` reads the counter's
 * post-commit state with `getAfter()`, so a bare `addDoc` is now refused for
 * *volume* — and a schema test written that way would still go green while
 * proving nothing about the schema. Same trap as an auth context built
 * slightly wrong: passing for a reason unrelated to the rule it names.
 */
export function submitQuestion(
  ctx: RulesTestContext,
  options: {
    uid: string;
    payload: Record<string, unknown>;
    /** The value written to the counter. `create` demands 1; `update` demands exactly +1. */
    count?: number;
    /** Bill the submission to a different account's counter — must be refused. */
    quotaOwner?: string;
    /** Leave the counter out entirely — must be refused. */
    withQuota?: boolean;
  },
): Promise<void> {
  const db = ctx.firestore();
  const batch = writeBatch(db);
  if (options.withQuota !== false) {
    batch.set(
      doc(db, 'custom_question_quota', questionQuotaId(options.quotaOwner ?? options.uid)),
      {
        count: options.count ?? 1,
      },
    );
  }
  batch.set(doc(collection(db, 'custom_questions')), options.payload);
  return batch.commit();
}
