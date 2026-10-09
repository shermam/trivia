import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { type GameResultRefs, applyGameResult } from './game-result';
import { MAX_GAMES_PER_WINDOW, type GameResultSubmission, type UserStats } from './game-stats';
import type { PlayAnswer } from './play-history';

/**
 * `recordGameResult`'s transaction, driven by a fake — the same split
 * `donations.test.ts` makes for `applySupporterSince`.
 *
 * The decision is `nextUserStats`, tested directly in `game-stats.test.ts`, and
 * the counter arithmetic is `question-counters.test.ts`'s. What only this file
 * can see is what the transaction actually does with them: which documents it
 * reads and writes, in what order, and — the half that matters most for
 * `FEAT-023` — which it leaves alone. A refused submission must move no
 * counter, and a game with no history must move none; neither shows up in a
 * decision, only in the writes that follow it.
 */

const NOW = 1_759_900_000_000;
const HOUR = 60 * 60 * 1000;

/** References are opaque to the code under test, so a path string stands in for each. */
const refs: GameResultRefs = {
  user: 'users/player-1' as unknown as DocumentReference,
  play: (gameId) => `users/player-1/plays/${gameId}` as unknown as DocumentReference,
  question: (questionId) => `custom_questions/${questionId}` as unknown as DocumentReference,
};

interface Write {
  op: 'set' | 'update';
  path: string;
  data: Record<string, unknown>;
  /** The options a `set` was given, when it was given any. */
  options?: unknown;
}

/**
 * The slice of a Firestore transaction `applyGameResult` uses, over an
 * in-memory store. It refuses a read after a write, as the real one does, so
 * every test below also pins the ordering.
 */
