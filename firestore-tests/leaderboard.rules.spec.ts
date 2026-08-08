import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDocs, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  asAnonymous,
  asOAuth,
  asSignedOut,
  asUnverifiedPassword,
  asVerifiedPassword,
  createTestEnv,
  validEntry,
} from './helpers';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnv('demo-rules-leaderboard');
});
afterAll(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const entryRef = (ctx: RulesTestContext, uid: string) => doc(ctx.firestore(), 'leaderboard', uid);

/** Seeds an existing best score, bypassing rules — the precondition for every update test. */
async function seedExisting(uid: string, score: number) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'leaderboard', uid), validEntry(uid, { score }));
  });
}

describe('leaderboard: read', () => {
  it('is public — the top 10 renders before sign-in', async () => {
    await assertSucceeds(getDocs(collection(asSignedOut(env).firestore(), 'leaderboard')));
  });
});

describe('leaderboard: create — the anti-flood gate', () => {
  it('rejects a signed-out caller', async () => {
    await assertFails(setDoc(entryRef(asSignedOut(env), 'u'), validEntry('u')));
  });

  it('rejects an anonymous player — this is the actual anti-cheat boundary', async () => {
    await assertFails(setDoc(entryRef(asAnonymous(env, 'anon'), 'anon'), validEntry('anon')));
  });

  it('rejects an unverified password account', async () => {
    await assertFails(setDoc(entryRef(asUnverifiedPassword(env, 'u'), 'u'), validEntry('u')));
  });

  it('allows a verified password account', async () => {
    await assertSucceeds(setDoc(entryRef(asVerifiedPassword(env, 'u'), 'u'), validEntry('u')));
  });

  // An OAuth identity has no email_verified requirement — the provider vouched for it.
  it('allows an OAuth account without email_verified', async () => {
    await assertSucceeds(setDoc(entryRef(asOAuth(env, 'u'), 'u'), validEntry('u')));
  });
});

describe('leaderboard: create — ownership', () => {
  it("rejects writing to someone else's document id", async () => {
    await assertFails(
      setDoc(entryRef(asVerifiedPassword(env, 'attacker'), 'victim'), validEntry('victim')),
    );
  });

  it('rejects a uid field that disagrees with the document id', async () => {
    await assertFails(
      setDoc(entryRef(asVerifiedPassword(env, 'u'), 'u'), validEntry('u', { uid: 'someone-else' })),
    );
  });
});

describe('leaderboard: create — schema validation', () => {
  const rejects = (label: string, overrides: Record<string, unknown>) =>
    it(`rejects ${label}`, async () => {
      await assertFails(
        setDoc(entryRef(asVerifiedPassword(env, 'u'), 'u'), validEntry('u', overrides)),
      );
    });

  rejects('an unknown extra key', { cheated: true });
  rejects('an empty name', { name: '' });
  rejects('a name over 30 chars', { name: 'x'.repeat(31) });
  rejects('a negative score', { score: -1 });
  rejects('a non-integer score', { score: 1.5 });
  rejects('totalQuestions below score', { score: 10, totalQuestions: 5 });
  rejects('a percentage above 100', { percentage: 101 });
  rejects('a negative percentage', { percentage: -1 });
  rejects('a non-integer createdAt', { createdAt: 'yesterday' });
  rejects('a non-string name', { name: 42 });

  it('rejects a document missing a required key', async () => {
    const { percentage: _dropped, ...withoutPercentage } = validEntry('u');
    await assertFails(setDoc(entryRef(asVerifiedPassword(env, 'u'), 'u'), withoutPercentage));
  });

  /*
   * Documents the current bound rather than asserting it is sufficient. Shape
   * validation is not anti-cheat: nothing here ties the numbers to a game that
   * was actually played, so a hand-written 999999 is accepted today. That is
   * finding A1, and the PR that bounds these values will flip this expectation
   * to assertFails — this test exists so that change is visible in the diff
   * rather than silent.
   */
  it('CURRENTLY ACCEPTS an implausible score (finding A1 — see PR bounding these)', async () => {
    await assertSucceeds(
      setDoc(
        entryRef(asVerifiedPassword(env, 'u'), 'u'),
        validEntry('u', { score: 999999, totalQuestions: 999999, percentage: 100 }),
      ),
    );
  });

  it('CURRENTLY ACCEPTS a percentage inconsistent with score/totalQuestions (finding A1)', async () => {
    await assertSucceeds(
      setDoc(
        entryRef(asVerifiedPassword(env, 'u'), 'u'),
        validEntry('u', { score: 1, totalQuestions: 10, percentage: 100 }),
      ),
    );
  });
});

describe('leaderboard: update — only a genuine personal best', () => {
  it('allows a strictly higher score', async () => {
    await seedExisting('u', 5);
    await assertSucceeds(
      setDoc(entryRef(asVerifiedPassword(env, 'u'), 'u'), validEntry('u', { score: 6 })),
    );
  });

  it('rejects an equal score', async () => {
    await seedExisting('u', 5);
    await assertFails(
      setDoc(entryRef(asVerifiedPassword(env, 'u'), 'u'), validEntry('u', { score: 5 })),
    );
  });

  it('rejects a lower score', async () => {
    await seedExisting('u', 5);
    await assertFails(
      setDoc(entryRef(asVerifiedPassword(env, 'u'), 'u'), validEntry('u', { score: 4 })),
    );
  });

  it("rejects improving someone else's entry", async () => {
    await seedExisting('victim', 5);
    await assertFails(
      setDoc(
        entryRef(asVerifiedPassword(env, 'attacker'), 'victim'),
        validEntry('victim', { score: 9 }),
      ),
    );
  });

  it('still enforces the schema on an improving write', async () => {
    await seedExisting('u', 5);
    await assertFails(
      setDoc(entryRef(asVerifiedPassword(env, 'u'), 'u'), validEntry('u', { score: 9, name: '' })),
    );
  });
});

describe('leaderboard: delete', () => {
  it('is disallowed — a score cannot be removed to hide it', async () => {
    await seedExisting('u', 5);
    await assertFails(deleteDoc(entryRef(asVerifiedPassword(env, 'u'), 'u')));
  });
});
