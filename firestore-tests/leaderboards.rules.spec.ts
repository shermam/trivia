import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDocs, setDoc } from 'firebase/firestore';
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

/**
 * Finding G7. A 15-second limit that cannot be adjusted, extended or turned
 * off is a WCAG 2.2.1 failure, but the fix is not simply "add an off switch":
 * a score won with unlimited time is not comparable to one won in 15 seconds,
 * so each timing constraint gets its own board.
 *
 * These cover the new `leaderboards/{limit}/entries/{uid}` paths. The entry
 * schema is the old one plus `timeLimit`, so the shape cases below are
 * deliberately thinner than `leaderboard.rules.spec.ts` — what is new, and
 * what is tested exhaustively here, is the *board* dimension: which boards
 * exist, that the path and the field must agree, and that the per-user
 * improving-score rule is scoped per board rather than globally.
 */

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnv('demo-rules-leaderboards');
});
afterAll(() => env.cleanup());
beforeEach(() => env.clearFirestore());

/** The three boards the rules recognise. Must match `isValidBoard` in `firestore.rules`. */
const BOARDS = ['15', '30', 'unlimited'] as const;

const boardEntry = (uid: string, limit: string, overrides: Record<string, unknown> = {}) =>
  validEntry(uid, { timeLimit: limit, ...overrides });

const entryRef = (ctx: RulesTestContext, limit: string, uid: string) =>
  doc(ctx.firestore(), 'leaderboards', limit, 'entries', uid);

async function seedExisting(limit: string, uid: string, score: number) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), 'leaderboards', limit, 'entries', uid),
      boardEntry(uid, limit, { score }),
    );
  });
}

describe('leaderboards: which boards exist', () => {
  // The accept half. A suite of nothing but rejections passes against a rule
  // that denies everything — and `in` against a list is exactly the kind of
  // rules expression that is easy to write inside-out (CLAUDE.md §4.6).
  for (const limit of BOARDS) {
    it(`accepts a write to the "${limit}" board`, async () => {
      await assertSucceeds(
        setDoc(entryRef(asVerifiedPassword(env, 'u'), limit, 'u'), boardEntry('u', limit)),
      );
    });

    it(`serves a public read of the "${limit}" board`, async () => {
      await assertSucceeds(
        getDocs(collection(asSignedOut(env).firestore(), 'leaderboards', limit, 'entries')),
      );
    });
  }

  // An unchecked path segment is a public collection whose name the caller
  // chooses — free storage, and a board that appears in no UI.
  for (const bogus of ['60', '0', 'Unlimited', '15 ', 'admin', '']) {
    it(`rejects a write to an undeclared board (${JSON.stringify(bogus)})`, async () => {
      await assertFails(
        setDoc(entryRef(asVerifiedPassword(env, 'u'), bogus || 'x', 'u'), boardEntry('u', bogus)),
      );
    });
  }

  it('rejects a read of an undeclared board', async () => {
    await assertFails(
      getDocs(collection(asSignedOut(env).firestore(), 'leaderboards', '60', 'entries')),
    );
  });
});

describe('leaderboards: the path and the field must agree', () => {
  it('rejects an entry whose timeLimit names a different board', async () => {
    await assertFails(
      setDoc(entryRef(asVerifiedPassword(env, 'u'), '15', 'u'), boardEntry('u', 'unlimited')),
    );
  });

  it('rejects an entry with no timeLimit at all', async () => {
    await assertFails(setDoc(entryRef(asVerifiedPassword(env, 'u'), '15', 'u'), validEntry('u')));
  });

  it('rejects a non-string timeLimit', async () => {
    await assertFails(
      setDoc(
        entryRef(asVerifiedPassword(env, 'u'), '15', 'u'),
        boardEntry('u', '15', { timeLimit: 15 }),
      ),
    );
  });
});

