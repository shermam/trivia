import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  deleteField,
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

/**
 * `FEAT-022`. Three optional fields a contributor may attach: where the
 * question came from (`sourceUrl`, `sourceTitle`) and why its answers are what
 * they are (`explanation`, rendered as **Justification**). Both directions,
 * because a suite of nothing but `assertFails` passes against a rule that
 * denies everything (`CLAUDE.md` §4.6).
 *
 * The accept cases are the load-bearing ones here: the whole feature is
 * optional fields, so a rule that refused them all would look exactly like a
 * rule that worked, on every question written so far.
 */
describe('custom_questions: contributor attribution (FEAT-022)', () => {
  it('accepts a question with no source at all — the normal case', async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro'), { uid: 'pro', payload: validQuestion('pro') }),
    );
  });

  it('accepts an https source with a title', async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', {
          sourceUrl: 'https://en.wikipedia.org/wiki/Water',
          sourceTitle: 'Water — Wikipedia',
        }),
      }),
    );
  });

  it('accepts a url with no title', async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { sourceUrl: 'https://example.org/a' }),
      }),
    );
  });

  /** A book or a printed edition has a citation and no link. */
  it('accepts a title with no url', async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { sourceTitle: 'CRC Handbook, 95th ed.' }),
      }),
    );
  });

  it('refuses http, which the CSP would not load anyway', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { sourceUrl: 'http://example.org/a' }),
      }),
    );
  });

  it('refuses a scheme that only looks like https', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { sourceUrl: 'javascript:https://x' }),
      }),
    );
  });

  it('refuses a bare scheme with nothing after it', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { sourceUrl: 'https://' }),
      }),
    );
  });

  it('refuses an over-long url', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { sourceUrl: `https://e.org/${'a'.repeat(500)}` }),
      }),
    );
  });

  it('refuses a non-string url', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { sourceUrl: 42 }),
      }),
    );
  });

  it('refuses an empty title', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { sourceTitle: '' }),
      }),
    );
  });

  it('refuses an over-long title', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { sourceTitle: 'x'.repeat(201) }),
      }),
    );
  });

  /**
   * **The regression that matters.** Widening the create allowlist must not
   * widen what a reviewer may rewrite on somebody else's question — the update
   * rule is `hasOnly(['status'])` and adding a field to `create` would sail
   * straight past it if that rule ever loosened.
   */
  it('does not let a reviewer add or change a source', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'custom_questions', 'q1'), validQuestion('author'));
    });
    await grantReviewer(env, 'mod');

    await assertFails(
      updateDoc(question(asVerifiedPassword(env, 'mod'), 'q1'), {
        sourceUrl: 'https://example.org/injected',
      }),
    );
    await assertFails(
      updateDoc(question(asVerifiedPassword(env, 'mod'), 'q1'), {
        status: 'approved',
        sourceUrl: 'https://example.org/injected',
      }),
    );
  });

  it('accepts a justification on its own, with no source at all', async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', {
          explanation: 'Water is H2O because each molecule bonds two hydrogens to one oxygen.',
        }),
      }),
    );
  });

  it('accepts a justification alongside a source', async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', {
          sourceUrl: 'https://en.wikipedia.org/wiki/Water',
          sourceTitle: 'Water — Wikipedia',
          explanation: 'The distractors are all real molecules, which is what makes it tricky.',
        }),
      }),
    );
  });

  /** A justification is prose, and prose has paragraphs. */
  it('accepts a multi-line justification at the length cap', async () => {
    await assertSucceeds(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { explanation: `a\n${'b'.repeat(998)}` }),
      }),
    );
  });

  it('refuses an empty justification', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { explanation: '' }),
      }),
    );
  });

  it('refuses a justification one character past the cap', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { explanation: 'j'.repeat(1001) }),
      }),
    );
  });

  it('refuses a non-string justification', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro'), {
        uid: 'pro',
        payload: validQuestion('pro', { explanation: { text: 'nope' } }),
      }),
    );
  });

  /**
   * The same regression as the source fields, and the one `FEAT-006` will
   * deliberately reverse when it ships edit-and-approve: **until it does**,
   * widening the create allowlist must not let a reviewer write prose onto
   * somebody else's question while approving it. `hasOnly(['status'])` is the
   * only thing standing between the two.
   */
  it('does not let a reviewer add or change a justification', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'custom_questions', 'q1'), validQuestion('author'));
    });
    await grantReviewer(env, 'mod');

    await assertFails(
      updateDoc(question(asVerifiedPassword(env, 'mod'), 'q1'), {
        explanation: 'Words the author never wrote.',
      }),
    );
    await assertFails(
      updateDoc(question(asVerifiedPassword(env, 'mod'), 'q1'), {
        status: 'approved',
        explanation: 'Words the author never wrote.',
      }),
    );
  });

  /**
   * The author *may* rewrite their own justification and their own source —
   * that is `FEAT-007`, and it is the whole point of `/my-questions`. What was
   * true when these three fields shipped, and is no longer, is that nobody
   * could: `custom_questions` was create-only from the client, so the same
   * write these two rows make was refused for want of any owner rule at all.
   *
   * They stay here rather than moving to the `FEAT-007` block because the
   * subject is these fields: their bounds have to hold on an edit exactly as
   * they do on a create, and the reviewer still may not touch them either way.
   */
  it('lets the author rewrite their own justification after submitting', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'q1'),
        validQuestion('pro', { explanation: 'The original reasoning.' }),
      );
    });

    await assertSucceeds(
      updateDoc(question(asPro(env, 'pro'), 'q1'), { explanation: 'Something else entirely.' }),
    );
  });

  it('lets the author rewrite their own source after submitting', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'q1'),
        validQuestion('pro', { sourceUrl: 'https://example.org/original' }),
      );
    });

    await assertSucceeds(
      updateDoc(question(asPro(env, 'pro'), 'q1'), {
        sourceUrl: 'https://example.org/swapped',
      }),
    );
  });

  // The bounds are the create path's, and the owner rule re-applies them — so
  // an edit cannot smuggle in what a submission could not.
  it('refuses an author editing their source to a non-https one', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'q1'),
        validQuestion('pro', { sourceUrl: 'https://example.org/original' }),
      );
    });

    await assertFails(
      updateDoc(question(asPro(env, 'pro'), 'q1'), { sourceUrl: 'http://example.org/swapped' }),
    );
  });

  it('refuses an author editing their justification past 1000 characters', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'q1'),
        validQuestion('pro', { explanation: 'The original reasoning.' }),
      );
    });

    await assertFails(
      updateDoc(question(asPro(env, 'pro'), 'q1'), { explanation: 'x'.repeat(1001) }),
    );
  });

  it('refuses somebody else rewriting the author justification', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'q1'),
        validQuestion('pro', { explanation: 'The original reasoning.' }),
      );
    });

    await assertFails(
      updateDoc(question(asPro(env, 'stranger'), 'q1'), { explanation: 'Not mine to change.' }),
    );
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

