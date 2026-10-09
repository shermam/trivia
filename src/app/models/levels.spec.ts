import * as server from '../../../functions/src/levels';
import { BUILT_AVATAR_SETS } from '../components/avatar/built-avatar';
import {
  AVATAR_SET_UNLOCK_LEVELS,
  isSetUnlocked,
  levelFor,
  levelProgress,
  nextUnlock,
  readXp,
  unlockedSets,
  xpForLevel,
} from './levels';

/**
 * The level table and the unlock rule exist twice — `functions/src/levels.ts`,
 * which `setAvatar` enforces, and this copy, which draws the progress card and
 * locks the picker's sets (`FEAT-041`). They are one fact kept in two
 * packages, and the cost of their disagreeing is a picker that offers a set
 * the server refuses, or hides one the player has earned. So the functions
 * module is imported across the package boundary — the way
 * `auth.service.spec.ts` pins the caller gate's providers — and every function
 * is compared over a range that crosses every threshold the table names.
 */
describe('levels — the app copy agrees with the server', () => {
  /** Every XP total to 2,000, then a sweep further out: well past every set's level. */
  const TOTALS = [
    ...Array.from({ length: 2_001 }, (_, xp) => xp),
    ...Array.from({ length: 200 }, (_, step) => 2_000 + step * 997),
  ];

  it('holds the same unlock table', () => {
    expect({ ...AVATAR_SET_UNLOCK_LEVELS }).toEqual({ ...server.AVATAR_SET_UNLOCK_LEVELS });
    expect(Object.keys(AVATAR_SET_UNLOCK_LEVELS)).toEqual(
      Object.keys(server.AVATAR_SET_UNLOCK_LEVELS),
    );
  });

  it('puts every level at the same XP', () => {
    for (let level = 0; level <= 60; level++) {
      expect(xpForLevel(level), `level ${level}`).toBe(server.xpForLevel(level));
    }
  });

  it('reaches the same level and unlocks the same sets at every total', () => {
    for (const xp of TOTALS) {
      expect(levelFor(xp), `${xp} XP`).toBe(server.levelFor(xp));
      expect(unlockedSets(xp), `${xp} XP`).toEqual(server.unlockedSets(xp));
    }
  });

  it('decides each set, a set it does not know included, the same way', () => {
    for (const set of [...Object.keys(AVATAR_SET_UNLOCK_LEVELS), 'gems', 'constructor']) {
      for (const xp of [0, 599, 600, 1_000_000]) {
        expect(isSetUnlocked(set, xp), `${set} at ${xp}`).toBe(server.isSetUnlocked(set, xp));
      }
    }
  });

  it('reads a stored value the same way', () => {
    for (const value of [0, 640, -1, 1.5, '640', null, undefined, Number.NaN, 2 ** 60]) {
      expect(readXp(value), String(value)).toBe(server.readXp(value));
    }
  });
});

/**
 * The unlock table names sets, and `BUILT_AVATAR_SETS` draws them. A set drawn
 * but missing from the table could never be chosen; one in the table but not
 * drawn would be offered as a row of initials. Either way the two lists are
 * one list.
 */
describe('levels — the unlock table and the avatar builder', () => {
  it('names exactly the sets the builder can draw', () => {
    expect(new Set(Object.keys(AVATAR_SET_UNLOCK_LEVELS))).toEqual(
      new Set(Object.keys(BUILT_AVATAR_SETS)),
    );
  });

  it('keeps the first set open from the start', () => {
    expect(AVATAR_SET_UNLOCK_LEVELS['core']).toBe(0);
    expect(unlockedSets(0)).toEqual(['core']);
  });
});

describe('levelProgress', () => {
  it('places a total between its level and the next', () => {
    expect(levelProgress(0)).toEqual({ level: 0, xp: 0, nextLevelXp: 100, into: 0, span: 100 });
    expect(levelProgress(340)).toEqual({
      level: 2,
      xp: 340,
      nextLevelXp: 600,
      into: 40,
      span: 300,
    });
    // Exactly on a threshold is the start of that level, not the end of the last.
    expect(levelProgress(600)).toEqual({
      level: 3,
      xp: 600,
      nextLevelXp: 1_000,
      into: 0,
      span: 400,
    });
  });

  it('reads a value that is not a count as none', () => {
    expect(levelProgress(-50)).toEqual(levelProgress(0));
  });
});

describe('nextUnlock', () => {
  it('names the next set still locked, and the level that opens it', () => {
    expect(nextUnlock(0)).toEqual({ set: 'bold', level: 3 });
    expect(nextUnlock(599)).toEqual({ set: 'bold', level: 3 });
  });

  it('is null once every set is open', () => {
    expect(nextUnlock(600)).toBeNull();
    expect(nextUnlock(90_000)).toBeNull();
  });
});
