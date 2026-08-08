import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { addDoc, collection, deleteDoc, doc, getDocs, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  asAnonymous,
  asOAuth,
  asPro,
  asSignedOut,
  asUnverifiedPassword,
  asVerifiedPassword,
  asWrongRole,
  createTestEnv,
  validQuestion,
} from './helpers';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnv('demo-rules-custom-questions');
});
afterAll(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const questions = (ctx: RulesTestContext) => collection(ctx.firestore(), 'custom_questions');
const question = (ctx: RulesTestContext, id: string) =>
  doc(ctx.firestore(), 'custom_questions', id);

describe('custom_questions: read', () => {
  it('is public — the game must work before anyone signs in', async () => {
    await assertSucceeds(getDocs(questions(asSignedOut(env))));
  });

  it('is readable by an anonymous player', async () => {
    await assertSucceeds(getDocs(questions(asAnonymous(env, 'anon'))));
  });
});

describe('custom_questions: create — who may write', () => {
  it('rejects a signed-out caller', async () => {
    await assertFails(addDoc(questions(asSignedOut(env)), validQuestion()));
  });

  it('rejects an anonymous caller', async () => {
    await assertFails(addDoc(questions(asAnonymous(env, 'anon')), validQuestion()));
  });

  it('rejects an unverified password account', async () => {
    await assertFails(addDoc(questions(asUnverifiedPassword(env, 'u')), validQuestion()));
  });

  it('rejects a verified password account with no Pro claim', async () => {
    await assertFails(addDoc(questions(asVerifiedPassword(env, 'u')), validQuestion()));
  });

  it('rejects an OAuth account with no Pro claim', async () => {
    await assertFails(addDoc(questions(asOAuth(env, 'u')), validQuestion()));
  });

  // Guards against the claim check ever being loosened to a truthiness test.
  it('rejects a stripeRole that is set but is not exactly "pro"', async () => {
    await assertFails(addDoc(questions(asWrongRole(env, 'u')), validQuestion()));
  });

  it('allows a verified Pro subscriber', async () => {
    await assertSucceeds(addDoc(questions(asPro(env, 'pro-user')), validQuestion()));
  });
});

describe('custom_questions: create — schema validation', () => {
  const rejects = (label: string, overrides: Record<string, unknown>) =>
    it(`rejects ${label}`, async () => {
      await assertFails(addDoc(questions(asPro(env, 'pro-user')), validQuestion(overrides)));
    });

  rejects('an unknown extra key', { createdBy: 'pro-user' });
  rejects('a type outside the allowed set', { type: 'essay' });
  rejects('a difficulty outside the allowed set', { difficulty: 'impossible' });
  rejects('an empty category', { category: '' });
  rejects('a category over 100 chars', { category: 'x'.repeat(101) });
  rejects('an empty question', { question: '' });
  rejects('a question over 500 chars', { question: 'x'.repeat(501) });
  rejects('an empty correct answer', { correct_answer: '' });
  rejects('a correct answer over 200 chars', { correct_answer: 'x'.repeat(201) });
  rejects('incorrect_answers that is not a list', { incorrect_answers: 'CO2' });
  rejects('an empty incorrect_answers list', { incorrect_answers: [] });
  rejects('more than 5 incorrect answers', { incorrect_answers: ['a', 'b', 'c', 'd', 'e', 'f'] });
  rejects('a non-string question', { question: 42 });
  rejects('a non-string category', { category: 7 });

  it('rejects a document missing a required key', async () => {
    const { incorrect_answers: _dropped, ...withoutAnswers } = validQuestion();
    await assertFails(addDoc(questions(asPro(env, 'pro-user')), withoutAnswers));
  });

  it('accepts the minimum of one incorrect answer (a true/false question)', async () => {
    await assertSucceeds(
      addDoc(
        questions(asPro(env, 'pro-user')),
        validQuestion({ type: 'boolean', correct_answer: 'True', incorrect_answers: ['False'] }),
      ),
    );
  });
});

describe('custom_questions: update and delete are console-only', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'custom_questions', 'seeded'), validQuestion());
    });
  });

  it('rejects an update even from a Pro subscriber', async () => {
    await assertFails(
      setDoc(question(asPro(env, 'pro-user'), 'seeded'), validQuestion({ question: 'Edited' })),
    );
  });

  it('rejects a delete even from a Pro subscriber', async () => {
    await assertFails(deleteDoc(question(asPro(env, 'pro-user'), 'seeded')));
  });
});
