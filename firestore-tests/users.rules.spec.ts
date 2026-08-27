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
  createTestEnv,
} from './helpers';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnv('demo-rules-users');
});
afterAll(() => env.cleanup());

const OWNER = 'owner-uid';
const OTHER = 'other-uid';

/**
 * The document as `recordGameResult` writes it. Seeded with rules disabled,
 * which is the only way it can exist at all — that is the collection's design
 * rather than a testing shortcut, and it is why there is no create/update
 * accept case anywhere below.
 */
const STATS = {
  gamesPlayed: 12,
  questionsAnswered: 120,
  correctAnswers: 84,
  bestStreak: 9,
  lastGameId: 'game-abc',
  statsSince: 1_756_000_000_000,
  updatedAt: 1_756_300_000_000,
  rateWindowStart: 1_756_299_600_000,
  gamesInWindow: 3,
};

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', OWNER), STATS);
    await setDoc(doc(ctx.firestore(), 'users', OTHER), { ...STATS, gamesPlayed: 3 });
  });
});

const statsRef = (ctx: RulesTestContext, uid: string) => doc(ctx.firestore(), 'users', uid);
const users = (ctx: RulesTestContext) => collection(ctx.firestore(), 'users');

describe('users: get — you may read your own totals', () => {
  it('allows the owner to read their own document', async () => {
    await assertSucceeds(getDoc(statsRef(asVerifiedPassword(env, OWNER), OWNER)));
  });

  /**
   * The accept case that stops the rule failing 100% closed. `CLAUDE.md` §4.6:
   * a suite of nothing but reject cases passes against a rule that denies
   * everything, and `string(math.floor(x))` shipped exactly that once.
   *
   * A signed-in account with **no** document is a first-class state, not an
   * error — the document is created lazily on the first completed game, so
   * every reader has to treat absent as valid. A `get` on a missing document
   * must be *allowed* and return nothing, rather than being denied.
   */
  it('allows the owner to read a document that does not exist yet', async () => {
    await assertSucceeds(
      getDoc(statsRef(asVerifiedPassword(env, 'never-played-uid'), 'never-played-uid')),
    );
  });

  // An anonymous session never has a document — the callable refuses to create
  // one — but the *rule* still has to let it look, because narrowing to
  // `isRealAuthedUser()` would add a second condition that stays in step with
  // nothing. What it must never do is reach somebody else's, which is the row
  // below this one.
  it('allows an anonymous session to read its own (absent) document', async () => {
    await assertSucceeds(getDoc(statsRef(asAnonymous(env, 'anon-uid'), 'anon-uid')));
  });

  // Unverified and OAuth accounts own their history exactly as much as a
  // verified one. Pinned because the obvious "harden it" edit is to swap
  // `request.auth != null` for `isRealAuthedUser()`, and these are the rows
  // that would go red if someone did.
  it('allows an unverified password account to read its own document', async () => {
    await assertSucceeds(
      getDoc(statsRef(asUnverifiedPassword(env, 'unverified-uid'), 'unverified-uid')),
    );
  });

  it('allows an OAuth account to read its own document', async () => {
    await assertSucceeds(getDoc(statsRef(asOAuth(env, 'oauth-uid'), 'oauth-uid')));
  });

  /**
   * A Pro subscriber reading their own document. Low value against today's
   * rule — `asPro` and `asVerifiedPassword` are indistinguishable to it — and
   * it is here for the day somebody "optimises" the read gate behind
   * `isProUser()`. The Pro *reject-write* row below forecloses that failure in
   * one direction; this one forecloses it in the other.
   */
  it('allows a Pro subscriber to read their own document', async () => {
    await assertSucceeds(getDoc(statsRef(asPro(env, 'pro-uid'), 'pro-uid')));
  });

  it("denies reading another account's document", async () => {
    await assertFails(getDoc(statsRef(asVerifiedPassword(env, OWNER), OTHER)));
  });

  it('denies a signed-out caller', async () => {
    await assertFails(getDoc(statsRef(asSignedOut(env), OWNER)));
  });

  it("denies an anonymous session reading a real account's document", async () => {
    await assertFails(getDoc(statsRef(asAnonymous(env, 'anon-uid'), OWNER)));
  });
});

describe('users: list — the collection is never enumerable', () => {
  it('denies an unfiltered list', async () => {
    await assertFails(getDocs(users(asVerifiedPassword(env, OWNER))));
  });

  /**
   * **The entire content of the `allow list: if false` line, and the only test
   * that can prove it.**
   *
   * Replace `allow get` + `allow list: if false` with a single
   * `allow read: if request.auth.uid == uid` and every other row in this file
   * still passes — the unfiltered list above included, because Firestore
   * cannot prove the wildcard matches every document such a query would
   * return, so it denies either way. A query constrained to
   * `documentId() == <own uid>` is the one shape it *can* prove: the broken
   * rule serves it, this rule refuses it. Measured on `user_roles`, where the
   * same mutation scored exactly one failure and it was this row.
   */
  it('denies a query filtered to the caller own document id', async () => {
    await assertFails(
      getDocs(query(users(asVerifiedPassword(env, OWNER)), where(documentId(), '==', OWNER))),
    );
  });

  // The query someone reaches for when they want a leaderboard of lifetime
  // totals — which is precisely what this collection must never be, since it
  // would rank every account that has ever finished a game.
  it('denies a query ordered by a stats field', async () => {
    await assertFails(
      getDocs(query(users(asVerifiedPassword(env, OWNER)), where('gamesPlayed', '>', 0))),
    );
  });
});

