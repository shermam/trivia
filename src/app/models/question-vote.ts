/**
 * A player's private like or dislike of one community question (`FEAT-027`).
 *
 * `1` is a like and `-1` a dislike, and nothing else is a vote:
 * `firestore.rules` refuses any other value. No vote at all is the absence of
 * a document, never a third value — so "not voted" is `null` everywhere a
 * caller can see it.
 */
export type VoteValue = 1 | -1;

export const LIKE: VoteValue = 1;
export const DISLIKE: VoteValue = -1;

/** Where every account's votes live, one document per account per question. */
export const QUESTION_VOTES_COLLECTION = 'question_votes';

/**
 * A vote's document id: `{uid}_{questionId}`.
 *
 * **Uid first, and the order is load-bearing.** It makes one vote per account
 * per question a property of the key, it is the ownership check
 * `firestore.rules` reads, and it is what lets `deleteAccount` and
 * `exportAccountData` find an account's votes as one range of ids — nothing
 * can query an id by its suffix. Mirrored in `firestore-tests/helpers.ts` and
 * `functions/src/question-votes.ts`; if they disagree, every vote is refused.
 */
export function questionVoteId(uid: string, questionId: string): string {
  return `${uid}_${questionId}`;
}

/** Whether a value read back from Firestore is a vote this app understands. */
export function isVoteValue(value: unknown): value is VoteValue {
  return value === LIKE || value === DISLIKE;
}
