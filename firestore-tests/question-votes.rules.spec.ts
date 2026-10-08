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
  documentId,
  getDoc,
  getDocs,
  limit,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  asAnonymous,
  asOAuth,
  asSignedOut,
  asUnverifiedPassword,
  asVerifiedPassword,
  createTestEnv,
  questionVoteId,
  validVote,
} from './helpers';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnv('demo-rules-question-votes');
});
afterAll(() => env.cleanup());

const OWNER = 'owner';
const OTHER = 'other';
const ANON = 'anon';
const UNVERIFIED = 'unverified';
/**
 * Another account whose uid **begins with OWNER's**. `OTHER` shares no prefix
 * with `OWNER`, so it cannot tell `isOwnQuestionVoteId()` comparing
 * `uid + '_'` from comparing the bare uid — and only the first keeps `owner`
 * out of the votes of `owner2`, whose ids all start with `owner`. Firebase
 * mints uids of one length, which is why this never arises in practice, but
 * nothing in the rules leans on that: the underscore is the whole boundary,
 * and the rows that use this uid are what fail if it is dropped.
 */
const OWNER_PREFIXED = `${OWNER}2`;

const QUESTION_ID = 'voted-question';
const SECOND_QUESTION_ID = 'second-question';
// Firestore accepts document ids well past the 128-character bound, so an
// oversized-but-real question isolates the size clause from `exists()`.
const LONG_QUESTION_ID = 'q'.repeat(129);
const LONGEST_QUESTION_ID = 'q'.repeat(128);

/**
 * `exists()` on create makes a seeded question the precondition for every
 * accept case — without it a *valid* vote is refused for naming a question
 * that is not there, and each test would pass for the wrong reason.
 */
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const question = {
      category: 'Science',
      type: 'multiple',
      difficulty: 'easy',
      question: 'What is the chemical symbol for water?',
      correct_answer: 'H2O',
      incorrect_answers: ['CO2', 'O2', 'NaCl'],
      status: 'approved',
    };
    for (const id of [QUESTION_ID, SECOND_QUESTION_ID, LONG_QUESTION_ID, LONGEST_QUESTION_ID]) {
      await setDoc(doc(ctx.firestore(), 'custom_questions', id), question);
    }
  });
});

const voteRef = (ctx: RulesTestContext, id: string) => doc(ctx.firestore(), 'question_votes', id);

/** A vote written with rules disabled — the only way to stand one up for an account that may not write it. */
async function seedVote(uid: string, questionId: string, value = 1, createdAt = Date.now()) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'question_votes', questionVoteId(uid, questionId)), {
      questionId,
      value,
      createdAt,
    });
  });
}

describe('question_votes: create — who may vote', () => {
  // The accept cases first: a suite of nothing but `assertFails` passes
  // against a rule that refuses everybody (`CLAUDE.md` §4.6).
  it('allows a verified password account', async () => {
    await assertSucceeds(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)),
        validVote(QUESTION_ID),
      ),
    );
  });

  it('allows an OAuth account', async () => {
    await assertSucceeds(
      setDoc(
        voteRef(asOAuth(env, OWNER), questionVoteId(OWNER, QUESTION_ID)),
        validVote(QUESTION_ID),
      ),
    );
  });

  // Decision 1. An anonymous account is free to mint, so an anonymous vote is
  // free to farm — the app opens the sign-in menu instead of writing, and this
  // is the half of that decision the app cannot be trusted with.
  it('rejects an anonymous session', async () => {
    await assertFails(
      setDoc(
        voteRef(asAnonymous(env, ANON), questionVoteId(ANON, QUESTION_ID)),
        validVote(QUESTION_ID),
      ),
    );
  });

  it('rejects an unverified password account', async () => {
    await assertFails(
      setDoc(
        voteRef(asUnverifiedPassword(env, UNVERIFIED), questionVoteId(UNVERIFIED, QUESTION_ID)),
        validVote(QUESTION_ID),
      ),
    );
  });

  it('rejects a signed-out caller', async () => {
    await assertFails(
      setDoc(voteRef(asSignedOut(env), questionVoteId(OWNER, QUESTION_ID)), validVote(QUESTION_ID)),
    );
  });
});

describe('question_votes: create — the id is the pair', () => {
  // Without the suffix half of the id check, a caller writes question A's vote
  // into the document for question B — and the one-vote-per-pair guarantee the
  // id exists for stops meaning anything.
  it('rejects a questionId that disagrees with the document id', async () => {
    await assertFails(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, SECOND_QUESTION_ID)),
        validVote(QUESTION_ID),
      ),
    );
  });

  // The prefix half: the uid in the id is the ownership check.
  it("rejects a vote filed under another account's uid", async () => {
    await assertFails(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OTHER, QUESTION_ID)),
        validVote(QUESTION_ID),
      ),
    );
  });

  it('rejects an id with no uid in it at all', async () => {
    await assertFails(
      setDoc(voteRef(asVerifiedPassword(env, OWNER), QUESTION_ID), validVote(QUESTION_ID)),
    );
  });
});

