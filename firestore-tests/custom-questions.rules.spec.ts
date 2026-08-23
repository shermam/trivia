import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
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
  questionQuotaId,
  submitQuestion,
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
    await assertFails(
      submitQuestion(asSignedOut(env), { uid: 'nobody', payload: validQuestion('nobody') }),
    );
  });

  it('rejects an anonymous caller', async () => {
    await assertFails(
      submitQuestion(asAnonymous(env, 'anon'), { uid: 'anon', payload: validQuestion('anon') }),
    );
  });

  it('rejects an unverified password account', async () => {
    await assertFails(
      submitQuestion(asUnverifiedPassword(env, 'u'), { uid: 'u', payload: validQuestion('u') }),
    );
  });

  it('rejects a verified password account with no Pro claim', async () => {
    await assertFails(
      submitQuestion(asVerifiedPassword(env, 'u'), { uid: 'u', payload: validQuestion('u') }),
    );
  });

  it('rejects an OAuth account with no Pro claim', async () => {
    await assertFails(submitQuestion(asOAuth(env, 'u'), { uid: 'u', payload: validQuestion('u') }));
  });

  // Guards against the claim check ever being loosened to a truthiness test.
  it('rejects a stripeRole that is set but is not exactly "pro"', async () => {
    await assertFails(
      submitQuestion(asWrongRole(env, 'u'), { uid: 'u', payload: validQuestion('u') }),
    );
  });

  it('allows a verified Pro subscriber', async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user'),
      }),
    );
  });
});

describe('custom_questions: create — schema validation', () => {
  const rejects = (label: string, overrides: Record<string, unknown>) =>
    it(`rejects ${label}`, async () => {
      await assertFails(
        submitQuestion(asPro(env, 'pro-user'), {
          uid: 'pro-user',
          payload: validQuestion('pro-user', overrides),
        }),
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
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { incorrect_answers: ['CO2', 'O2', 'NaCl'] }),
      }),
    );
  });

  // Only exact repeats are rejected. Answers that merely look similar are a
  // question-quality matter, not a correctness one, and the rules have no
  // business judging them.
  it('accepts answers that differ only by case or spacing', async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', {
          correct_answer: 'H2O',
          incorrect_answers: ['h2o', ' H2O'],
        }),
      }),
    );
  });

  it('rejects a document missing a required key', async () => {
    const { incorrect_answers: _dropped, ...withoutAnswers } = validQuestion('pro-user');
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), { uid: 'pro-user', payload: withoutAnswers }),
    );
  });

  it('accepts the minimum of one incorrect answer (a true/false question)', async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', {
          type: 'boolean',
          correct_answer: 'True',
          incorrect_answers: ['False'],
        }),
      }),
    );
  });
});

describe('custom_questions: create — attribution cannot be spoofed', () => {
  it('rejects a createdBy naming someone else — the whole point of attribution', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('some-other-user'),
      }),
    );
  });

  it('rejects a document with no createdBy at all', async () => {
    const { createdBy: _dropped, ...unattributed } = validQuestion('pro-user');
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), { uid: 'pro-user', payload: unattributed }),
    );
  });

  it('rejects a document with no createdAt at all', async () => {
    const { createdAt: _dropped, ...undated } = validQuestion('pro-user');
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), { uid: 'pro-user', payload: undated }),
    );
  });

  it('rejects a non-string createdBy', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { createdBy: 42 }),
      }),
    );
  });

  // Otherwise createdAt is decoration: any number would do, including one
  // chosen to make a submission look older than it is.
  it('rejects a backdated createdAt', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { createdAt: Date.now() - 60 * 60 * 1000 }),
      }),
    );
  });

  it('rejects a future-dated createdAt', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { createdAt: Date.now() + 60 * 60 * 1000 }),
      }),
    );
  });

  it('rejects a non-integer createdAt', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { createdAt: 'just now' }),
      }),
    );
  });

  // A small skew in either direction has to survive, or a user with a slightly
  // wrong clock or a slow connection simply can't contribute.
  it('tolerates a clock a couple of minutes behind', async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { createdAt: Date.now() - 2 * 60 * 1000 }),
      }),
    );
  });
});

