/**
 * The leaderboard boards, one per timing constraint (finding G7).
 *
 * Must match `isValidBoard` in `firestore.rules` and `TIME_LIMIT_OPTIONS` in
 * the client's `question.model.ts`. Kept here rather than inlined at each call
 * site because account deletion and account export both have to visit *every*
 * board — a list that is written out twice is a list that will eventually be
 * updated once.
 */
export const LEADERBOARD_BOARDS = ['15', '30', 'unlimited'] as const;

/**
 * The pre-G7 flat collection. Still swept on delete: it is retired and
 * read-only, but the documents are still there until they are cleaned up, and
 * "delete my account" that leaves a public score behind is the one failure
 * mode this function exists to prevent.
 */
export const LEGACY_LEADERBOARD_COLLECTION = 'leaderboard';

/** The per-country boards under each timing constraint (`FEAT-028`). */
export const REGIONS_SUBCOLLECTION = 'regions';

/** Every *global* document path a user's scores can live at, boards plus the legacy collection. */
export function leaderboardPathsFor(uid: string): string[] {
  return [
    ...LEADERBOARD_BOARDS.map((board) => `leaderboards/${board}/entries/${uid}`),
    `${LEGACY_LEADERBOARD_COLLECTION}/${uid}`,
  ];
}

/** One regional entry: where it lives, and the two path segments that say what it is. */
export interface RegionalEntryRef {
  board: string;
  region: string;
  path: string;
}

/**
 * The subset of the Admin SDK's `Firestore` these helpers need.
 *
 * Structural rather than the real type so the enumeration can be unit-tested
 * against a fake — the decision worth pinning is *which documents get visited*,
 * and standing up Firestore to check it would be the reason nobody checks it.
 * Same reasoning as `role.ts` and `account-policy.ts`.
 */
export interface LeaderboardStore {
  collection(path: string): { listDocuments(): Promise<{ id: string }[]> };
}

/**
 * Every regional entry a user could hold, found by asking Firestore which
 * country boards exist rather than by guessing.
 *
 * **`listDocuments()` on `leaderboards/{board}/regions`, and this is the whole
 * trick.** Nothing ever writes a `regions/{region}` document — the country is
 * a path segment, so the document is a *missing parent* whose only content is
 * the `entries` subcollection beneath it. A `get()` on it returns nothing and
 * a query over the collection returns nothing; `listDocuments()` is the one
 * Admin SDK call documented to return references to missing parents that have
 * subcollections, which is exactly the shape this schema produces.
 *
 * **Deliberately not a collection-group query.** `collectionGroup('entries')`
 * filtered by uid would find these in one read, and it would need a
 * collection-group index in `firestore.indexes.json` — index configuration
 * being the one thing the emulator cannot verify, and the mistake that took
 * the deploy pipeline down for four consecutive merges (D3). The cost of
 * avoiding it is one `listDocuments()` per board, bounded by the number of
 * countries that have ever saved a score rather than by anything a caller
 * controls.
 */
export async function regionalEntryRefsFor(
  store: LeaderboardStore,
  uid: string,
): Promise<RegionalEntryRef[]> {
  const perBoard = await Promise.all(
    LEADERBOARD_BOARDS.map(async (board) => {
      const regions = await store
        .collection(`leaderboards/${board}/${REGIONS_SUBCOLLECTION}`)
        .listDocuments();
      return regions.map((region) => ({
        board,
        region: region.id,
        path: `leaderboards/${board}/${REGIONS_SUBCOLLECTION}/${region.id}/entries/${uid}`,
      }));
    }),
  );
  return perBoard.flat();
}

/**
 * Every leaderboard document path a user's scores can live at — the global
 * boards, the legacy collection, and every regional board in use.
 *
 * One function so deletion and export cannot disagree about what a player's
 * scores *are*: an export that returned fewer boards than deletion removes
 * would tell a user their data was somewhere it is not, and an export that
 * returned more would be the same bug pointing the other way.
 */
export async function allLeaderboardPathsFor(
  store: LeaderboardStore,
  uid: string,
): Promise<string[]> {
  const regional = await regionalEntryRefsFor(store, uid);
  return [...leaderboardPathsFor(uid), ...regional.map((entry) => entry.path)];
}