describe('custom_questions: nobody but the author or a reviewer may write', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'custom_questions', 'seeded'), validQuestion('pro-user'));
    });
  });

  it('rejects an update from a Pro subscriber who did not write it', async () => {
    await assertFails(
      setDoc(
        question(asPro(env, 'stranger'), 'seeded'),
        validQuestion('pro-user', { question: 'Edited' }),
      ),
    );
  });

  it('rejects a delete from a Pro subscriber who did not write it', async () => {
    await assertFails(deleteDoc(question(asPro(env, 'stranger'), 'seeded')));
  });
});

/**
 * `FEAT-007`: an author can see their own contributions whatever status they
 * are in — which `/my-questions` cannot render a single row without.
 *
 * **Rules are not filters**, so the shape of the *query* is half the rule. The
 * accept row below sends `where('createdBy','==',uid)`, which is what lets
 * Firestore prove the ownership branch for every document the query could
 * return; the unfiltered row is refused outright rather than narrowed. Both are
 * needed: a suite that only asserts the refusal passes against a rule that
 * denies everything (`CLAUDE.md` §4.6).
 */
describe('custom_questions: an author reads their own, whatever the status (FEAT-007)', () => {
  const AUTHOR = 'author-uid';

  const mine = (ctx: RulesTestContext) => query(questions(ctx), where('createdBy', '==', AUTHOR));

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'mine-pending'),
        validQuestion(AUTHOR, { status: 'pending' }),
      );
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'mine-rejected'),
        validQuestion(AUTHOR, { status: 'rejected', rejectionReason: 'The date is wrong.' }),
      );
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'theirs-pending'),
        validQuestion('somebody-else', { status: 'pending' }),
      );
    });
  });

  it('serves the author their own pending question by id', async () => {
    await assertSucceeds(
      getDoc(doc(asVerifiedPassword(env, AUTHOR).firestore(), 'custom_questions', 'mine-pending')),
    );
  });

  it('serves the author their own rejected question by id', async () => {
    await assertSucceeds(
      getDoc(doc(asVerifiedPassword(env, AUTHOR).firestore(), 'custom_questions', 'mine-rejected')),
    );
  });

  // The query `/my-questions` actually sends. Firestore can prove the ownership
  // branch from the filter, so this is the shape the screen depends on — and
  // the row that fails if the branch is deleted.
  it('serves the query filtered on the author own uid', async () => {
    await assertSucceeds(getDocs(mine(asVerifiedPassword(env, AUTHOR))));
  });

  it('still refuses an unfiltered query from that same author', async () => {
    await assertFails(getDocs(questions(asVerifiedPassword(env, AUTHOR))));
  });

  it('refuses a signed-in stranger reading somebody else pending question', async () => {
    await assertFails(
      getDoc(
        doc(asVerifiedPassword(env, 'stranger').firestore(), 'custom_questions', 'mine-pending'),
      ),
    );
  });

  // The filter names the author, but the *caller* is somebody else — so the
  // branch does not hold and the query is refused. This is the row that would
  // pass if the rule compared the filter against itself rather than against
  // `request.auth.uid`.
  it('refuses a stranger querying for the author uid', async () => {
    await assertFails(getDocs(mine(asVerifiedPassword(env, 'stranger'))));
  });

  it('refuses an anonymous session querying for the author uid', async () => {
    await assertFails(getDocs(mine(asAnonymous(env, 'anon'))));
  });

  it('keeps serving an approved question to everybody', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'live'),
        validQuestion('somebody-else', { status: 'approved' }),
      );
    });
    await assertSucceeds(
      getDocs(query(questions(asSignedOut(env)), where('status', '==', 'approved'))),
    );
  });
});

