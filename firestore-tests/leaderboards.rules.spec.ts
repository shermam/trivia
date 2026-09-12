import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDocs, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REGION_CODES } from '../src/app/models/regions';
import { MAX_SCORE_MULTIPLIER } from '../src/app/models/scoring';
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

/** A schema-valid regional entry: the board document plus the country it is published under. */
const regionalEntry = (
  uid: string,
  limit: string,
  region: string,
  overrides: Record<string, unknown> = {},
) => validEntry(uid, { timeLimit: limit, region, ...overrides });

const regionalRef = (ctx: RulesTestContext, limit: string, region: string, uid: string) =>
  doc(ctx.firestore(), 'leaderboards', limit, 'regions', region, 'entries', uid);

async function seedExistingRegional(limit: string, region: string, uid: string, score: number) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), 'leaderboards', limit, 'regions', region, 'entries', uid),
      regionalEntry(uid, limit, region, { score }),
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

  // Still refused after the multiplier widened the score bound: accuracy may
  // fall short of what the score implies (a multiplier inflates one and not the
  // other), never exceed it, because every correct answer is worth at least a
  // point.
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

/**
 * `FEAT-004`. A streak multiplier carries a score past its own question count,
 * so the bound became `score <= totalQuestions * MAX_SCORE_MULTIPLIER` and
 * `percentage` stopped being derived from the score at all.
 *
 * **The accept cases carry most of the weight here.** A suite of nothing but
 * rejections passes against a rule that denies everything, and that is not a
 * hypothetical on this file — the session-document volume cap shipped 100%
 * closed and looked perfectly correct doing so (`CLAUDE.md` §4.6). Every
 * legitimate score a real game can produce has to be accepted, because the
 * alternative reaches the player as a bare `permission-denied` on the one
 * screen that cannot honestly explain it.
 */
