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
import { asAnonymous, asOAuth, asSignedOut, asVerifiedPassword, createTestEnv } from './helpers';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnv('demo-rules-user-roles');
});
afterAll(() => env.cleanup());

const REVIEWER = 'reviewer-uid';
const DEMOTED = 'demoted-uid';
const PLAIN = 'plain-uid';

/**
 * Three distinct starting states, because the rule under test is about
 * *ownership* and the flag's value must not quietly become part of it:
 * a granted reviewer, an account whose document exists and says `false`, and
 * an account with no document at all. All three own their own path equally.
 *
 * Seeded with rules disabled — which is the only way these documents can
 * exist, and is the point of the collection rather than a testing shortcut.
 */
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'user_roles', REVIEWER), { reviewer: true });
    await setDoc(doc(ctx.firestore(), 'user_roles', DEMOTED), { reviewer: false });
  });
});

const roleRef = (ctx: RulesTestContext, uid: string) => doc(ctx.firestore(), 'user_roles', uid);

describe('user_roles: get — you may read your own document', () => {
  it('allows a reviewer to read their own document', async () => {
    await assertSucceeds(getDoc(roleRef(asVerifiedPassword(env, REVIEWER), REVIEWER)));
  });

  // Ownership, not content. If this ever fails, the rule has grown a
  // condition on the flag's value and the "not a mirror, the predicate
  // itself" property in firestore.rules is no longer true.
  it('allows an account whose document says reviewer: false to read it', async () => {
    await assertSucceeds(getDoc(roleRef(asVerifiedPassword(env, DEMOTED), DEMOTED)));
  });

  // The overwhelmingly common case: nobody has a role document. Reading a
  // path that holds nothing has to be allowed, or the client cannot ask the
  // question at all and has to infer its answer from a failure.
  it('allows an account with no role document to read its own path', async () => {
    await assertSucceeds(getDoc(roleRef(asVerifiedPassword(env, PLAIN), PLAIN)));
  });

  // Deliberate: the gate is `request.auth != null`, not `isRealAuthedUser()`.
  // An anonymous session is handed a uid it does not choose, so it can never
  // name a document a role was granted on. Pinned so that tightening it later
  // is a decision someone makes on purpose rather than by reflex.
  it('allows an anonymous session to read its own (empty) path', async () => {
    await assertSucceeds(getDoc(roleRef(asAnonymous(env, 'anon-uid'), 'anon-uid')));
  });

  it('allows an OAuth account to read its own path', async () => {
    await assertSucceeds(getDoc(roleRef(asOAuth(env, PLAIN), PLAIN)));
  });
});

describe("user_roles: get — you may not read anybody else's", () => {
  it('denies a plain account reading a reviewer document', async () => {
    await assertFails(getDoc(roleRef(asVerifiedPassword(env, PLAIN), REVIEWER)));
  });

  // A reviewer is not privileged *here*. Holding the role grants nothing over
  // the register that grants it.
  it('denies a reviewer reading another account document', async () => {
    await assertFails(getDoc(roleRef(asVerifiedPassword(env, REVIEWER), DEMOTED)));
  });

  it('denies a signed-out caller reading a reviewer document', async () => {
    await assertFails(getDoc(roleRef(asSignedOut(env), REVIEWER)));
  });

  it('denies a signed-out caller reading an empty path', async () => {
    await assertFails(getDoc(roleRef(asSignedOut(env), PLAIN)));
  });
});

