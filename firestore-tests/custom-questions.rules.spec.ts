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
    await assertFails(addDoc(questions(asSignedOut(env)), validQuestion('nobody')));
  });

  it('rejects an anonymous caller', async () => {
    await assertFails(addDoc(questions(asAnonymous(env, 'anon')), validQuestion('anon')));
  });

  it('rejects an unverified password account', async () => {
    await assertFails(addDoc(questions(asUnverifiedPassword(env, 'u')), validQuestion('u')));
  });

  it('rejects a verified password account with no Pro claim', async () => {
    await assertFails(addDoc(questions(asVerifiedPassword(env, 'u')), validQuestion('u')));
  });

  it('rejects an OAuth account with no Pro claim', async () => {
    await assertFails(addDoc(questions(asOAuth(env, 'u')), validQuestion('u')));
  });

  // Guards against the claim check ever being loosened to a truthiness test.
  it('rejects a stripeRole that is set but is not exactly "pro"', async () => {
    await assertFails(addDoc(questions(asWrongRole(env, 'u')), validQuestion('u')));
  });

  it('allows a verified Pro subscriber', async () => {
    await assertSucceeds(addDoc(questions(asPro(env, 'pro-user')), validQuestion('pro-user')));
  });
});

describe('custom_questions: create — schema validation', () => {
  const rejects = (label: string, overrides: Record<string, unknown>) =>
    it(`rejects ${label}`, async () => {
      await assertFails(
        addDoc(questions(asPro(env, 'pro-user')), validQuestion('pro-user', overrides)),
      );
    });

  rejects('an unknown extra key', { upvotes: 0 });
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
  // 3 is the ceiling now, not 5: the add-question form offers exactly three
  // incorrect fields for a multiple-choice question and derives one for a
  // boolean, so anything more was never reachable through the UI — while the
  // quiz only ever labelled four answers (finding B2).
  rejects('more than 3 incorrect answers', { incorrect_answers: ['a', 'b', 'c', 'd'] });

  /*
   * Finding B1. The quiz used to score a click by matching its text against
   * `correct_answer`, so a question listing the right answer among the wrong
   * ones let the wrong option score as correct — and `@for`'s `track` saw two
   * identical keys. The client no longer identifies answers by text, but the
   * data should never have carried the ambiguity: a question with two
   * identical options has no single right answer whatever the reader does
   * with it.
   */
  rejects('the correct answer repeated among the incorrect ones', {
    correct_answer: 'H2O',
    incorrect_answers: ['H2O', 'CO2', 'O2'],
  });
  rejects('a duplicate within the incorrect answers', {
    incorrect_answers: ['CO2', 'CO2', 'O2'],
  });
  rejects('a non-string question', { question: 42 });
  rejects('a non-string category', { category: 7 });

  it('accepts the maximum three incorrect answers', async () => {
    await assertSucceeds(
      addDoc(
        questions(asPro(env, 'pro-user')),
        validQuestion('pro-user', { incorrect_answers: ['CO2', 'O2', 'NaCl'] }),
      ),
    );
  });

  // Only exact repeats are rejected. Answers that merely look similar are a
  // question-quality matter, not a correctness one, and the rules have no
  // business judging them.
  it('accepts answers that differ only by case or spacing', async () => {
    await assertSucceeds(
      addDoc(
        questions(asPro(env, 'pro-user')),
        validQuestion('pro-user', { correct_answer: 'H2O', incorrect_answers: ['h2o', ' H2O'] }),
      ),
    );
  });

  it('rejects a document missing a required key', async () => {
    const { incorrect_answers: _dropped, ...withoutAnswers } = validQuestion('pro-user');
    await assertFails(addDoc(questions(asPro(env, 'pro-user')), withoutAnswers));
  });

  it('accepts the minimum of one incorrect answer (a true/false question)', async () => {
    await assertSucceeds(
      addDoc(
        questions(asPro(env, 'pro-user')),
        validQuestion('pro-user', {
          type: 'boolean',
          correct_answer: 'True',
          incorrect_answers: ['False'],
        }),
      ),
    );
  });
});

describe('custom_questions: create — attribution cannot be spoofed', () => {
  it('rejects a createdBy naming someone else — the whole point of attribution', async () => {
    await assertFails(addDoc(questions(asPro(env, 'pro-user')), validQuestion('some-other-user')));
  });

  it('rejects a document with no createdBy at all', async () => {
    const { createdBy: _dropped, ...unattributed } = validQuestion('pro-user');
    await assertFails(addDoc(questions(asPro(env, 'pro-user')), unattributed));
  });

  it('rejects a document with no createdAt at all', async () => {
    const { createdAt: _dropped, ...undated } = validQuestion('pro-user');
    await assertFails(addDoc(questions(asPro(env, 'pro-user')), undated));
  });

  it('rejects a non-string createdBy', async () => {
    await assertFails(
      addDoc(questions(asPro(env, 'pro-user')), validQuestion('pro-user', { createdBy: 42 })),
    );
  });

  // Otherwise createdAt is decoration: any number would do, including one
  // chosen to make a submission look older than it is.
  it('rejects a backdated createdAt', async () => {
    await assertFails(
      addDoc(
        questions(asPro(env, 'pro-user')),
        validQuestion('pro-user', { createdAt: Date.now() - 60 * 60 * 1000 }),
      ),
    );
  });

  it('rejects a future-dated createdAt', async () => {
    await assertFails(
      addDoc(
        questions(asPro(env, 'pro-user')),
        validQuestion('pro-user', { createdAt: Date.now() + 60 * 60 * 1000 }),
      ),
    );
  });

  it('rejects a non-integer createdAt', async () => {
    await assertFails(
      addDoc(
        questions(asPro(env, 'pro-user')),
        validQuestion('pro-user', { createdAt: 'just now' }),
      ),
    );
  });

  // A small skew in either direction has to survive, or a user with a slightly
  // wrong clock or a slow connection simply can't contribute.
  it('tolerates a clock a couple of minutes behind', async () => {
    await assertSucceeds(
      addDoc(
        questions(asPro(env, 'pro-user')),
        validQuestion('pro-user', { createdAt: Date.now() - 2 * 60 * 1000 }),
      ),
    );
  });
});

describe('custom_questions: update and delete are console-only', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'custom_questions', 'seeded'), validQuestion('pro-user'));
    });
  });

  it('rejects an update even from a Pro subscriber', async () => {
    await assertFails(
      setDoc(
        question(asPro(env, 'pro-user'), 'seeded'),
        validQuestion('pro-user', { question: 'Edited' }),
      ),
    );
  });

  it('rejects a delete even from a Pro subscriber', async () => {
    await assertFails(deleteDoc(question(asPro(env, 'pro-user'), 'seeded')));
  });
});