/**
 * `FEAT-007`: the author may rewrite their own question, and withdraw it.
 *
 * Two populations can never be an owner, and both are here as explicit reject
 * rows because either would otherwise be caught only by a rule that happens to
 * fail for an unrelated reason: a document with **no `createdBy`** (written
 * before A10 — nobody recorded who wrote it) and one carrying the
 * **`[deleted-user]` sentinel** (an author who erased their account, which is
 * exactly what keeps the question alive without the person).
 *
 * The **lapsed-Pro accept case** is the load-bearing one. Creating a question
 * needs the subscription and correcting one does not, so an author whose Pro
 * has gone must still be able to fix their own mistake — and that is the half a
 * suite of `assertFails` cannot see.
 */
describe('custom_questions: the author may edit and withdraw their own (FEAT-007)', () => {
  const AUTHOR = 'author-uid';
  /** Far enough in the past that `isNearRequestTime()` would refuse it on a create. */
  const CREATED_AT = Date.now() - 30 * 24 * 3_600_000;

  /** The whole document as an owner edit sends it: content, `pending`, no reason. */
  function ownerEdit(overrides: Record<string, unknown> = {}) {
    return {
      ...validQuestion(AUTHOR, { status: 'pending', createdAt: CREATED_AT }),
      question: 'A corrected question?',
      ...overrides,
    };
  }

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'mine'),
        validQuestion(AUTHOR, {
          status: 'rejected',
          createdAt: CREATED_AT,
          rejectionReason: 'The date is wrong.',
        }),
      );
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'unattributed'),
        // No `createdBy` at all — the pre-A10 population.
        {
          category: 'Science',
          type: 'multiple',
          difficulty: 'easy',
          question: 'Who wrote this?',
          correct_answer: 'Nobody knows',
          incorrect_answers: ['Somebody', 'Anybody'],
          createdAt: CREATED_AT,
          status: 'approved',
        },
      );
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'orphaned'),
        validQuestion('[deleted-user]', { status: 'approved', createdAt: CREATED_AT }),
      );
    });
  });

  const mine = (ctx: RulesTestContext) => doc(ctx.firestore(), 'custom_questions', 'mine');

  it('lets a Pro author rewrite their own question', async () => {
    await assertSucceeds(setDoc(mine(asPro(env, AUTHOR)), ownerEdit()));
  });

  // The decision this feature turns on: editing is not a Pro entitlement.
  it('lets a lapsed author — no stripeRole at all — rewrite their own question', async () => {
    await assertSucceeds(setDoc(mine(asVerifiedPassword(env, AUTHOR)), ownerEdit()));
  });

  it('lets an author with a role that is not pro rewrite their own question', async () => {
    await assertSucceeds(setDoc(mine(asWrongRole(env, AUTHOR)), ownerEdit()));
  });

  it('lets the author change the optional fields under their existing bounds', async () => {
    await assertSucceeds(
      setDoc(
        mine(asVerifiedPassword(env, AUTHOR)),
        ownerEdit({
          sourceUrl: 'https://example.com/source',
          sourceTitle: 'Example',
          explanation: 'Because the treaty was signed in March.',
        }),
      ),
    );
  });

  it('refuses an edit whose source link is not https', async () => {
    await assertFails(
      setDoc(mine(asVerifiedPassword(env, AUTHOR)), ownerEdit({ sourceUrl: 'http://example.com' })),
    );
  });

  it('refuses an edit that leaves the question text blank', async () => {
    await assertFails(setDoc(mine(asVerifiedPassword(env, AUTHOR)), ownerEdit({ question: '' })));
  });

  it('refuses an edit whose correct answer is also one of the wrong ones', async () => {
    await assertFails(
      setDoc(
        mine(asVerifiedPassword(env, AUTHOR)),
        ownerEdit({ correct_answer: 'CO2', incorrect_answers: ['CO2', 'O2'] }),
      ),
    );
  });

  // `isValidCustomQuestion()` guards creates only, so without the shared shape
  // check on the owner rule an author could write any document they liked.
  it('refuses an edit that introduces a key outside the allowlist', async () => {
    await assertFails(
      setDoc(mine(asVerifiedPassword(env, AUTHOR)), ownerEdit({ approvedBy: AUTHOR })),
    );
  });

  it('refuses an edit that approves the question', async () => {
    await assertFails(
      setDoc(mine(asVerifiedPassword(env, AUTHOR)), ownerEdit({ status: 'approved' })),
    );
  });

  it('refuses an edit that leaves it rejected rather than sending it back for review', async () => {
    await assertFails(
      setDoc(mine(asVerifiedPassword(env, AUTHOR)), ownerEdit({ status: 'rejected' })),
    );
  });

  it('refuses an edit that keeps the reviewer note about the replaced text', async () => {
    await assertFails(
      setDoc(
        mine(asVerifiedPassword(env, AUTHOR)),
        ownerEdit({ rejectionReason: 'The date is wrong.' }),
      ),
    );
  });

  it('refuses an author writing their own rejection reason', async () => {
    await assertFails(
      setDoc(
        mine(asVerifiedPassword(env, AUTHOR)),
        ownerEdit({ rejectionReason: 'I think this is fine actually.' }),
      ),
    );
  });

  it('refuses an edit that rewrites createdBy to somebody else', async () => {
    await assertFails(
      setDoc(mine(asVerifiedPassword(env, AUTHOR)), ownerEdit({ createdBy: 'somebody-else' })),
    );
  });

  it('refuses an edit that backdates or refreshes createdAt', async () => {
    await assertFails(
      setDoc(mine(asVerifiedPassword(env, AUTHOR)), ownerEdit({ createdAt: Date.now() })),
    );
  });

  it('refuses a stranger rewriting somebody else question', async () => {
    await assertFails(
      setDoc(
        doc(asPro(env, 'stranger').firestore(), 'custom_questions', 'mine'),
        ownerEdit({ createdBy: AUTHOR }),
      ),
    );
  });

  // An anonymous session can never be an author — `create` refuses one, so no
  // anonymous uid is ever in `createdBy`. The row that matters is therefore the
  // ordinary one: a guest editing a question they did not write.
  it('refuses an anonymous session editing somebody else question', async () => {
    await assertFails(setDoc(mine(asAnonymous(env, 'anon')), ownerEdit()));
  });

  it('lets the author withdraw their own question', async () => {
    await assertSucceeds(deleteDoc(mine(asVerifiedPassword(env, AUTHOR))));
  });

  it('lets a lapsed author withdraw their own question', async () => {
    await assertSucceeds(deleteDoc(mine(asWrongRole(env, AUTHOR))));
  });

  it('refuses a stranger deleting somebody else question', async () => {
    await assertFails(
      deleteDoc(doc(asPro(env, 'stranger').firestore(), 'custom_questions', 'mine')),
    );
  });

  it('refuses a reviewer deleting a question they did not write', async () => {
    await grantReviewer(env, 'rev');
    await assertFails(
      deleteDoc(doc(asVerifiedPassword(env, 'rev').firestore(), 'custom_questions', 'mine')),
    );
  });

  // The two populations nobody may edit. Both would look like an ordinary
  // ownership miss if the rule merely compared a missing field, so both are
  // asserted from the one direction that could go wrong: a caller whose uid is
  // exactly what the document holds.
  it('refuses an edit of a question with no createdBy at all', async () => {
    await assertFails(
      setDoc(
        doc(asVerifiedPassword(env, AUTHOR).firestore(), 'custom_questions', 'unattributed'),
        ownerEdit(),
      ),
    );
  });

  it('refuses a delete of a question with no createdBy at all', async () => {
    await assertFails(
      deleteDoc(
        doc(asVerifiedPassword(env, AUTHOR).firestore(), 'custom_questions', 'unattributed'),
      ),
    );
  });

  it('refuses an account whose uid is literally [deleted-user] editing the sentinel', async () => {
    await assertFails(
      setDoc(
        doc(asVerifiedPassword(env, '[deleted-user]').firestore(), 'custom_questions', 'orphaned'),
        ownerEdit({ createdBy: '[deleted-user]' }),
      ),
    );
  });

  it('refuses an account whose uid is literally [deleted-user] deleting the sentinel', async () => {
    await assertFails(
      deleteDoc(
        doc(asVerifiedPassword(env, '[deleted-user]').firestore(), 'custom_questions', 'orphaned'),
      ),
    );
  });
});