describe('custom_questions: create — the moderation status (item 4b)', () => {
  // The accept case for the value of the day. Paired with the rejects below so
  // that 4c's flip from 'approved' to 'pending' cannot be a silent widening:
  // whichever value is current, exactly one is accepted and the others are
  // refused, so the flip has to move both halves in the diff.
  it("accepts status 'approved', the only value statusOnSubmission() allows today", async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { status: 'approved' }),
      }),
    );
  });

  // This is the row that makes the field a migration rather than an optional
  // extra. If a create with no status were accepted, a client cached from
  // before the change would keep writing documents the backfill has already
  // run past, and the read filter in 4b-ii would stop serving them.
  it('rejects a document with no status at all', async () => {
    const { status: _dropped, ...noStatus } = validQuestion('pro-user');
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), { uid: 'pro-user', payload: noStatus }),
    );
  });

  // Self-approval in reverse: until 4c, a submitter must not be able to opt
  // *into* the review queue either. One value, no choices.
  it("rejects status 'pending' while submissions are still published immediately", async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { status: 'pending' }),
      }),
    );
  });

  it("rejects status 'rejected'", async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { status: 'rejected' }),
      }),
    );
  });

  it('rejects a status outside the union', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { status: 'banana' }),
      }),
    );
  });

  // Guards against a truthiness check: `data.status == 'approved'` is a string
  // comparison and has to stay one.
  it('rejects a non-string status', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { status: true }),
      }),
    );
  });

  // The allowlist was widened by exactly one key, not opened. A second new
  // field is still refused, which is what keeps the A10 door shut.
  it('rejects an extra field alongside a valid status', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { reviewedBy: 'someone' }),
      }),
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

/**
 * `BACKLOG.md` item 3. Rules cannot count a user's documents, so the hourly cap
 * lives in a counter the client must increment in the *same batch* as the
 * question — `getAfter()` reads its post-commit state, which is what makes
 * declining to increment it impossible rather than merely discouraged.
 *
 * The accept cases matter as much as the rejections here, and more than usual.
 * A cap is exactly the kind of rule that fails 100% closed and looks correct
 * doing so: the session-document cap built on `string(math.floor(x))` refused
 * every legitimate checkout while a suite of nothing but `assertFails` passed
 * (`CLAUDE.md` §4.6).
 */
describe('custom_questions: the hourly quota (item 3)', () => {
  const quota = (ctx: RulesTestContext, uid: string) =>
    doc(ctx.firestore(), 'custom_question_quota', questionQuotaId(uid));

  /** Puts the counter at `count` without going through the rules. */
  const seedQuota = (uid: string, count: number) =>
    env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'custom_question_quota', questionQuotaId(uid)), { count });
    });

  it('accepts the very first submission of the hour, which creates the counter at 1', async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user'),
      }),
    );
  });

  it('accepts the twentieth submission — the cap is inclusive', async () => {
    // The off-by-one that would make the advertised limit 19.
    await seedQuota('pro-user', 19);
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user'),
        count: 20,
      }),
    );
  });

  it('refuses the twenty-first', async () => {
    await seedQuota('pro-user', 20);
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user'),
        count: 21,
      }),
    );
  });

  it('refuses a question whose batch leaves the counter out entirely', async () => {
    // The whole reason the counter is read with getAfter rather than get: a
    // client that simply declines to increment must not get a free write.
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user'),
        withQuota: false,
      }),
    );
  });

  it('refuses a question billed to someone else’s counter', async () => {
    await seedQuota('other-user', 1);
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user'),
        quotaOwner: 'other-user',
        count: 2,
      }),
    );
  });

  it('refuses a counter that stands still instead of incrementing', async () => {
    await seedQuota('pro-user', 5);
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user'),
        count: 5,
      }),
    );
  });

  it('refuses a counter that walks itself back down', async () => {
    await seedQuota('pro-user', 10);
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user'),
        count: 1,
      }),
    );
  });

  it('refuses a first submission that starts the counter above 1', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user'),
        count: 0,
      }),
    );
  });

  it('refuses deleting the counter, which would reset the hour', async () => {
    await seedQuota('pro-user', 20);
    await assertFails(deleteDoc(quota(asPro(env, 'pro-user'), 'pro-user')));
  });

  it('refuses a counter carrying any key but count', async () => {
    await assertFails(
      setDoc(quota(asPro(env, 'pro-user'), 'pro-user'), { count: 1, bypass: true }),
    );
  });

  it('refuses a counter written under a window that is not now', async () => {
    // The ID is what scopes the cap to an hour. A client that picks its own
    // window could mint a fresh allowance whenever it liked.
    const nextHour = String(Math.floor(Date.now() / 3_600_000) + 1);
    await assertFails(
      setDoc(
        doc(asPro(env, 'pro-user').firestore(), 'custom_question_quota', `${nextHour}-pro-user`),
        {
          count: 1,
        },
      ),
    );
  });

  it('lets an owner read their own counter, so a refusal can be explained honestly', async () => {
    await seedQuota('pro-user', 20);
    await assertSucceeds(getDoc(quota(asPro(env, 'pro-user'), 'pro-user')));
  });

  it('does not let one subscriber read another’s counter', async () => {
    await seedQuota('other-user', 3);
    await assertFails(getDoc(quota(asPro(env, 'pro-user'), 'other-user')));
  });

  it('gives the next hour a fresh allowance, because the ID changes', async () => {
    // Not a clock trick: a previous hour's exhausted counter is a different
    // document, so it cannot constrain this hour.
    const lastHour = String(Math.floor(Date.now() / 3_600_000) - 1);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'custom_question_quota', `${lastHour}-pro-user`), {
        count: 20,
      });
    });
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user'),
      }),
    );
  });
});
