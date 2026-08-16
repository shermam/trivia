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

/** Every document path a user's scores can live at, boards plus the legacy collection. */
export function leaderboardPathsFor(uid: string): string[] {
  return [
    ...LEADERBOARD_BOARDS.map((board) => `leaderboards/${board}/entries/${uid}`),
    `${LEGACY_LEADERBOARD_COLLECTION}/${uid}`,
  ];
}
