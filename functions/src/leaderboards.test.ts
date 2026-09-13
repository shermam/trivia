import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LEADERBOARD_BOARDS,
  allLeaderboardPathsFor,
  leaderboardPathsFor,
  regionalEntryRefsFor,
  type LeaderboardStore,
} from './leaderboards';

/**
 * Which documents account deletion and account export visit (`FEAT-028`).
 *
 * **This is the test the acceptance list singles out as the one most likely to
 * be missed**, and it is a privacy-policy promise rather than a nicety: a
 * regional entry is a public row carrying a player's name, score and declared
 * country, so a deletion that walked only the global boards would leave it
 * readable by anyone after the player asked to be erased. Nothing else would
 * notice — the entry is not linked from a screen the deleted user can still
 * reach, and the callable would report success.
 *
 * A fake rather than the emulator, because the decision being pinned is which
 * paths get enumerated, not whether Firestore can delete a document.
 */

/**
 * A `leaderboards/{board}/regions` collection that answers `listDocuments()`.
 *
 * The fake returns ids for country boards **whose parent document does not
 * exist**, which is the only shape this schema ever produces: nothing writes
 * `regions/{region}`, the country is purely a path segment, so every reference
 * `listDocuments()` returns here is a missing parent with an `entries`
 * subcollection under it. A fake that handed back documents which "exist"
 * would be testing a Firestore this app does not have.
 */
function storeWith(regionsByBoard: Record<string, string[]>): LeaderboardStore {
  return {
    collection(path: string) {
      const board = /^leaderboards\/([^/]+)\/regions$/.exec(path)?.[1];
      assert.ok(board, `unexpected collection path: ${path}`);
      return {
        listDocuments: () => Promise.resolve((regionsByBoard[board] ?? []).map((id) => ({ id }))),
      };
    },
  };
}

test('the global sweep is the boards plus the retired flat collection', () => {
  assert.deepEqual(leaderboardPathsFor('u1'), [
    'leaderboards/15/entries/u1',
    'leaderboards/30/entries/u1',
    'leaderboards/unlimited/entries/u1',
    'leaderboard/u1',
  ]);
});

test('every board is asked which country boards exist under it', async () => {
  const asked: string[] = [];
  const store: LeaderboardStore = {
    collection(path: string) {
      asked.push(path);
      return { listDocuments: () => Promise.resolve([]) };
    },
  };

  await regionalEntryRefsFor(store, 'u1');

  assert.deepEqual(
    asked,
    LEADERBOARD_BOARDS.map((board) => `leaderboards/${board}/regions`),
  );
});

test('a country board is found even though its parent document does not exist', async () => {
  const refs = await regionalEntryRefsFor(storeWith({ '15': ['BR'] }), 'u1');

  assert.deepEqual(refs, [
    { board: '15', region: 'BR', path: 'leaderboards/15/regions/BR/entries/u1' },
  ]);
});

test('regional entries are enumerated on every board, not only the first', async () => {
  const refs = await regionalEntryRefsFor(
    storeWith({ '15': ['BR', 'PT'], '30': [], unlimited: ['JP'] }),
    'u1',
  );

  assert.deepEqual(
    refs.map((entry) => entry.path),
    [
      'leaderboards/15/regions/BR/entries/u1',
      'leaderboards/15/regions/PT/entries/u1',
      'leaderboards/unlimited/regions/JP/entries/u1',
    ],
  );
});

test('a project with no regional boards yet enumerates nothing', async () => {
  assert.deepEqual(await regionalEntryRefsFor(storeWith({}), 'u1'), []);
});

/**
 * The whole point, stated as one assertion: what `deleteAccount` deletes.
 *
 * Drop the regional half of `allLeaderboardPathsFor` and this fails — which is
 * the mutation run this test exists to answer, since every other check in the
 * suite passes perfectly well against a deletion that leaves a player's
 * Brazilian row on a public board.
 */
test('the full sweep covers global boards, the legacy collection and every region in use', async () => {
  const paths = await allLeaderboardPathsFor(
    storeWith({ '15': ['BR', 'US'], '30': ['BR'], unlimited: ['ZA'] }),
    'u1',
  );

  assert.deepEqual(paths, [
    'leaderboards/15/entries/u1',
    'leaderboards/30/entries/u1',
    'leaderboards/unlimited/entries/u1',
    'leaderboard/u1',
    'leaderboards/15/regions/BR/entries/u1',
    'leaderboards/15/regions/US/entries/u1',
    'leaderboards/30/regions/BR/entries/u1',
    'leaderboards/unlimited/regions/ZA/entries/u1',
  ]);
});

test('the sweep is keyed to the caller and nobody else', async () => {
  const paths = await allLeaderboardPathsFor(storeWith({ '15': ['BR'] }), 'someone-else');

  assert.ok(
    paths.every((path) => path.endsWith('/someone-else') || path === 'leaderboard/someone-else'),
  );
});