describe('leaderboards: the anti-flood gate still applies per board', () => {
  it('rejects a signed-out caller', async () => {
    await assertFails(setDoc(entryRef(asSignedOut(env), '15', 'u'), boardEntry('u', '15')));
  });

  it('rejects an anonymous player', async () => {
    await assertFails(
      setDoc(entryRef(asAnonymous(env, 'anon'), '15', 'anon'), boardEntry('anon', '15')),
    );
  });

  it('rejects an unverified password account', async () => {
    await assertFails(
      setDoc(entryRef(asUnverifiedPassword(env, 'u'), '15', 'u'), boardEntry('u', '15')),
    );
  });

  it('allows an OAuth account without email_verified', async () => {
    await assertSucceeds(setDoc(entryRef(asOAuth(env, 'u'), '15', 'u'), boardEntry('u', '15')));
  });

  it("rejects writing to someone else's document id", async () => {
    await assertFails(
      setDoc(
        entryRef(asVerifiedPassword(env, 'attacker'), '15', 'victim'),
        boardEntry('victim', '15'),
      ),
    );
  });

  it('rejects a uid field that disagrees with the document id', async () => {
    await assertFails(
      setDoc(
        entryRef(asVerifiedPassword(env, 'u'), '15', 'u'),
        boardEntry('u', '15', { uid: 'someone-else' }),
      ),
    );
  });
});

describe('leaderboards: improving-score is scoped to one board', () => {
  it('accepts a better score on the same board', async () => {
    await seedExisting('15', 'u', 5);
    await assertSucceeds(
      setDoc(
        entryRef(asVerifiedPassword(env, 'u'), '15', 'u'),
        boardEntry('u', '15', { score: 6 }),
      ),
    );
  });

  it('rejects an equal score on the same board', async () => {
    await seedExisting('15', 'u', 5);
    await assertFails(
      setDoc(
        entryRef(asVerifiedPassword(env, 'u'), '15', 'u'),
        boardEntry('u', '15', { score: 5 }),
      ),
    );
  });

  it('rejects a worse score on the same board', async () => {
    await seedExisting('15', 'u', 5);
    await assertFails(
      setDoc(
        entryRef(asVerifiedPassword(env, 'u'), '15', 'u'),
        boardEntry('u', '15', { score: 4 }),
      ),
    );
  });

  /*
   * The point of the whole feature. A player's 15-second best must not block
   * their first unlimited entry — if the improving-score check reached across
   * boards, a strong timed player could never appear on an easier board, and
   * the boards would not be independent at all.
   */
  it('accepts a lower first score on a different board', async () => {
    await seedExisting('15', 'u', 20);
    await assertSucceeds(
      setDoc(
        entryRef(asVerifiedPassword(env, 'u'), 'unlimited', 'u'),
        boardEntry('u', 'unlimited', { score: 1 }),
      ),
    );
  });

  it("leaves one board's entry alone when another is updated", async () => {
    await seedExisting('15', 'u', 5);
    await seedExisting('30', 'u', 5);
    await assertSucceeds(
      setDoc(
        entryRef(asVerifiedPassword(env, 'u'), '30', 'u'),
        boardEntry('u', '30', { score: 9 }),
      ),
    );
    // The 15s entry is untouched, so its own improving-score floor is unmoved.
    await assertFails(
      setDoc(
        entryRef(asVerifiedPassword(env, 'u'), '15', 'u'),
        boardEntry('u', '15', { score: 5 }),
      ),
    );
  });
});

/*
 * These moved here wholesale when G7 retired the flat `leaderboard`
 * collection. Its write rules — and the `isValidLeaderboardEntry` function
 * behind them — are gone, so the only place this validation still runs is on a
 * board. The cases are the ones that pinned finding A1 and the bounds that
 * followed it; losing them along with the collection would have quietly
 * dropped the anti-cheat coverage on the way through a refactor.
 */