describe('question_votes: create — schema', () => {
  it('accepts a dislike as well as a like', async () => {
    await assertSucceeds(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)),
        validVote(QUESTION_ID, { value: -1 }),
      ),
    );
  });

  // `in [1, -1]` is the type check as well as the range: none of these is in
  // the list, whatever its type.
  for (const [label, value] of [
    ['zero', 0],
    ['two', 2],
    ['a string', '1'],
    ['a boolean', true],
    ['a fraction', 0.5],
  ] as const) {
    it(`rejects a value of ${label}`, async () => {
      await assertFails(
        setDoc(
          voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)),
          validVote(QUESTION_ID, { value }),
        ),
      );
    });
  }

  it('rejects an undeclared extra key', async () => {
    await assertFails(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)),
        validVote(QUESTION_ID, { uid: OWNER }),
      ),
    );
  });

  // The plausible one: a field somebody adds on purpose to record when a mind
  // was changed. The allowlist is three keys, and widening it is a decision.
  it('rejects an updatedAt alongside the three keys', async () => {
    await assertFails(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)),
        validVote(QUESTION_ID, { updatedAt: Date.now() }),
      ),
    );
  });

  it('rejects a vote with no value', async () => {
    await assertFails(
      setDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)), {
        questionId: QUESTION_ID,
        createdAt: Date.now(),
      }),
    );
  });

  it('rejects a vote with no createdAt', async () => {
    await assertFails(
      setDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)), {
        questionId: QUESTION_ID,
        value: 1,
      }),
    );
  });

  it('rejects a backdated createdAt', async () => {
    await assertFails(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)),
        validVote(QUESTION_ID, { createdAt: Date.now() - 600_000 }),
      ),
    );
  });

  it('rejects a future-dated createdAt', async () => {
    await assertFails(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)),
        validVote(QUESTION_ID, { createdAt: Date.now() + 120_000 }),
      ),
    );
  });

  it('rejects a vote on a question that does not exist', async () => {
    await assertFails(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, 'no-such-question')),
        validVote('no-such-question'),
      ),
    );
  });

  // The same clause from the other side: a question its author has withdrawn
  // since it was served takes no new votes, though one already cast can still
  // be changed (the update rule has no `exists()`).
  it('rejects a first vote on a question withdrawn since it was served', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'custom_questions', SECOND_QUESTION_ID));
    });
    await assertFails(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, SECOND_QUESTION_ID)),
        validVote(SECOND_QUESTION_ID),
      ),
    );
  });

  it('accepts a questionId of exactly 128 characters', async () => {
    await assertSucceeds(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, LONGEST_QUESTION_ID)),
        validVote(LONGEST_QUESTION_ID),
      ),
    );
  });

  it('rejects a questionId over 128 characters even when the question exists', async () => {
    await assertFails(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, LONG_QUESTION_ID)),
        validVote(LONG_QUESTION_ID),
      ),
    );
  });

  // There is no `is string` clause, and this row is why none is needed: a
  // number cannot be concatenated into the id the rule compares against.
  it('rejects a questionId that is not a string', async () => {
    await assertFails(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, '42')),
        validVote('42', { questionId: 42 }),
      ),
    );
  });
});

