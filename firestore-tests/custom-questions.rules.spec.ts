import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
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
  grantReviewer,
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

describe('custom_questions: read — approved is public, the rest is reviewers only', () => {
  const approvedOnly = (ctx: RulesTestContext) =>
    query(questions(ctx), where('status', '==', 'approved'));

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'live'),
        validQuestion('author', { status: 'approved' }),
      );
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'waiting'),
        validQuestion('author', { status: 'pending' }),
      );
    });
  });

  it('serves approved questions to a signed-out visitor — the game must work before anyone signs in', async () => {
    await assertSucceeds(getDocs(approvedOnly(asSignedOut(env))));
  });

  it('serves approved questions to an anonymous player', async () => {
    await assertSucceeds(getDocs(approvedOnly(asAnonymous(env, 'anon'))));
  });

  /**
   * **Rules are not filters.** This is the row that says so, and the reason
   * `getCustomQuestions` started sending the filter a release before this rule
   * started requiring it: an unfiltered query is *refused outright*, not
   * quietly trimmed to the approved subset. A browser cached from before 4b-ii
   * therefore fails here rather than showing fewer questions.
   */
  it('refuses an unfiltered query, rather than trimming it', async () => {
    await assertFails(getDocs(questions(asSignedOut(env))));
  });

  it('refuses a query for pending questions from a player', async () => {
    await assertFails(
      getDocs(query(questions(asAnonymous(env, 'anon')), where('status', '==', 'pending'))),
    );
  });

  it('refuses a direct read of a pending question by id', async () => {
    await assertFails(
      getDoc(doc(asAnonymous(env, 'anon').firestore(), 'custom_questions', 'waiting')),
    );
  });

  it('lets a reviewer read a pending question', async () => {
    await grantReviewer(env, 'rev');
    await assertSucceeds(
      getDoc(doc(asVerifiedPassword(env, 'rev').firestore(), 'custom_questions', 'waiting')),
    );
  });

  it('lets a reviewer run the unfiltered query a player cannot', async () => {
    await grantReviewer(env, 'rev');
    await assertSucceeds(getDocs(questions(asVerifiedPassword(env, 'rev'))));
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

describe('custom_questions: create — the moderation status', () => {
  // The accept case, paired with the rejects below so that changing the value
  // can never be a silent widening: exactly one status is accepted on create
  // and the other two are refused, so a change has to move both halves in the
  // diff. It worked — flipping 'approved' to 'pending' broke twelve tests.
  it("accepts status 'pending', the only value statusOnSubmission() allows", async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { status: 'pending' }),
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

  // **The row that makes review-before-publish real.** A submitter must not be
  // able to approve their own contribution; if this ever passes, the whole
  // feature is decorative.
  it("rejects status 'approved' — a submitter cannot approve their own question", async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { status: 'approved' }),
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

describe('custom_questions: moderation — a reviewer may change the status (item 4b-ii)', () => {
  const REVIEWER = 'reviewer-uid';
  const AUTHOR = 'pro-user';

  beforeEach(async () => {
    await grantReviewer(env, REVIEWER);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'q1'),
        validQuestion(AUTHOR, { status: 'pending' }),
      );
    });
  });

  const question = (ctx: RulesTestContext) => doc(ctx.firestore(), 'custom_questions', 'q1');

  it('lets a reviewer approve a pending question', async () => {
    await assertSucceeds(
      updateDoc(question(asVerifiedPassword(env, REVIEWER)), { status: 'approved' }),
    );
  });

  it('lets a reviewer reject a question', async () => {
    await assertSucceeds(
      updateDoc(question(asVerifiedPassword(env, REVIEWER)), { status: 'rejected' }),
    );
  });

  it('lets a reviewer put a decided question back to pending', async () => {
    await assertSucceeds(
      updateDoc(question(asVerifiedPassword(env, REVIEWER)), { status: 'pending' }),
    );
  });

  // Deliberately allowed. The client cannot always know whether a write that
  // timed out landed, so an idempotent retry must not be refused for writing
  // the value that is already there.
  it('accepts a no-op write of the status already stored', async () => {
    await assertSucceeds(
      updateDoc(question(asVerifiedPassword(env, REVIEWER)), { status: 'pending' }),
    );
  });

  it('refuses a signed-in account with no role document', async () => {
    await assertFails(
      updateDoc(question(asVerifiedPassword(env, 'nobody')), { status: 'approved' }),
    );
  });

  // Pro is a *contributor* entitlement. Paying for the ability to add questions
  // must never imply the ability to approve them — including your own.
  it('refuses a Pro subscriber who is not a reviewer', async () => {
    await assertFails(updateDoc(question(asPro(env, AUTHOR)), { status: 'approved' }));
  });

  it('refuses an account whose role document says reviewer: false', async () => {
    await grantReviewer(env, 'demoted', false);
    await assertFails(
      updateDoc(question(asVerifiedPassword(env, 'demoted')), { status: 'approved' }),
    );
  });

  it('refuses an anonymous caller', async () => {
    await assertFails(updateDoc(question(asAnonymous(env, 'anon')), { status: 'approved' }));
  });

  it('refuses a signed-out caller', async () => {
    await assertFails(updateDoc(question(asSignedOut(env)), { status: 'approved' }));
  });

  it('refuses a status outside the union', async () => {
    await assertFails(updateDoc(question(asVerifiedPassword(env, REVIEWER)), { status: 'banana' }));
  });

  // The four rows below are what `affectedKeys().hasOnly(['status'])` buys, and
  // each is a distinct thing a moderator must not be able to do.
  it('refuses a reviewer rewriting the question text alongside the status', async () => {
    await assertFails(
      updateDoc(question(asVerifiedPassword(env, REVIEWER)), {
        status: 'approved',
        question: 'something the author never wrote',
      }),
    );
  });

  it('refuses a reviewer editing the question text on its own', async () => {
    await assertFails(
      updateDoc(question(asVerifiedPassword(env, REVIEWER)), { question: 'rewritten' }),
    );
  });

  it('refuses a reviewer rewriting createdBy to steal or disown authorship', async () => {
    await assertFails(
      updateDoc(question(asVerifiedPassword(env, REVIEWER)), {
        status: 'approved',
        createdBy: REVIEWER,
      }),
    );
  });

  // `isValidCustomQuestion()` only guards creates, so without the affectedKeys
  // check an update would sail straight past the exact-key allowlist.
  it('refuses a reviewer introducing a field outside the create allowlist', async () => {
    await assertFails(
      updateDoc(question(asVerifiedPassword(env, REVIEWER)), { reviewedBy: REVIEWER }),
    );
  });

  it('refuses a reviewer deleting a question — that is still console-only', async () => {
    await assertFails(deleteDoc(question(asVerifiedPassword(env, REVIEWER))));
  });

  // The register is not self-serve, and this is the row that says so from the
  // side that matters: holding the role does not let you hand it out.
  it('refuses a reviewer granting the role to somebody else', async () => {
    await assertFails(
      setDoc(doc(asVerifiedPassword(env, REVIEWER).firestore(), 'user_roles', 'friend'), {
        reviewer: true,
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