describe('leaderboards: the score bounds carry over', () => {
  const write = (overrides: Record<string, unknown>) =>
    setDoc(entryRef(asVerifiedPassword(env, 'u'), '15', 'u'), boardEntry('u', '15', overrides));

  const rejects = (label: string, overrides: Record<string, unknown>) =>
    it(`rejects ${label}`, async () => {
      await assertFails(write(overrides));
    });

  rejects('an empty name', { name: '' });
  rejects('a non-string name', { name: 42 });
  rejects('a negative score', { score: -1 });
  rejects('a non-integer score', { score: 1.5 });
  rejects('totalQuestions below score', { score: 10, totalQuestions: 5 });
  rejects('zero questions', { score: 0, totalQuestions: 0, percentage: 0 });
  rejects('a percentage above 100', { percentage: 101 });
  rejects('a negative percentage', { percentage: -1 });
  rejects('a percentage off by one', { score: 7, totalQuestions: 10, percentage: 71 });
  rejects('a non-integer createdAt', { createdAt: 'yesterday' });
  rejects('a future-dated createdAt', { createdAt: Date.now() + 60 * 60 * 1000 });

  it('rejects a document missing a required key', async () => {
    const { percentage: _dropped, ...withoutPercentage } = boardEntry('u', '15');
    await assertFails(setDoc(entryRef(asVerifiedPassword(env, 'u'), '15', 'u'), withoutPercentage));
  });

  /*
   * A `custom` or `mixed` game returns fewer questions than requested when the
   * bank is short — asking for 25 when 7 exist is a genuine 7-question game.
   * Bounding totalQuestions to the menu options instead of a range would
   * reject these.
   */
  it('accepts a short game from a thin question bank', async () => {
    await assertSucceeds(write({ score: 2, totalQuestions: 3 }));
  });

  it('accepts a single-question game', async () => {
    await assertSucceeds(write({ score: 1, totalQuestions: 1 }));
  });

  // Firestore's math.round() was verified to match JavaScript's on .5
  // boundaries; this pins that agreement so a future rules change cannot
  // silently start rejecting honest scores.
  it('accepts a percentage landing exactly on a .5 rounding boundary', async () => {
    await assertSucceeds(write({ score: 1, totalQuestions: 8, percentage: 13 }));
  });

  it('tolerates a clock a couple of minutes behind', async () => {
    await assertSucceeds(write({ createdAt: Date.now() - 2 * 60 * 1000 }));
  });

  it('accepts the longest game the app offers', async () => {
    await assertSucceeds(write({ score: 25, totalQuestions: 25 }));
  });

  it('rejects a game longer than the app can produce', async () => {
    await assertFails(write({ score: 26, totalQuestions: 26 }));
  });

  it('rejects an implausible score', async () => {
    await assertFails(write({ score: 999999, totalQuestions: 999999, percentage: 100 }));
  });

  it('rejects a percentage inconsistent with score/totalQuestions', async () => {
    await assertFails(write({ score: 1, totalQuestions: 10, percentage: 100 }));
  });

  it('rejects an unknown extra key', async () => {
    await assertFails(write({ cheated: true }));
  });

  it('rejects a name over 30 chars', async () => {
    await assertFails(write({ name: 'x'.repeat(31) }));
  });

  it('rejects a backdated createdAt', async () => {
    await assertFails(write({ createdAt: Date.now() - 60 * 60 * 1000 }));
  });
});

describe('leaderboards: delete is closed', () => {
  it('refuses a delete by the owner', async () => {
    await seedExisting('15', 'u', 5);
    const { deleteDoc } = await import('firebase/firestore');
    await assertFails(deleteDoc(entryRef(asVerifiedPassword(env, 'u'), '15', 'u')));
  });
});

describe('leaderboard (pre-G7): retired, read-only', () => {
  /*
   * The counterpart of the test this replaces. That one pinned the old
   * collection as writable so it could not be closed while a cached client was
   * still using it; now the client has moved, and closing it is the point.
   *
   * Writes are refused rather than ignored: a stale client writing into a
   * collection nothing reads looks like success and loses the score silently.
   */
  it('still serves reads', async () => {
    await assertSucceeds(getDocs(collection(asSignedOut(env).firestore(), 'leaderboard')));
  });

  it('refuses a write even from the entry owner', async () => {
    await assertFails(
      setDoc(doc(asVerifiedPassword(env, 'u').firestore(), 'leaderboard', 'u'), validEntry('u')),
    );
  });

  it('refuses an update to an entry that is already there', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'leaderboard', 'u'), validEntry('u', { score: 1 }));
    });
    await assertFails(
      setDoc(
        doc(asVerifiedPassword(env, 'u').firestore(), 'leaderboard', 'u'),
        validEntry('u', { score: 9 }),
      ),
    );
  });
});
