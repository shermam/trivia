import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AVATAR_SET_UNLOCK_LEVELS,
  isSetUnlocked,
  levelFor,
  readXp,
  unlockedSets,
  xpForLevel,
} from './levels';

/**
 * The level table and the unlock rule (`FEAT-041`). `setAvatar` enforces the
 * unlock with these, and the app's copy in `src/app/models/levels.ts` is held
 * equal to them by `levels.spec.ts` — so the numbers here are written out by
 * hand rather than derived from the module, or a wrong formula would agree
 * with itself.
 */
describe('xpForLevel', () => {
  it('is 50 × L × (L + 1): 0, 100, 300, 600, 1,000, 1,500', () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5].map((level) => xpForLevel(level)),
      [0, 100, 300, 600, 1_000, 1_500],
    );
  });
});

describe('levelFor', () => {
  /** Every threshold, a point either side of it — the edges a `<` for `<=` moves. */
  it('changes level exactly at each threshold', () => {
    const thresholds: [xp: number, level: number][] = [
      [0, 0],
      [99, 0],
      [100, 1],
      [101, 1],
      [299, 1],
      [300, 2],
      [599, 2],
      [600, 3],
      [999, 3],
      [1_000, 4],
      [1_499, 4],
      [1_500, 5],
    ];
    for (const [xp, level] of thresholds) {
      assert.equal(levelFor(xp), level, `${xp} XP`);
    }
  });

  it('keeps counting past the table anybody will reach soon', () => {
    // Level 100 is 50 × 100 × 101.
    assert.equal(levelFor(505_000), 100);
    assert.equal(levelFor(504_999), 99);
  });

  it('reads anything that is not a whole, non-negative count as no XP', () => {
    for (const xp of [-1, -600, 0.5, 600.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(levelFor(xp), 0, String(xp));
    }
  });
});

describe('readXp', () => {
  it('passes a whole, non-negative count through', () => {
    assert.equal(readXp(0), 0);
    assert.equal(readXp(640), 640);
  });

  /**
   * Fails closed: `setAvatar` reads the stored total through this, so a value a
   * hand edit has broken has to unlock nothing.
   */
  it('reads a value a hand edit has broken as none', () => {
    for (const value of [undefined, null, '640', -5, 12.5, Number.NaN, 2 ** 60, {}, [640]]) {
      assert.equal(readXp(value), 0, JSON.stringify(value) ?? String(value));
    }
  });
});

describe('the unlock rule', () => {
  it('unlocks core at every level and bold from level 3', () => {
    assert.deepEqual({ ...AVATAR_SET_UNLOCK_LEVELS }, { core: 0, bold: 3 });
    assert.deepEqual(unlockedSets(0), ['core']);
    assert.deepEqual(unlockedSets(599), ['core']);
    assert.deepEqual(unlockedSets(600), ['core', 'bold']);
    assert.deepEqual(unlockedSets(50_000), ['core', 'bold']);
  });

  it('decides one set at a time the same way', () => {
    assert.equal(isSetUnlocked('core', 0), true);
    assert.equal(isSetUnlocked('bold', 599), false);
    assert.equal(isSetUnlocked('bold', 600), true);
  });

  /** Fail closed: a set nobody added to the table cannot be chosen at any level. */
  it('unlocks no set the table does not name', () => {
    for (const set of ['gems', 'neon', 'constructor', 'toString', '__proto__', '']) {
      assert.equal(isSetUnlocked(set, 1_000_000), false, set);
    }
  });

  it('cannot be changed at run time', () => {
    assert.throws(() => {
      (AVATAR_SET_UNLOCK_LEVELS as Record<string, number>)['bold'] = 0;
    }, TypeError);
  });
});
