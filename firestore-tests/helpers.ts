import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';

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

/** A schema-valid `custom_questions` document; spread over it to build invalid variants. */
export function validQuestion(overrides: Record<string, unknown> = {}) {
  return {
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question: 'What is the chemical symbol for water?',
    correct_answer: 'H2O',
    incorrect_answers: ['CO2', 'O2', 'NaCl'],
    ...overrides,
  };
}

/** A schema-valid `leaderboard/{uid}` document; spread over it to build invalid variants. */
export function validEntry(uid: string, overrides: Record<string, unknown> = {}) {
  return {
    uid,
    name: 'Ada',
    score: 7,
    totalQuestions: 10,
    percentage: 70,
    createdAt: Date.now(),
    ...overrides,
  };
}