describe('question_votes: update — changing one’s mind', () => {
  const firstVoteAt = Date.now() - 86_400_000;

  beforeEach(async () => {
    await seedVote(OWNER, QUESTION_ID, 1, firstVoteAt);
  });

  it('lets the owner turn a like into a dislike', async () => {
    await assertSucceeds(
      updateDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)), {
        value: -1,
      }),
    );
  });

  // An idempotent retry: the client cannot always know whether a write that
  // timed out landed, and repeating it must not be refused.
  it('accepts a write of the value already stored', async () => {
    await assertSucceeds(
      updateDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)), {
        value: 1,
      }),
    );
  });

  // No `exists()` on update, deliberately: an author withdrawing a question
  // must not freeze everybody's vote on it.
  it('lets the owner change a vote on a question that has since been withdrawn', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'custom_questions', QUESTION_ID));
    });
    await assertSucceeds(
      updateDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)), {
        value: -1,
      }),
    );
  });

  it('rejects a value outside the two', async () => {
    await assertFails(
      updateDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)), {
        value: 0,
      }),
    );
  });

  // A heavier vote is the edit a "super-like" would be tempted to make.
  it('rejects a value of two', async () => {
    await assertFails(
      updateDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)), {
        value: 2,
      }),
    );
  });

  // `createdAt` is the time of the first vote, and only `value` may move.
  // This is also the shape the app's create would take against a vote it did
  // not know was there — which is why `setQuestionVote` falls back to an
  // update of the value alone when a create is refused.
  it('rejects a rewrite that moves the time of the first vote', async () => {
    await assertFails(
      setDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)),
        validVote(QUESTION_ID, { value: -1 }),
      ),
    );
  });

  it('rejects rewriting which question the vote is about', async () => {
    await assertFails(
      updateDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)), {
        questionId: SECOND_QUESTION_ID,
      }),
    );
  });

  it('rejects adding a key', async () => {
    await assertFails(
      updateDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID)), {
        weight: 3,
      }),
    );
  });

  it("rejects another account changing somebody else's vote", async () => {
    await assertFails(
      updateDoc(voteRef(asVerifiedPassword(env, OTHER), questionVoteId(OWNER, QUESTION_ID)), {
        value: -1,
      }),
    );
  });

  // Even a write that would change nothing: the idempotent-retry allowance is
  // the owner's, and a no-op is still a write to somebody else's document.
  it("rejects another account writing the value somebody else's vote already holds", async () => {
    await assertFails(
      updateDoc(voteRef(asVerifiedPassword(env, OTHER), questionVoteId(OWNER, QUESTION_ID)), {
        value: 1,
      }),
    );
  });

  it('rejects an account changing the vote of one whose uid begins with its own', async () => {
    await seedVote(OWNER_PREFIXED, QUESTION_ID);
    await assertFails(
      updateDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER_PREFIXED, QUESTION_ID)),
        { value: -1 },
      ),
    );
  });

  // Seeded under the anonymous uid, so the only thing standing between the
  // session and the write is the real-account gate.
  it('rejects an anonymous session changing a vote under its own uid', async () => {
    await seedVote(ANON, QUESTION_ID);
    await assertFails(
      updateDoc(voteRef(asAnonymous(env, ANON), questionVoteId(ANON, QUESTION_ID)), {
        value: -1,
      }),
    );
  });

  it('rejects an unverified account changing a vote under its own uid', async () => {
    await seedVote(UNVERIFIED, QUESTION_ID);
    await assertFails(
      updateDoc(
        voteRef(asUnverifiedPassword(env, UNVERIFIED), questionVoteId(UNVERIFIED, QUESTION_ID)),
        { value: -1 },
      ),
    );
  });
});

describe('question_votes: delete — tapping it again', () => {
  beforeEach(async () => {
    await seedVote(OWNER, QUESTION_ID);
  });

  it('lets the owner remove their vote', async () => {
    await assertSucceeds(
      deleteDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID))),
    );
  });

  // A retried removal, or two taps that crossed: the work is already done, and
  // reporting a failure for it would be telling the player something false.
  it('lets the owner remove a vote that is not there', async () => {
    await assertSucceeds(
      deleteDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, SECOND_QUESTION_ID))),
    );
  });

  it("rejects another account removing somebody else's vote", async () => {
    await assertFails(
      deleteDoc(voteRef(asVerifiedPassword(env, OTHER), questionVoteId(OWNER, QUESTION_ID))),
    );
  });

  // Ownership is a property of the id, not of a document being there — so a
  // stranger is refused before Firestore would have found there was nothing
  // to delete, and cannot use removals to probe somebody else's votes.
  it("rejects another account removing a vote of somebody else's that was never cast", async () => {
    await assertFails(
      deleteDoc(voteRef(asVerifiedPassword(env, OTHER), questionVoteId(OWNER, SECOND_QUESTION_ID))),
    );
  });

  it('rejects an account removing the vote of one whose uid begins with its own', async () => {
    await seedVote(OWNER_PREFIXED, QUESTION_ID);
    await assertFails(
      deleteDoc(
        voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER_PREFIXED, QUESTION_ID)),
      ),
    );
  });

  it('rejects an anonymous session removing a vote under its own uid', async () => {
    await seedVote(ANON, QUESTION_ID);
    await assertFails(
      deleteDoc(voteRef(asAnonymous(env, ANON), questionVoteId(ANON, QUESTION_ID))),
    );
  });

  it('rejects an unverified account removing a vote under its own uid', async () => {
    await seedVote(UNVERIFIED, QUESTION_ID);
    await assertFails(
      deleteDoc(
        voteRef(asUnverifiedPassword(env, UNVERIFIED), questionVoteId(UNVERIFIED, QUESTION_ID)),
      ),
    );
  });

  it('rejects a signed-out caller', async () => {
    await assertFails(deleteDoc(voteRef(asSignedOut(env), questionVoteId(OWNER, QUESTION_ID))));
  });
});

/**
 * The caller's own votes for a game's questions, as `FirebaseService
 * .getOwnQuestionVotes` asks for them — **the same query, field for field**:
 * their own ids, named, in one `IN`, with a `limit`. The bound is in the query
 * because the client puts it there; rules are handed the shape of a query and
 * never its `limit`, so nothing below would change without it.
 */