describe('users: write — every write is out of band', () => {
  /**
   * **This is the line that keeps the schema growable**, so it gets the most
   * rows. `CLAUDE.md` §4.2: a document has no `hasOnly()` allowlist to widen
   * later *only* while it stays free of any client write path. The moment one
   * of these turns green, adding a field later stops being free.
   *
   * Note what these rows do and do not prove. `allow create, update, delete:
   * if false` is semantically identical to omitting the line — deleting it
   * scores zero failures here, because default-deny produces the same
   * behaviour. The line is documentation. What these rows actually catch is
   * somebody *widening* it to `request.auth.uid == uid`, which is the edit a
   * future feature will be tempted to make.
   */
  it('denies the owner creating their own document', async () => {
    await assertFails(
      setDoc(statsRef(asVerifiedPassword(env, 'new-uid'), 'new-uid'), {
        gamesPlayed: 1,
        questionsAnswered: 10,
        correctAnswers: 10,
        bestStreak: 10,
        lastGameId: 'g1',
        statsSince: 1_756_000_000_000,
        updatedAt: 1_756_000_000_000,
        rateWindowStart: 1_756_000_000_000,
        gamesInWindow: 1,
      }),
    );
  });

  // The one that matters most: a player inflating their own totals. Bounds
  // live in the callable, and there is no rule here that could enforce them —
  // which is exactly why there is no write path.
  it('denies the owner updating their own totals', async () => {
    await assertFails(
      updateDoc(statsRef(asVerifiedPassword(env, OWNER), OWNER), { gamesPlayed: 9999 }),
    );
  });

  /**
   * **The extensibility tripwire.** A future PR that gives this collection a
   * client write path has to make one of these rows go red — there is no way
   * to add `allow update` without it. That is the whole protection: the door
   * cannot be opened quietly.
   *
   * Adding an *unrecognised* key is the specific shape worth its own row,
   * because it is what a `hasOnly()` allowlist would exist to refuse. Today it
   * is refused for a stronger reason — nothing may write at all — and this row
   * says so, so the day someone adds an allowlist they have to come here and
   * decide deliberately.
   */
  it('denies the owner adding a field nobody has allowlisted', async () => {
    await assertFails(updateDoc(statsRef(asVerifiedPassword(env, OWNER), OWNER), { xp: 400 }));
  });

  it('denies the owner deleting their own document', async () => {
    await assertFails(deleteDoc(statsRef(asVerifiedPassword(env, OWNER), OWNER)));
  });

  it("denies writing to another account's document", async () => {
    await assertFails(
      updateDoc(statsRef(asVerifiedPassword(env, OWNER), OTHER), { gamesPlayed: 0 }),
    );
  });

  // Paying does not buy a write path. Pinned because "Pro subscribers can edit
  // their own profile" is a plausible-sounding future ask, and the answer has
  // to be a Cloud Function rather than a rules widening.
  it('denies a Pro subscriber writing their own document', async () => {
    await assertFails(updateDoc(statsRef(asPro(env, 'pro-uid'), 'pro-uid'), { gamesPlayed: 100 }));
  });

  it('denies a signed-out caller writing anything', async () => {
    await assertFails(setDoc(statsRef(asSignedOut(env), OWNER), { gamesPlayed: 1 }));
  });
});

describe('users: schema — deliberately unconstrained', () => {
  /**
   * There is no `hasOnly()` allowlist and there must not be one, so a document
   * carrying fields this build has never heard of is **valid** and readable.
   * That is the property `growth` depends on: `xp`, `region` and an avatar map
   * can be added by a future Cloud Function with no rules deploy, no
   * migration, and no stale-client window.
   *
   * This is an accept case on the *read* rule, which is the only rule this
   * collection has. It cannot fail on account of a write-side allowlist —
   * nothing here evaluates `request.resource.data`. What makes the door hard
   * to close is the reject rows above, not this one; this row proves the other
   * half, that an unknown-shaped document is still servable.
   */
  it('serves a document carrying fields this build does not know about', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', 'future-uid'), {
        ...STATS,
        xp: 400,
        level: 7,
        region: 'BR',
        avatar: { hat: 'crown', frame: 'gold' },
      });
    });

    await assertSucceeds(getDoc(statsRef(asVerifiedPassword(env, 'future-uid'), 'future-uid')));
  });
});