describe('user_roles: list — the register is never enumerable', () => {
  const roles = (ctx: RulesTestContext) => collection(ctx.firestore(), 'user_roles');

  // Who moderates is not public. This is the rule `allow read` would have
  // silently granted, which is why the file spells out `get` and `list`
  // separately.
  it('denies a plain account listing the collection', async () => {
    await assertFails(getDocs(query(roles(asVerifiedPassword(env, PLAIN)))));
  });

  it('denies a reviewer listing the collection', async () => {
    await assertFails(getDocs(query(roles(asVerifiedPassword(env, REVIEWER)))));
  });

  it('denies a signed-out caller listing the collection', async () => {
    await assertFails(getDocs(query(roles(asSignedOut(env)))));
  });

  /**
   * **Do not delete this as redundant with the row above it.** It is the only
   * test in this file that catches the mistake most likely to actually be
   * made: writing `allow read: if request.auth.uid == uid` and dropping the
   * separate `allow list`.
   *
   * Under that rule the *unfiltered* list is still denied — Firestore cannot
   * prove the wildcard matches every document it would return — so every
   * other test here keeps passing and the suite looks like it covers the
   * `get`/`list` distinction while covering nothing. A query constrained to
   * `documentId() == <own uid>` is the one shape Firestore *can* prove, so it
   * succeeds, and this row is what notices. Measured, not reasoned: the
   * mutation scores 1 failure and this is the one.
   */
  it('denies a query filtered to the caller own document id', async () => {
    await assertFails(
      getDocs(query(roles(asVerifiedPassword(env, REVIEWER)), where(documentId(), '==', REVIEWER))),
    );
  });

  // Filtering on the flag is the query someone reaches for when they want the
  // list of moderators, so it gets its own row.
  it('denies a query filtered to reviewer == true', async () => {
    await assertFails(
      getDocs(query(roles(asVerifiedPassword(env, PLAIN)), where('reviewer', '==', true))),
    );
  });
});

describe('user_roles: write — assignment is out of band', () => {
  // The whole privilege-escalation surface of this design, in one test.
  it('denies an account granting itself the role', async () => {
    await assertFails(setDoc(roleRef(asVerifiedPassword(env, PLAIN), PLAIN), { reviewer: true }));
  });

  it('denies an account granting the role to somebody else', async () => {
    await assertFails(
      setDoc(roleRef(asVerifiedPassword(env, PLAIN), 'someone-else'), { reviewer: true }),
    );
  });

  // A reviewer cannot recruit. This is what makes "there is no admin role
  // yet" a true statement rather than an accidental one: nobody in the
  // register can widen it.
  it('denies a reviewer granting the role to somebody else', async () => {
    await assertFails(
      setDoc(roleRef(asVerifiedPassword(env, REVIEWER), PLAIN), { reviewer: true }),
    );
  });

  it('denies an account whose document says false from flipping it to true', async () => {
    await assertFails(
      updateDoc(roleRef(asVerifiedPassword(env, DEMOTED), DEMOTED), { reviewer: true }),
    );
  });

  it('denies a reviewer overwriting their own document', async () => {
    await assertFails(
      setDoc(roleRef(asVerifiedPassword(env, REVIEWER), REVIEWER), { reviewer: true, admin: true }),
    );
  });

  // Self-demotion is refused too. Not because it is dangerous, but because
  // the collection has exactly one writer and it is not a client — a rule
  // that carved out an exception would be a client write path to defend.
  it('denies a reviewer deleting their own document', async () => {
    await assertFails(deleteDoc(roleRef(asVerifiedPassword(env, REVIEWER), REVIEWER)));
  });

  it('denies a signed-out caller writing a role document', async () => {
    await assertFails(setDoc(roleRef(asSignedOut(env), PLAIN), { reviewer: true }));
  });

  it('denies an anonymous session granting itself the role', async () => {
    await assertFails(
      setDoc(roleRef(asAnonymous(env, 'anon-uid'), 'anon-uid'), { reviewer: true }),
    );
  });
});

describe('user_roles: schema — deliberately unconstrained', () => {
  // There is no exact-key hasOnly() allowlist here and there must not be one:
  // nothing client-writable means nothing to constrain, and it is what keeps
  // an `admin` flag (or a `grantedAt` note) addable later without the A10
  // migration that widening `custom_questions` will need. A document carrying
  // fields this app has never heard of still reads back fine.
  it('reads back a document carrying unknown fields', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'user_roles', PLAIN), {
        reviewer: true,
        admin: true,
        grantedAt: 1_755_000_000_000,
        note: 'granted by hand in the console',
      });
    });
    await assertSucceeds(getDoc(roleRef(asVerifiedPassword(env, PLAIN), PLAIN)));
  });
});
