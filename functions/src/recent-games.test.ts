import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_GAME_ID_LENGTH,
  hasLegacyGameId,
  recentGameIdsOf,
  withRecentGame,
} from './recent-games';

/**
 * The ring of recent game ids behind `recordGameResult`'s duplicate check
 * (`recent-games.ts`). The decision that uses it — refuse an id in the ring —
 * is `game-stats.test.ts`'s; what is pinned here is the ring itself: what a
 * stored document reads as, the bound, and the migration from `lastGameId`.
 *
 * **Twenty is written out, never read from the module**, for the reason
 * `caller-gate.test.ts` writes its lists out: a row derived from the constant
 * moves with it, so shrinking the ring would pass the test that exists to
 * notice.
 */

/** `count` distinct game ids, newest first: `game-1`, `game-2`, … */
const ids = (count: number, prefix = 'game') =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);

describe('withRecentGame', () => {
  // Accept cases first (`CLAUDE.md` §4.6).
  it('puts a banked game first, ahead of the ones before it', () => {
    assert.deepEqual(withRecentGame(['game-b', 'game-a'], 'game-c'), [
      'game-c',
      'game-b',
      'game-a',
    ]);
  });

  it('starts a ring from nothing', () => {
    assert.deepEqual(withRecentGame([], 'game-a'), ['game-a']);
  });

  /**
   * **The boundary.** Twenty ids is a full ring; a twenty-first pushes the
   * oldest out and keeps the other nineteen.
   */
  it('holds twenty ids, and drops the oldest when a twenty-first banks', () => {
    const full = ids(20);
    assert.equal(withRecentGame(full.slice(1), 'game-new').length, 20);

    const next = withRecentGame(full, 'game-new');

    assert.equal(next.length, 20);
    assert.equal(next[0], 'game-new');
    assert.equal(next[19], 'game-19');
    assert.ok(!next.includes('game-20'), 'the oldest has fallen out');
  });

  it('moves an id already in the ring to the front rather than holding it twice', () => {
    assert.deepEqual(withRecentGame(['game-b', 'game-a'], 'game-a'), ['game-a', 'game-b']);
  });
});

describe('recentGameIdsOf', () => {
  it('reads a stored ring as it is, newest first', () => {
    assert.deepEqual(recentGameIdsOf({ recentGameIds: ['game-b', 'game-a'] }), [
      'game-b',
      'game-a',
    ]);
  });

  it('accepts an id of exactly the longest length a game id can have', () => {
    const longest = 'x'.repeat(MAX_GAME_ID_LENGTH);
    assert.equal(MAX_GAME_ID_LENGTH, 128);
    assert.deepEqual(recentGameIdsOf({ recentGameIds: [longest] }), [longest]);
  });

  /**
   * A document with no games banked yet — none at all, or one holding only an
   * avatar chosen before the first game (`FEAT-038`) — has an empty ring, and
   * so does no document.
   */
  it('reads a document with no ring, or no document, as an empty ring', () => {
    for (const stored of [null, undefined, {}, { avatar: { kind: 'initials' } }, 'users/u1', 7]) {
      assert.deepEqual(recentGameIdsOf(stored), [], JSON.stringify(stored));
    }
  });

  /**
   * Only `recordGameResult` writes the ring, and only as an array of ids, so
   * anything else is a hand edit in the console — and one entry that is not an
   * id makes the whole array suspect.
   */
  it('reads a malformed ring as empty', () => {
    for (const recentGameIds of [
      'game-a',
      { 0: 'game-a' },
      ['game-a', 7],
      ['game-a', ''],
      ['game-a', null],
      ['x'.repeat(129)],
      42,
    ]) {
      assert.deepEqual(
        recentGameIdsOf({ recentGameIds }),
        [],
        `recentGameIds=${JSON.stringify(recentGameIds)}`,
      );
    }
  });

  it('reads a ring a hand edit has made longer than twenty as its newest twenty', () => {
    const ring = recentGameIdsOf({ recentGameIds: ids(25) });

    assert.equal(ring.length, 20);
    assert.deepEqual(ring, ids(20));
  });

  // The migration's first half: a document written before the ring existed.
  it('reads the old lastGameId as a ring of one', () => {
    assert.deepEqual(recentGameIdsOf({ gamesPlayed: 4, lastGameId: 'game-old' }), ['game-old']);
  });

  /**
   * Both fields at once is a deploy in progress: an instance still running the
   * old code banked a game after the new code wrote the ring. That game is the
   * newest, so it goes first and is the last to fall out.
   */
  it('puts a lastGameId beside a ring first, once, and keeps the ring to twenty', () => {
    assert.deepEqual(
      recentGameIdsOf({ recentGameIds: ['game-b', 'game-a'], lastGameId: 'game-c' }),
      ['game-c', 'game-b', 'game-a'],
    );
    assert.deepEqual(
      recentGameIdsOf({ recentGameIds: ['game-b', 'game-a'], lastGameId: 'game-a' }),
      ['game-b', 'game-a'],
    );

    const ring = recentGameIdsOf({ recentGameIds: ids(20), lastGameId: 'game-c' });
    assert.equal(ring.length, 20);
    assert.equal(ring[0], 'game-c');
    assert.ok(!ring.includes('game-20'));
  });

  it('ignores a lastGameId that is not a game id, beside a ring or alone', () => {
    for (const lastGameId of [7, '', null, ['game-a'], 'x'.repeat(129)]) {
      assert.deepEqual(recentGameIdsOf({ lastGameId }), [], JSON.stringify(lastGameId));
      assert.deepEqual(
        recentGameIdsOf({ recentGameIds: ['game-a'], lastGameId }),
        ['game-a'],
        JSON.stringify(lastGameId),
      );
    }
  });

  it('keeps the lastGameId when the ring beside it is malformed', () => {
    assert.deepEqual(recentGameIdsOf({ recentGameIds: 'nonsense', lastGameId: 'game-old' }), [
      'game-old',
    ]);
  });
});

describe('hasLegacyGameId', () => {
  it('is true for a document carrying lastGameId, whatever it holds', () => {
    for (const lastGameId of ['game-old', '', 7, null]) {
      assert.equal(hasLegacyGameId({ lastGameId }), true, JSON.stringify(lastGameId));
    }
  });

  it('is false for a document without one, and for no document', () => {
    for (const stored of [{ recentGameIds: ['game-a'] }, {}, null, undefined, 'lastGameId']) {
      assert.equal(hasLegacyGameId(stored), false, JSON.stringify(stored));
    }
  });
});