const ownVotesQuery = (ctx: RulesTestContext, ids: string[]) =>
  query(
    collection(ctx.firestore(), 'question_votes'),
    where(documentId(), 'in', ids),
    limit(ids.length),
  );

describe('question_votes: read — the owner, and nobody else', () => {
  beforeEach(async () => {
    await seedVote(OWNER, QUESTION_ID, 1);
    await seedVote(OWNER, SECOND_QUESTION_ID, -1);
    await seedVote(OTHER, QUESTION_ID, -1);
  });

  it('lets the owner get their own vote', async () => {
    await assertSucceeds(
      getDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, QUESTION_ID))),
    );
  });

  // A question the player has not voted on is the normal case, and a `get` of
  // it has to answer "nothing" rather than be refused.
  it('lets the owner get a vote they have not cast', async () => {
    await assertSucceeds(
      getDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER, 'never-voted'))),
    );
  });

  /**
   * **The load-bearing accept row for `list`.** The rule depends on the
   * document id, so Firestore serves a query only when it can prove every id
   * the query could return is the caller's — which a query that names its ids
   * lets it do. If this row goes red, the app's one read is refused, and every
   * vote renders as un-cast.
   */
  it("serves the app's query: the caller's own ids, named, in one IN", async () => {
    await assertSucceeds(
      getDocs(
        ownVotesQuery(asVerifiedPassword(env, OWNER), [
          questionVoteId(OWNER, QUESTION_ID),
          questionVoteId(OWNER, SECOND_QUESTION_ID),
          questionVoteId(OWNER, 'never-voted'),
        ]),
      ),
    );
  });

  it('serves a query constrained to one of the caller’s own ids', async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(asVerifiedPassword(env, OWNER).firestore(), 'question_votes'),
          where(documentId(), '==', questionVoteId(OWNER, QUESTION_ID)),
        ),
      ),
    );
  });

  // Rules are not filters: one foreign id refuses the whole query rather than
  // quietly dropping the row that is not the caller's.
  it("refuses an IN query that names somebody else's id among the caller's own", async () => {
    await assertFails(
      getDocs(
        ownVotesQuery(asVerifiedPassword(env, OWNER), [
          questionVoteId(OWNER, QUESTION_ID),
          questionVoteId(OTHER, QUESTION_ID),
        ]),
      ),
    );
  });

  it('refuses an unfiltered list, even to an account that holds votes', async () => {
    await assertFails(
      getDocs(collection(asVerifiedPassword(env, OWNER).firestore(), 'question_votes')),
    );
  });

  // The query a recommender reaching for "every vote on this question" would
  // write — which is exactly the aggregate this feature does not build.
  it('refuses a query for every vote on one question', async () => {
    await assertFails(
      getDocs(
        query(
          collection(asVerifiedPassword(env, OWNER).firestore(), 'question_votes'),
          where('questionId', '==', QUESTION_ID),
        ),
      ),
    );
  });

  it("refuses another account reading somebody else's vote", async () => {
    await assertFails(
      getDoc(voteRef(asVerifiedPassword(env, OTHER), questionVoteId(OWNER, QUESTION_ID))),
    );
  });

  it('refuses an account reading the vote of one whose uid begins with its own', async () => {
    await seedVote(OWNER_PREFIXED, QUESTION_ID);
    await assertFails(
      getDoc(voteRef(asVerifiedPassword(env, OWNER), questionVoteId(OWNER_PREFIXED, QUESTION_ID))),
    );
  });

  // The same boundary in the shape the app reads with, so a query cannot
  // reach what a `get` cannot.
  it('refuses an IN query that names the vote of one whose uid begins with the caller’s', async () => {
    await seedVote(OWNER_PREFIXED, QUESTION_ID);
    await assertFails(
      getDocs(
        ownVotesQuery(asVerifiedPassword(env, OWNER), [
          questionVoteId(OWNER, QUESTION_ID),
          questionVoteId(OWNER_PREFIXED, QUESTION_ID),
        ]),
      ),
    );
  });

  it('refuses an anonymous session, even under its own uid', async () => {
    await assertFails(getDoc(voteRef(asAnonymous(env, ANON), questionVoteId(ANON, QUESTION_ID))));
  });

  it('refuses an unverified account reading a vote under its own uid', async () => {
    await seedVote(UNVERIFIED, QUESTION_ID);
    await assertFails(
      getDoc(
        voteRef(asUnverifiedPassword(env, UNVERIFIED), questionVoteId(UNVERIFIED, QUESTION_ID)),
      ),
    );
  });

  it('refuses a signed-out caller', async () => {
    await assertFails(getDoc(voteRef(asSignedOut(env), questionVoteId(OWNER, QUESTION_ID))));
  });
});
