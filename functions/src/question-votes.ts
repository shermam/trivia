import { FieldPath } from 'firebase-admin/firestore';

/**
 * Every account's private likes and dislikes of community questions
 * (`FEAT-027`), one document per account per question.
 */
export const QUESTION_VOTES_COLLECTION = 'question_votes';

/**
 * How many votes one deletion page reads and one batch deletes — the most a
 * single `WriteBatch` may carry.
 */
export const VOTE_SWEEP_PAGE_SIZE = 500;

/**
 * The half-open range of document ids that belong to one account:
 * `[start, end)`.
 *
 * **Vote ids are `{uid}_{questionId}`, uid first, and this range is the whole
 * reason for that order.** Nothing can query a document id by its suffix, so
 * with the question first an account's votes could be neither found nor
 * deleted; with the uid first they are one contiguous run of ids, and a range
 * on `__name__` reads exactly that run.
 *
 * `end` is the prefix with its trailing `_` (U+005F) replaced by the next code
 * point, `` ` `` (U+0060). Every id that starts with `${uid}_` sorts at or after
 * `start` and before `end`, and no other id does — **provided no uid contains
 * `_`**, which holds because Firebase-minted uids are alphanumeric and this app
 * mints no custom tokens (the same assumption `firestore.rules` makes for the
 * prefix check). Letters and digits all sort either below `_` (digits and
 * upper case) or at or above `` ` `` (lower case), so a longer uid that begins
 * with this one — `abc` and `abcd`, `abc` and `abc0` — falls outside the range
 * on its next character. `question-votes.test.ts` pins those neighbours.
 */
export function voteIdRange(uid: string): { start: string; end: string } {
  return { start: `${uid}_`, end: `${uid}\`` };
}

/**
 * The subset of the Admin SDK's `Firestore` these sweeps use.
 *
 * Structural rather than the real type so the sweeps can be unit-tested
 * against a fake — the decision worth pinning is *which documents get
 * visited*, and standing up Firestore to check it would be the reason nobody
 * checks it. Same reasoning as `leaderboards.ts`.
 */
export interface VoteStore {
  collection(path: string): VoteQuery;
  batch(): VoteBatch;
}

export interface VoteQuery {
  where(field: FieldPath, op: '>=' | '<', value: string): VoteQuery;
  limit(count: number): VoteQuery;
  get(): Promise<{ docs: VoteSnapshot[] }>;
}

export interface VoteSnapshot {
  id: string;
  ref: VoteRef;
  data(): Record<string, unknown>;
}

/** What a batch deletes. Opaque here: whatever the store's snapshots hand back. */
export type VoteRef = object;

export interface VoteBatch {
  delete(ref: VoteRef): unknown;
  commit(): Promise<unknown>;
}

/** One account's votes, as a query over its id range. */
function votesOf(store: VoteStore, uid: string): VoteQuery {
  const { start, end } = voteIdRange(uid);
  return store
    .collection(QUESTION_VOTES_COLLECTION)
    .where(FieldPath.documentId(), '>=', start)
    .where(FieldPath.documentId(), '<', end);
}

/**
 * Every vote the account has cast, for `exportAccountData` — each one whole,
 * with its document id, the way every other collection in the export carries
 * its own.
 *
 * One query rather than pages: an account holds at most one vote per question
 * the bank has ever held (`firestore.rules` checks `exists()` on create), so
 * the read is bounded by the bank rather than by anything a caller controls.
 */
export async function questionVotesFor(
  store: VoteStore,
  uid: string,
): Promise<Record<string, unknown>[]> {
  const snapshot = await votesOf(store, uid).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/**
 * Deletes every vote the account has cast, for `deleteAccount`, and returns
 * how many went.
 *
 * Paged and batched rather than read whole, because a long-standing player's
 * votes can outnumber one `WriteBatch`'s 500 writes. Each page is re-queried
 * from the start of the range, because the page before it is gone by then —
 * there is no cursor to carry, and a short page is the end.
 */
export async function deleteQuestionVotes(store: VoteStore, uid: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await votesOf(store, uid).limit(VOTE_SWEEP_PAGE_SIZE).get();
    if (page.docs.length === 0) {
      return deleted;
    }
    const batch = store.batch();
    for (const doc of page.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    deleted += page.docs.length;
    if (page.docs.length < VOTE_SWEEP_PAGE_SIZE) {
      return deleted;
    }
  }
}