function fakeTransaction(
  stored: {
    /** A totals document, or one holding something else beside or instead of them. */
    user?: UserStats | Record<string, unknown>;
    questions?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const reads: string[] = [];
  const writes: Write[] = [];
  const readOptions: unknown[] = [];
  const snapshot = (data: Record<string, unknown> | undefined) => ({
    exists: data !== undefined,
    data: () => data,
  });
  const refuseReadAfterWrite = () => {
    if (writes.length > 0) {
      throw new Error('a Firestore transaction refuses a read after its first write');
    }
  };

  const transaction = {
    get: (ref: string) => {
      refuseReadAfterWrite();
      reads.push(ref);
      return Promise.resolve(snapshot(stored.user as unknown as Record<string, unknown>));
    },
    getAll: (...args: unknown[]) => {
      refuseReadAfterWrite();
      const paths = args.filter((arg): arg is string => typeof arg === 'string');
      readOptions.push(...args.filter((arg) => typeof arg !== 'string'));
      reads.push(...paths);
      return Promise.resolve(
        paths.map((path) => snapshot(stored.questions?.[path.replace('custom_questions/', '')])),
      );
    },
    set: (ref: string, data: Record<string, unknown>, options?: unknown) => {
      writes.push({ op: 'set', path: ref, data, ...(options === undefined ? {} : { options }) });
    },
    update: (ref: string, data: Record<string, unknown>) => {
      writes.push({ op: 'update', path: ref, data });
    },
  } as unknown as Transaction;

  return { transaction, reads, writes, readOptions };
}

function storedTotals(overrides: Partial<UserStats> = {}): UserStats {
  return {
    gamesPlayed: 3,
    questionsAnswered: 15,
    correctAnswers: 9,
    bestStreak: 3,
    lastGameId: 'game-0',
    statsSince: NOW - 24 * HOUR,
    updatedAt: NOW - HOUR,
    rateWindowStart: NOW - 10 * 60 * 1000,
    gamesInWindow: 1,
    ...overrides,
  };
}

const answer = (overrides: Partial<PlayAnswer> = {}): PlayAnswer => ({
  questionId: 'bank-1',
  correct: true,
  ms: 4_000,
  difficulty: 'medium',
  ...overrides,
});

/**
 * A three-question game — a bank question answered right, a bank question
 * answered wrong, and an Open Trivia question — with totals that agree with it.
 */
function mixedGame(overrides: Partial<GameResultSubmission> = {}): GameResultSubmission {
  return {
    gameId: 'game-1',
    totalQuestions: 3,
    correctAnswers: 2,
    bestStreak: 1,
    answers: [
      answer({ questionId: 'bank-1', correct: true }),
      answer({ questionId: 'bank-2', correct: false }),
      answer({ questionId: undefined, correct: true }),
    ],
    ...overrides,
  };
}

const questionWrites = (writes: Write[]) =>
  writes.filter((write) => write.path.startsWith('custom_questions/'));

describe('applyGameResult', () => {
  // Accept case first (`CLAUDE.md` §4.6): every refusal below is "nothing was
  // written", which a function that never wrote anything would also satisfy.
  it('adds the game to the counters of each bank question it named', async () => {
    const { transaction, writes } = fakeTransaction({
      user: storedTotals(),
      questions: { 'bank-1': { answered: 4, correct: 2 }, 'bank-2': {} },
    });

    const decision = await applyGameResult(transaction, refs, mixedGame(), NOW);

    assert.equal(decision.accepted, true);
    assert.deepEqual(questionWrites(writes), [
      { op: 'update', path: 'custom_questions/bank-1', data: { answered: 5, correct: 3 } },
      { op: 'update', path: 'custom_questions/bank-2', data: { answered: 1, correct: 0 } },
    ]);
  });

  it('writes the totals and the play history beside the counters, in one transaction', async () => {
    const { transaction, writes } = fakeTransaction({
      questions: { 'bank-1': {}, 'bank-2': {} },
    });

    await applyGameResult(transaction, refs, mixedGame(), NOW);

    assert.deepEqual(
      writes.map((write) => `${write.op} ${write.path}`),
      [
        'set users/player-1',
        'set users/player-1/plays/game-1',
        'update custom_questions/bank-1',
        'update custom_questions/bank-2',
      ],
    );
    assert.equal(writes[0].data['gamesPlayed'], 1);
    assert.equal((writes[1].data['answers'] as unknown[]).length, 3);
  });

  /**
   * **The totals are merged into `users/{uid}`, never written over it**
   * (`FEAT-038`). `setAvatar` keeps the player's avatar choice on the same
   * document, and this write used to be a plain `set` — which replaces the
   * document whole, so every game banked would have erased the choice. What
   * the merge does to a real document is the emulator's to show, and
   * `avatar-choice.spec.ts` plays a game over a stored choice to show it; what
   * only this file can pin is that the option is passed at all.
   */
  it('merges the totals into the document, leaving the avatar choice beside them', async () => {
    const avatar = { kind: 'built', seed: 'core-35', showPublicly: false };
    const { transaction, writes } = fakeTransaction({
      user: { ...storedTotals(), avatar },
      questions: { 'bank-1': {}, 'bank-2': {} },
    });

    await applyGameResult(transaction, refs, mixedGame(), NOW);

    const totals = writes.find((write) => write.path === 'users/player-1');
    assert.deepEqual(totals?.options, { merge: true });
    // The decision writes totals and nothing else, so the merge cannot
    // overwrite the choice either.
    assert.ok(!('avatar' in (totals?.data ?? {})));
  });

  it('banks a first game onto a document that holds only an avatar choice', async () => {
    const { transaction, writes } = fakeTransaction({
      user: { avatar: { kind: 'initials', showPublicly: false } },
      questions: { 'bank-1': {}, 'bank-2': {} },
    });

    const decision = await applyGameResult(transaction, refs, mixedGame(), NOW);

    assert.equal(decision.accepted, true);
    const totals = writes.find((write) => write.path === 'users/player-1');
    assert.equal(totals?.data['gamesPlayed'], 1);
    assert.equal(totals?.data['statsSince'], NOW);
    assert.equal(totals?.data['gamesInWindow'], 1);
  });

  // A counter write that could reach the question's content would be an
  // Admin-SDK path past every rule `custom_questions` has.
  it('writes the two counters and nothing else onto a question', async () => {
    const { transaction, writes, readOptions } = fakeTransaction({
      questions: { 'bank-1': { answered: 1, correct: 1 }, 'bank-2': {} },
    });

    await applyGameResult(transaction, refs, mixedGame(), NOW);

    for (const write of questionWrites(writes)) {
      assert.deepEqual(Object.keys(write.data).sort(), ['answered', 'correct']);
    }
    // ...and reads only those two off each question.
    assert.deepEqual(readOptions, [{ fieldMask: ['answered', 'correct'] }]);
  });

  /**
   * **The test the spec asks for by name.** `/game-over` is restorable by
   * design and a callable that times out gets retried, so a duplicate is the
   * ordinary case — and if it moved a counter, every reload would count the
   * game into its questions again.
   */
  it('moves no counter for a refused duplicate, and reads no question', async () => {
    const { transaction, reads, writes } = fakeTransaction({
      user: storedTotals({ lastGameId: 'game-1' }),
      questions: { 'bank-1': { answered: 4, correct: 2 }, 'bank-2': {} },
    });

    const decision = await applyGameResult(transaction, refs, mixedGame(), NOW);

    assert.deepEqual(decision, { accepted: false, reason: 'duplicate' });
    assert.deepEqual(writes, []);
    assert.deepEqual(reads, ['users/player-1']);
  });

  it('moves no counter for a rate-limited call', async () => {
    const { transaction, reads, writes } = fakeTransaction({
      user: storedTotals({ gamesInWindow: MAX_GAMES_PER_WINDOW }),
      questions: { 'bank-1': {}, 'bank-2': {} },
    });

    const decision = await applyGameResult(transaction, refs, mixedGame(), NOW);

    assert.deepEqual(decision, { accepted: false, reason: 'rate-limited' });
    assert.deepEqual(writes, []);
    assert.deepEqual(reads, ['users/player-1']);
  });

  // Rejected whole rather than truncated: a list that does not cover the game
  // has lost track of which entry belongs to which question.
  it('moves no counter for an outcome list longer than the game', async () => {
    const { transaction, writes } = fakeTransaction({ questions: { 'bank-1': {} } });
    const overLong = mixedGame({
      answers: [...(mixedGame().answers ?? []), answer({ questionId: 'bank-3' })],
    });

    const decision = await applyGameResult(transaction, refs, overLong, NOW);

    assert.deepEqual(decision, { accepted: false, reason: 'invalid' });
    assert.deepEqual(writes, []);
  });

  /**
   * **The other test the spec asks for by name.** A game whose records could
   * not be lined up with its questions — or one from a client that predates the
   * history — banks its totals and leaves no history, and has nothing to count.
   */
  it('moves no counter for a game with no history, and reads no question', async () => {
    const { transaction, reads, writes } = fakeTransaction({ questions: { 'bank-1': {} } });

    const decision = await applyGameResult(
      transaction,
      refs,
      mixedGame({ answers: undefined }),
      NOW,
    );

    assert.equal(decision.accepted, true);
    assert.deepEqual(
      writes.map((write) => write.path),
      ['users/player-1'],
    );
    assert.deepEqual(reads, ['users/player-1']);
  });

  // A game wholly from Open Trivia DB — the commonest game there is — asks for
  // no question at all.
  it('reads no question for a game drawn wholly from Open Trivia DB', async () => {
    const { transaction, reads, writes } = fakeTransaction();
    const openTriviaOnly = mixedGame({
      correctAnswers: 1,
      answers: [
        answer({ questionId: undefined, correct: true }),
        answer({ questionId: undefined, correct: false }),
        answer({ questionId: undefined, correct: false }),
      ],
    });

    const decision = await applyGameResult(transaction, refs, openTriviaOnly, NOW);

    assert.equal(decision.accepted, true);
    assert.deepEqual(reads, ['users/player-1']);
    assert.deepEqual(questionWrites(writes), []);
  });

  /**
   * An author may withdraw a question between the draw and the end of the
   * game. `update` on a missing document fails the whole transaction — the
   * player would lose their totals — and a merging `set` would create a
   * two-field husk of the question the author deleted.
   */
  it('skips a question that no longer exists, and never creates it', async () => {
    const { transaction, writes } = fakeTransaction({
      questions: { 'bank-1': { answered: 4, correct: 2 } },
    });

    const decision = await applyGameResult(transaction, refs, mixedGame(), NOW);

    assert.equal(decision.accepted, true);
    assert.deepEqual(questionWrites(writes), [
      { op: 'update', path: 'custom_questions/bank-1', data: { answered: 5, correct: 3 } },
    ]);
    assert.equal(
      writes.some((write) => write.path === 'custom_questions/bank-2'),
      false,
    );
  });

  /**
   * A question id becomes a path, and a forged one must never be followed:
   * `bank-1/notes/n1` would be a document in a subcollection, which the Admin
   * SDK reads and writes past every rule.
   */
  it('reads and writes nothing for an id that cannot name one question document', async () => {
    const { transaction, reads, writes } = fakeTransaction({
      questions: { 'bank-1/notes/n1': { answered: 4, correct: 2 }, 'bank-2': {} },
    });
    const forged = mixedGame({
      answers: [
        answer({ questionId: 'bank-1/notes/n1', correct: true }),
        answer({ questionId: 'bank-2', correct: false }),
        answer({ questionId: undefined, correct: true }),
      ],
    });

    const decision = await applyGameResult(transaction, refs, forged, NOW);

    assert.equal(decision.accepted, true);
    assert.deepEqual(reads, ['users/player-1', 'custom_questions/bank-2']);
    assert.deepEqual(questionWrites(writes), [
      { op: 'update', path: 'custom_questions/bank-2', data: { answered: 1, correct: 0 } },
    ]);
  });

  it('counts a question once when a forged payload names it in every entry', async () => {
    const { transaction, writes } = fakeTransaction({ questions: { 'bank-1': {} } });
    const forged = mixedGame({
      answers: [
        answer({ questionId: 'bank-1', correct: true }),
        answer({ questionId: 'bank-1', correct: true }),
        answer({ questionId: 'bank-1', correct: false }),
      ],
    });

    await applyGameResult(transaction, refs, forged, NOW);

    assert.deepEqual(questionWrites(writes), [
      { op: 'update', path: 'custom_questions/bank-1', data: { answered: 1, correct: 1 } },
    ]);
  });

  it('replaces a stored pair a hand edit has broken, rather than adding to it', async () => {
    const { transaction, writes } = fakeTransaction({
      questions: { 'bank-1': { answered: 2, correct: 7 }, 'bank-2': { answered: 'many' } },
    });

    await applyGameResult(transaction, refs, mixedGame(), NOW);

    assert.deepEqual(questionWrites(writes), [
      { op: 'update', path: 'custom_questions/bank-1', data: { answered: 1, correct: 1 } },
      { op: 'update', path: 'custom_questions/bank-2', data: { answered: 1, correct: 0 } },
    ]);
  });
});
