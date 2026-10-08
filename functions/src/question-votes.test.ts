import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FieldPath } from 'firebase-admin/firestore';
import {
  QUESTION_VOTES_COLLECTION,
  VOTE_SWEEP_PAGE_SIZE,
  deleteQuestionVotes,
  questionVotesFor,
  voteIdRange,
  type VoteQuery,
  type VoteStore,
} from './question-votes';

/**
 * Which votes account deletion removes and account export returns
 * (`FEAT-027`) — the two sweeps the `{uid}_{questionId}` id order exists for.
 *
 * **The neighbours are the point.** A vote is found by the range of ids that
 * start with its owner's uid, and the failure that matters is a range that is
 * one character too generous: it would delete, or hand to somebody, the votes
 * of an account whose uid merely *begins* the same way. The fake below orders
 * ids the way Firestore does for ASCII — by code point — and applies `>=` and
 * `<` on `__name__` literally, so a wrong bound fails here rather than against
 * a real project.
 *
 * A fake rather than the emulator, because the decision being pinned is which
 * ids the query names, not whether Firestore can delete a document. The e2e
 * suite runs the same sweep against the emulator's real ordering
 * (`question-votes.spec.ts`).
 */

interface Filter {
  op: '>=' | '<';
  value: string;
}

function fakeStore(ids: string[]) {
  const docs = new Map(
    ids.map((id) => [id, { questionId: id.slice(id.indexOf('_') + 1), value: 1, createdAt: 1 }]),
  );
  const commits: string[][] = [];

  const queryOver = (filters: Filter[], max?: number): VoteQuery => ({
    where(field, op, value) {
      assert.ok(field.isEqual(FieldPath.documentId()), 'the range is on the document id');
      return queryOver([...filters, { op, value }], max);
    },
    limit(count) {
      return queryOver(filters, count);
    },
    get() {
      const matched = [...docs.keys()]
        .sort()
        .filter((id) => filters.every(({ op, value }) => (op === '>=' ? id >= value : id < value)))
        .slice(0, max);
      return Promise.resolve({
        docs: matched.map((id) => ({ id, ref: { id }, data: () => ({ ...docs.get(id) }) })),
      });
    },
  });

  const store: VoteStore = {
    collection(path) {
      assert.equal(path, QUESTION_VOTES_COLLECTION);
      return queryOver([]);
    },
    batch() {
      const pending: string[] = [];
      return {
        delete(ref) {
          pending.push((ref as { id: string }).id);
        },
        commit() {
          commits.push([...pending]);
          for (const id of pending) {
            docs.delete(id);
          }
          return Promise.resolve();
        },
      };
    },
  };

  return { store, remaining: () => [...docs.keys()].sort(), commits };
}

/**
 * Ids that are somebody else's but sit as close to `abc`'s as an id can: a
 * longer uid starting with the same letters (lower case, a digit, upper case),
 * a shorter uid it starts with, and an unrelated one.
 */
const NEIGHBOURS = ['abcd_q1', 'abc0_q1', 'abcZ_q1', 'ab_q1', 'xyz_q1'];

test('the range is the uid and an underscore, up to the next code point', () => {
  assert.deepEqual(voteIdRange('abc'), { start: 'abc_', end: 'abc`' });
});

test('export returns every vote the account cast, whole, and nobody else’s', async () => {
  const { store } = fakeStore(['abc_q1', 'abc_q2', ...NEIGHBOURS]);

  const votes = await questionVotesFor(store, 'abc');

  assert.deepEqual(votes, [
    { id: 'abc_q1', questionId: 'q1', value: 1, createdAt: 1 },
    { id: 'abc_q2', questionId: 'q2', value: 1, createdAt: 1 },
  ]);
});

test('export of an account that never voted is an empty list', async () => {
  const { store } = fakeStore(NEIGHBOURS);

  assert.deepEqual(await questionVotesFor(store, 'abc'), []);
});

test('deletion removes the account’s votes and leaves every neighbour', async () => {
  const { store, remaining } = fakeStore(['abc_q1', 'abc_q2', ...NEIGHBOURS]);

  const deleted = await deleteQuestionVotes(store, 'abc');

  assert.equal(deleted, 2);
  assert.deepEqual(remaining(), [...NEIGHBOURS].sort());
});

/**
 * A `WriteBatch` holds 500 writes. A long-standing player's votes can be more
 * than that, and a sweep that deleted one batch and stopped would report
 * success with the rest still there.
 */
test('deletion pages through more votes than one batch can hold', async () => {
  const mine = Array.from({ length: VOTE_SWEEP_PAGE_SIZE * 2 + 1 }, (_, i) => `abc_q${i}`);
  const { store, remaining, commits } = fakeStore([...mine, ...NEIGHBOURS]);

  const deleted = await deleteQuestionVotes(store, 'abc');

  assert.equal(deleted, mine.length);
  assert.deepEqual(
    commits.map((batch) => batch.length),
    [VOTE_SWEEP_PAGE_SIZE, VOTE_SWEEP_PAGE_SIZE, 1],
  );
  assert.deepEqual(remaining(), [...NEIGHBOURS].sort());
});

// A full last page cannot tell the loop it was the last, so it reads once more
// and finds nothing — one empty read, and no empty batch committed.
test('deletion of exactly one full page reads once more and commits nothing further', async () => {
  const mine = Array.from({ length: VOTE_SWEEP_PAGE_SIZE }, (_, i) => `abc_q${i}`);
  const { store, commits } = fakeStore(mine);

  assert.equal(await deleteQuestionVotes(store, 'abc'), VOTE_SWEEP_PAGE_SIZE);
  assert.deepEqual(
    commits.map((batch) => batch.length),
    [VOTE_SWEEP_PAGE_SIZE],
  );
});

test('deletion for an account that never voted commits nothing', async () => {
  const { store, commits } = fakeStore(NEIGHBOURS);

  assert.equal(await deleteQuestionVotes(store, 'abc'), 0);
  assert.deepEqual(commits, []);
});