describe('leaderboards: the multiplier ceiling (FEAT-004)', () => {
  const write = (overrides: Record<string, unknown>) =>
    setDoc(entryRef(asVerifiedPassword(env, 'u'), '15', 'u'), boardEntry('u', '15', overrides));

  /*
   * **The constant is duplicated, so it is pinned.** The rules copy is the
   * authority and the client copy exists only so the app refuses to submit a
   * score this file would reject; two numbers that can drift is exactly the
   * shape of a bug nobody sees until a player's perfect run stops saving.
   * Read out of the rules text rather than restated here, so this test cannot
   * agree with a number the emulator never loaded.
   */
  it('agrees with the client about the ceiling', () => {
    const rules = readFileSync('firestore.rules', 'utf8');
    const declared = /function maxScoreMultiplier\(\)\s*\{\s*return\s+(\d+)\s*;/.exec(rules);

    expect(declared, 'maxScoreMultiplier() not found in firestore.rules').not.toBeNull();
    expect(Number(declared?.[1])).toBe(MAX_SCORE_MULTIPLIER);
  });

  // The score a real perfect run produces, question count by question count.
  // These are the entries the feature exists to publish; a rule that refused
  // them would be invisible to any `assertFails`.
  for (const [questions, score] of [
    [5, 7],
    [10, 20],
    [25, 65],
  ] as const) {
    it(`accepts a perfect ${questions}-question run scoring ${score}`, async () => {
      await assertSucceeds(write({ score, totalQuestions: questions, percentage: 100 }));
    });
  }

  it('accepts a score exactly on the ceiling', async () => {
    await assertSucceeds(write({ score: 10 * MAX_SCORE_MULTIPLIER, totalQuestions: 10 }));
  });

  it('accepts a score one under the ceiling', async () => {
    await assertSucceeds(write({ score: 10 * MAX_SCORE_MULTIPLIER - 1, totalQuestions: 10 }));
  });

  it('rejects a score one over the ceiling', async () => {
    await assertFails(write({ score: 10 * MAX_SCORE_MULTIPLIER + 1, totalQuestions: 10 }));
  });

  it('rejects a score far over the ceiling on the longest game', async () => {
    await assertFails(write({ score: 25 * MAX_SCORE_MULTIPLIER + 1, totalQuestions: 25 }));
  });

  // The ceiling scales with the game, so a short game does not inherit a long
  // game's headroom — the mistake a single constant bound would make.
  it('rejects a long-game score written against a short game', async () => {
    await assertFails(write({ score: 20, totalQuestions: 5 }));
  });

  it('accepts the same score on a game long enough to earn it', async () => {
    await assertSucceeds(write({ score: 20, totalQuestions: 10 }));
  });

  /*
   * `percentage` is raw accuracy now, so it is *not* recomputable from the
   * score — but it is still bounded by it in one direction, and capped at 100
   * absolutely. Both halves are load-bearing: without the cap a multiplied
   * score would license a 300% entry, and without the bound 1 correct out of 10
   * could still be published as 100%.
   */
  it('accepts accuracy below what the score implies', async () => {
    await assertSucceeds(write({ score: 20, totalQuestions: 10, percentage: 100 }));
  });

  it('accepts a modest accuracy beside a multiplied score', async () => {
    await assertSucceeds(write({ score: 12, totalQuestions: 10, percentage: 70 }));
  });

  it('rejects an accuracy above 100 however large the score', async () => {
    await assertFails(write({ score: 30, totalQuestions: 10, percentage: 300 }));
  });

  it('rejects an accuracy above what the score implies', async () => {
    await assertFails(write({ score: 2, totalQuestions: 10, percentage: 90 }));
  });

  // The boundary itself, one point over: `round(7 * 100 / 10)` is 70, so 70 is
  // the largest accuracy a score of 7 can carry and 71 is the first refused.
  // The far-over case above would still pass against a rule that had drifted a
  // few points loose; this one cannot.
  it('rejects an accuracy one point above what the score implies', async () => {
    await assertSucceeds(write({ score: 7, totalQuestions: 10, percentage: 70 }));
    await assertFails(write({ score: 7, totalQuestions: 10, percentage: 71 }));
  });

  // The other bounds are unchanged, and stay checked alongside the new one so
  // widening the score cannot be mistaken for widening the entry.
  it('rejects a non-integer multiplied score', async () => {
    await assertFails(write({ score: 7.5, totalQuestions: 10 }));
  });

  it('rejects a multiplied score on a game longer than the app can produce', async () => {
    await assertFails(write({ score: 26, totalQuestions: 26 }));
  });

  it("rejects a multiplied score written to someone else's entry", async () => {
    await assertFails(
      setDoc(
        entryRef(asVerifiedPassword(env, 'attacker'), '15', 'victim'),
        boardEntry('victim', '15', { score: 20 }),
      ),
    );
  });

  // The improving-score rule is untouched by the widening: a multiplied score
  // still has to beat what is on the board, and still cannot replace a better
  // one just by being multiplied.
  it('still requires a multiplied score to beat the existing best', async () => {
    await seedExisting('15', 'u', 20);

    await assertFails(write({ score: 18, totalQuestions: 10 }));
    await assertSucceeds(write({ score: 21, totalQuestions: 10 }));
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

/**
 * `FEAT-028`. A board per country per timing constraint, one path segment
 * below the boards above, so a player who will never crack the global top ten
 * has one they can actually compete on.
 *
 * **Two things are new here and everything else is inherited.** The new half
 * is the `region` dimension — which regions exist, that the path and the field
 * must agree, and that the improving-score rule is scoped per country as well
 * as per board. The inherited half is every bound `hasValidScoreFields()` puts
 * on a global entry, which has to hold here too or the forgery the `score`
 * ceiling exists to refuse simply moves one path segment sideways; the cases
 * below re-prove the ones a regional path could plausibly have been wired
 * around rather than re-proving all of them.
 */
describe('regional leaderboards: which regions exist (FEAT-028)', () => {
  /*
   * **The list is duplicated, so it is pinned** — the same arrangement as
   * `maxScoreMultiplier()` above and for the same reason: the rules copy is
   * the authority, the client copy exists so the picker cannot offer a country
   * the rules will refuse, and two lists that can drift are a save that fails
   * with a bare `permission-denied` for whoever lives in the country that
   * drifted. Read out of the rules text rather than restated here, so this
   * cannot agree with a list the emulator never loaded.
   */
  it('agrees with the client about which countries exist', () => {
    const rules = readFileSync('firestore.rules', 'utf8');
    const declared = /function isValidRegion\(region\)\s*\{\s*return region in \[([^\]]*)\]/.exec(
      rules,
    );

    expect(declared, 'isValidRegion() not found in firestore.rules').not.toBeNull();
    const codes = [...(declared?.[1] ?? '').matchAll(/'([A-Z]{2})'/g)].map((match) => match[1]);

    expect(codes.length, 'the rules list is not empty').toBeGreaterThan(200);
    expect(codes).toEqual([...REGION_CODES]);
  });

  /*
   * The accept half, and it carries most of the weight: `region in [...]` over
   * 249 entries is exactly the kind of rules expression that can fail 100%
   * closed — past an evaluation budget, or written inside-out — and look
   * perfectly correct doing so (`CLAUDE.md` §4.6). One code from each end of
   * the list and one from the middle, because a limit that bit would bite the
   * last entry first.
   */
  for (const region of ['AD', 'BR', 'ZW']) {
    it(`accepts a write to the "${region}" board`, async () => {
      await assertSucceeds(
        setDoc(
          regionalRef(asVerifiedPassword(env, 'u'), '15', region, 'u'),
          regionalEntry('u', '15', region),
        ),
      );
    });

    it(`serves a public read of the "${region}" board`, async () => {
      await assertSucceeds(
        getDocs(
          collection(
            asSignedOut(env).firestore(),
            'leaderboards',
            '15',
            'regions',
            region,
            'entries',
          ),
        ),
      );
    });
  }

  for (const limit of BOARDS) {
    it(`accepts a Brazilian entry on the "${limit}" board`, async () => {
      await assertSucceeds(
        setDoc(
          regionalRef(asVerifiedPassword(env, 'u'), limit, 'BR', 'u'),
          regionalEntry('u', limit, 'BR'),
        ),
      );
    });
  }

  /*
   * The region is a path segment the caller names, so an unchecked one is a
   * public collection whose name an attacker chooses. `XK` and `UK` are the
   * interesting rejections rather than the obvious ones: both are real
   * two-letter codes in daily use and neither is officially assigned, so a
   * rule written as a shape check — or a list generated from an ICU table
   * without filtering it — would accept them.
   */
  for (const bogus of ['ZZ', 'XK', 'UK', 'EU', 'br', 'B', 'BRA', 'Brazil', '15']) {
    it(`rejects a write to an undeclared region (${JSON.stringify(bogus)})`, async () => {
      await assertFails(
        setDoc(
          regionalRef(asVerifiedPassword(env, 'u'), '15', bogus, 'u'),
          regionalEntry('u', '15', bogus),
        ),
      );
    });
  }

  it('rejects a read of an undeclared region', async () => {
    await assertFails(
      getDocs(
        collection(asSignedOut(env).firestore(), 'leaderboards', '15', 'regions', 'ZZ', 'entries'),
      ),
    );
  });

  it('rejects a regional write to an undeclared board', async () => {
    await assertFails(
      setDoc(
        regionalRef(asVerifiedPassword(env, 'u'), '60', 'BR', 'u'),
        regionalEntry('u', '60', 'BR'),
      ),
    );
  });
});

describe('regional leaderboards: the path and the fields must agree', () => {
  it('rejects an entry whose region names a different board', async () => {
    await assertFails(
      setDoc(
        regionalRef(asVerifiedPassword(env, 'u'), '15', 'BR', 'u'),
        regionalEntry('u', '15', 'PT'),
      ),
    );
  });

  /*
   * `hasOnly()` accepts a subset, so nothing in the allowlist makes `region`
   * mandatory — `data.region == region` is what does, and this is the case
   * that fails if that clause is ever softened into a presence check.
   */
  it('rejects an entry with no region at all', async () => {
    await assertFails(
      setDoc(regionalRef(asVerifiedPassword(env, 'u'), '15', 'BR', 'u'), boardEntry('u', '15')),
    );
  });

  it('rejects a non-string region', async () => {
    await assertFails(
      setDoc(
        regionalRef(asVerifiedPassword(env, 'u'), '15', 'BR', 'u'),
        regionalEntry('u', '15', 'BR', { region: 55 }),
      ),
    );
  });

  it('rejects a timeLimit naming a different board', async () => {
    await assertFails(
      setDoc(
        regionalRef(asVerifiedPassword(env, 'u'), '15', 'BR', 'u'),
        regionalEntry('u', '15', 'BR', { timeLimit: 'unlimited' }),
      ),
    );
  });

  /*
   * The global board's allowlist has no `region` key and must not grow one by
   * accident: a document carrying both would be the same entry filed under two
   * schemas, and the global board is where every pre-`FEAT-028` row lives.
   */
  it('rejects a region field on the global board', async () => {
    await assertFails(
      setDoc(
        entryRef(asVerifiedPassword(env, 'u'), '15', 'u'),
        boardEntry('u', '15', { region: 'BR' }),
      ),
    );
  });
});

describe('regional leaderboards: the anti-flood gate and the bounds carry over', () => {
  const write = (overrides: Record<string, unknown>) =>
    setDoc(
      regionalRef(asVerifiedPassword(env, 'u'), '15', 'BR', 'u'),
      regionalEntry('u', '15', 'BR', overrides),
    );

  it('rejects a signed-out caller', async () => {
    await assertFails(
      setDoc(regionalRef(asSignedOut(env), '15', 'BR', 'u'), regionalEntry('u', '15', 'BR')),
    );
  });

  it('rejects an anonymous player', async () => {
    await assertFails(
      setDoc(
        regionalRef(asAnonymous(env, 'anon'), '15', 'BR', 'anon'),
        regionalEntry('anon', '15', 'BR'),
      ),
    );
  });

  it('rejects an unverified password account', async () => {
    await assertFails(
      setDoc(
        regionalRef(asUnverifiedPassword(env, 'u'), '15', 'BR', 'u'),
        regionalEntry('u', '15', 'BR'),
      ),
    );
  });

  it('allows an OAuth account without email_verified', async () => {
    await assertSucceeds(
      setDoc(regionalRef(asOAuth(env, 'u'), '15', 'BR', 'u'), regionalEntry('u', '15', 'BR')),
    );
  });

  it("rejects writing to someone else's document id", async () => {
    await assertFails(
      setDoc(
        regionalRef(asVerifiedPassword(env, 'attacker'), '15', 'BR', 'victim'),
        regionalEntry('victim', '15', 'BR'),
      ),
    );
  });

  it('rejects a uid field that disagrees with the document id', async () => {
    await assertFails(write({ uid: 'someone-else' }));
  });

  it('rejects an unknown extra key', async () => {
    await assertFails(write({ cheated: true }));
  });

  it('rejects an implausible score', async () => {
    await assertFails(write({ score: 999999, totalQuestions: 999999, percentage: 100 }));
  });

  it('rejects a score one over the multiplier ceiling', async () => {
    await assertFails(write({ score: 10 * MAX_SCORE_MULTIPLIER + 1, totalQuestions: 10 }));
  });

  it('accepts a score exactly on the multiplier ceiling', async () => {
    await assertSucceeds(write({ score: 10 * MAX_SCORE_MULTIPLIER, totalQuestions: 10 }));
  });

  it('accepts a perfect five-question run', async () => {
    await assertSucceeds(write({ score: 7, totalQuestions: 5, percentage: 100 }));
  });

  it('rejects an accuracy above what the score implies', async () => {
    await assertFails(write({ score: 1, totalQuestions: 10, percentage: 100 }));
  });

  it('rejects a backdated createdAt', async () => {
    await assertFails(write({ createdAt: Date.now() - 60 * 60 * 1000 }));
  });

  it('rejects a name over 30 chars', async () => {
    await assertFails(write({ name: 'x'.repeat(31) }));
  });

  it('refuses a delete by the owner', async () => {
    await seedExistingRegional('15', 'BR', 'u', 5);
    const { deleteDoc } = await import('firebase/firestore');
    await assertFails(deleteDoc(regionalRef(asVerifiedPassword(env, 'u'), '15', 'BR', 'u')));
  });
});

describe('regional leaderboards: improving-score is scoped per country', () => {
  it('accepts a better score on the same regional board', async () => {
    await seedExistingRegional('15', 'BR', 'u', 5);
    await assertSucceeds(
      setDoc(
        regionalRef(asVerifiedPassword(env, 'u'), '15', 'BR', 'u'),
        regionalEntry('u', '15', 'BR', { score: 6 }),
      ),
    );
  });

  it('rejects an equal score on the same regional board', async () => {
    await seedExistingRegional('15', 'BR', 'u', 5);
    await assertFails(
      setDoc(
        regionalRef(asVerifiedPassword(env, 'u'), '15', 'BR', 'u'),
        regionalEntry('u', '15', 'BR', { score: 5 }),
      ),
    );
  });

  /*
   * The behaviour the picker's copy promises: changing country affects future
   * saves only, and a player's Brazilian best must not gatekeep their first
   * Portuguese entry. If the improving-score check reached across countries,
   * moving would silently cost the mover their new board.
   */
  it('accepts a lower first score in a different country', async () => {
    await seedExistingRegional('15', 'BR', 'u', 20);
    await assertSucceeds(
      setDoc(
        regionalRef(asVerifiedPassword(env, 'u'), '15', 'PT', 'u'),
        regionalEntry('u', '15', 'PT', { score: 1 }),
      ),
    );
  });

  it('accepts a lower first score on a different board in the same country', async () => {
    await seedExistingRegional('15', 'BR', 'u', 20);
    await assertSucceeds(
      setDoc(
        regionalRef(asVerifiedPassword(env, 'u'), 'unlimited', 'BR', 'u'),
        regionalEntry('u', 'unlimited', 'BR', { score: 1 }),
      ),
    );
  });

  /*
   * The two documents one save writes are independent, so neither
   * improving-score floor may be read off the other: a player whose global
   * best already stands can still be first in their own country, and the
   * client attempts both writes for exactly this reason.
   */
  it('accepts a regional entry the global board would refuse', async () => {
    await seedExisting('15', 'u', 20);
    await assertSucceeds(
      setDoc(
        regionalRef(asVerifiedPassword(env, 'u'), '15', 'BR', 'u'),
        regionalEntry('u', '15', 'BR', { score: 1 }),
      ),
    );
    await assertFails(
      setDoc(
        entryRef(asVerifiedPassword(env, 'u'), '15', 'u'),
        boardEntry('u', '15', { score: 1 }),
      ),
    );
  });
});