/**
 * `FEAT-007`: a reviewer may say **why** they rejected a question, and nothing
 * else new.
 *
 * The widening is exactly one key. Everything the `affectedKeys()` allowlist
 * already bought is re-asserted in the block above; what is here is the new
 * clause — a reason may exist only on a rejected document, bounded at 500 — and
 * the two directions that follow from it: approving a rejected question has to
 * clear the note in the same write (a rejection reason on an approved question
 * is a false statement shown to its author), and a reviewer may attach one to a
 * question they have already rejected without pretending to decide it again.
 */
describe('custom_questions: the reviewer rejection reason (FEAT-007)', () => {
  const REVIEWER = 'reviewer-uid';
  const AUTHOR = 'pro-user';

  beforeEach(async () => {
    await grantReviewer(env, REVIEWER);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'q1'),
        validQuestion(AUTHOR, { status: 'pending' }),
      );
      await setDoc(
        doc(ctx.firestore(), 'custom_questions', 'already-rejected'),
        validQuestion(AUTHOR, { status: 'rejected', rejectionReason: 'Too vague.' }),
      );
    });
  });

  const pending = (ctx: RulesTestContext) => doc(ctx.firestore(), 'custom_questions', 'q1');
  const rejected = (ctx: RulesTestContext) =>
    doc(ctx.firestore(), 'custom_questions', 'already-rejected');

  it('lets a reviewer reject with a reason', async () => {
    await assertSucceeds(
      updateDoc(pending(asVerifiedPassword(env, REVIEWER)), {
        status: 'rejected',
        rejectionReason: 'The date is wrong.',
      }),
    );
  });

  it('lets a reviewer reject without one — a reason is optional', async () => {
    await assertSucceeds(
      updateDoc(pending(asVerifiedPassword(env, REVIEWER)), { status: 'rejected' }),
    );
  });

  // Decided rather than inherited: a reviewer who thinks of the wording after
  // rejecting should not have to re-write the status to record it.
  it('lets a reviewer add a reason to a question already rejected', async () => {
    await assertSucceeds(
      updateDoc(rejected(asVerifiedPassword(env, REVIEWER)), {
        rejectionReason: 'The date is wrong, and the source does not say otherwise.',
      }),
    );
  });

  it('lets a reviewer clear a reason while leaving the question rejected', async () => {
    await assertSucceeds(
      updateDoc(rejected(asVerifiedPassword(env, REVIEWER)), { rejectionReason: deleteField() }),
    );
  });

  it('lets a reviewer approve a rejected question by clearing the reason in the same write', async () => {
    await assertSucceeds(
      updateDoc(rejected(asVerifiedPassword(env, REVIEWER)), {
        status: 'approved',
        rejectionReason: deleteField(),
      }),
    );
  });

  // The write the client must not send, and the reason `setQuestionStatus`
  // always puts `rejectionReason` in the update mask: a stale note left on an
  // approved question is a false statement shown to its author.
  it('refuses an approval that leaves the rejection reason standing', async () => {
    await assertFails(
      updateDoc(rejected(asVerifiedPassword(env, REVIEWER)), { status: 'approved' }),
    );
  });

  it('refuses a reason attached to a question being approved', async () => {
    await assertFails(
      updateDoc(pending(asVerifiedPassword(env, REVIEWER)), {
        status: 'approved',
        rejectionReason: 'Approved but here is a note.',
      }),
    );
  });

  it('refuses a reason attached to a question being put back to pending', async () => {
    await assertFails(
      updateDoc(rejected(asVerifiedPassword(env, REVIEWER)), {
        status: 'pending',
        rejectionReason: 'Have another look.',
      }),
    );
  });

  it('refuses an empty reason — "none given" is an absent key', async () => {
    await assertFails(
      updateDoc(pending(asVerifiedPassword(env, REVIEWER)), {
        status: 'rejected',
        rejectionReason: '',
      }),
    );
  });

  it('refuses a reason over 500 characters', async () => {
    await assertFails(
      updateDoc(pending(asVerifiedPassword(env, REVIEWER)), {
        status: 'rejected',
        rejectionReason: 'x'.repeat(501),
      }),
    );
  });

  it('accepts a reason of exactly 500 characters', async () => {
    await assertSucceeds(
      updateDoc(pending(asVerifiedPassword(env, REVIEWER)), {
        status: 'rejected',
        rejectionReason: 'x'.repeat(500),
      }),
    );
  });

  it('refuses a reason that is not a string', async () => {
    await assertFails(
      updateDoc(pending(asVerifiedPassword(env, REVIEWER)), {
        status: 'rejected',
        rejectionReason: 42,
      }),
    );
  });

  it('refuses the author writing a reason on their own question', async () => {
    await assertFails(
      updateDoc(pending(asPro(env, AUTHOR)), {
        status: 'rejected',
        rejectionReason: 'I reject myself.',
      }),
    );
  });

  it('refuses a non-reviewer writing a reason on somebody else question', async () => {
    await assertFails(
      updateDoc(pending(asPro(env, 'stranger')), {
        status: 'rejected',
        rejectionReason: 'Not my call to make.',
      }),
    );
  });

  // The allowlist is still exactly two keys wide.
  it('refuses a reviewer introducing any other field alongside the reason', async () => {
    await assertFails(
      updateDoc(pending(asVerifiedPassword(env, REVIEWER)), {
        status: 'rejected',
        rejectionReason: 'The date is wrong.',
        reviewedBy: REVIEWER,
      }),
    );
  });

  it('refuses a reviewer rewriting the question text alongside the reason', async () => {
    await assertFails(
      updateDoc(pending(asVerifiedPassword(env, REVIEWER)), {
        status: 'rejected',
        rejectionReason: 'The date is wrong.',
        question: 'something the author never wrote',
      }),
    );
  });

  it('refuses a submitter creating a question that already carries a reason', async () => {
    await assertFails(
      submitQuestion(asPro(env, 'pro-user'), {
        uid: 'pro-user',
        payload: validQuestion('pro-user', { rejectionReason: 'Pre-rejected by me.' }),
      }),
    );
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
