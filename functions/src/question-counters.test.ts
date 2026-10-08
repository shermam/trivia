import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlayAnswer } from './play-history';
import {
  type QuestionCounterIncrement,
  counterIncrementsFrom,
  nextQuestionCounters,
  storedCountersFrom,
} from './question-counters';

/**
 * The per-question difficulty counters (`FEAT-023`): what one game's records
 * add to them, and what a stored pair becomes once they are added. The
 * transaction that applies these is `game-result.test.ts`'s subject; here is
 * the arithmetic it applies.
 */

const answer = (overrides: Partial<PlayAnswer> = {}): PlayAnswer => ({
  questionId: 'bank-1',
  correct: true,
  ms: 2_000,
  difficulty: 'medium',
  ...overrides,
});

describe('counterIncrementsFrom', () => {
  // Accept cases first (`CLAUDE.md` §4.6): a function that counted nothing at
  // all would pass every "counts nothing" row below.
  it('counts one answer per bank question, and one right answer where it was right', () => {
    const increments = counterIncrementsFrom([
      answer({ questionId: 'bank-1', correct: true }),
      answer({ questionId: 'bank-2', correct: false }),
    ]);

    assert.deepEqual(increments, [
      { questionId: 'bank-1', answered: 1, correct: 1 },
      { questionId: 'bank-2', answered: 1, correct: 0 },
    ]);
  });

  // An Open Trivia question has no document to count against: its id is
  // minted per fetch, so the record carries none.
  it('counts nothing for an entry with no question id', () => {
    const increments = counterIncrementsFrom([
      answer({ questionId: undefined, correct: true }),
      answer({ questionId: 'bank-2', correct: true }),
      answer({ questionId: undefined, correct: false }),
    ]);

    assert.deepEqual(increments, [{ questionId: 'bank-2', answered: 1, correct: 1 }]);
  });

  /**
   * The id becomes a path, `custom_questions/{id}`, so one that is not a single
   * document id counts nothing — never followed into a subcollection, and
   * never left to throw inside the transaction.
   */
  it('counts nothing for an id that cannot name one question document', () => {
    const increments = counterIncrementsFrom([
      answer({ questionId: 'bank-1/notes/n1' }),
      answer({ questionId: 'a/b' }),
      answer({ questionId: '.' }),
      answer({ questionId: '..' }),
      answer({ questionId: '__name__' }),
      answer({ questionId: 'bank-2', correct: false }),
    ]);

    assert.deepEqual(increments, [{ questionId: 'bank-2', answered: 1, correct: 0 }]);
  });

  it('counts an id that merely looks unusual', () => {
    const ids = ['a.b', '...', '__x', 'x__', '_'];
    const increments = counterIncrementsFrom(ids.map((questionId) => answer({ questionId })));

    assert.deepEqual(
      increments.map((increment) => increment.questionId),
      ids,
    );
  });

  it('counts nothing for a game drawn wholly from Open Trivia DB', () => {
    assert.deepEqual(
      counterIncrementsFrom([answer({ questionId: undefined }), answer({ questionId: undefined })]),
      [],
    );
  });

  // A game with no history — a pre-feature client, or a save whose records
  // could not be lined up — arrives as either, and moves no counter either way.
  it('counts nothing for a game with no history, absent or null', () => {
    assert.deepEqual(counterIncrementsFrom(undefined), []);
    assert.deepEqual(counterIncrementsFrom(null), []);
  });

  /**
   * **The bound the spec states: one honest game's worth per call.** A real
   * game never names one bank question twice, so this only ever meets a forged
   * payload — and without it, a single call naming one question twenty-five
   * times would move its counters by twenty-five answers.
   */
  it('counts a question once however many entries name it, taking the first', () => {
    const forged = Array.from({ length: 25 }, (_, index) =>
      answer({ questionId: 'bank-1', correct: index !== 0 }),
    );

    assert.deepEqual(counterIncrementsFrom(forged), [
      { questionId: 'bank-1', answered: 1, correct: 0 },
    ]);
  });

  /**
   * `correct <= answered` for whatever an accepted payload can say: each
   * increment's right answer comes from the same entry as its answer, so a
   * payload has no way to claim a question was answered right without its
   * being counted as answered.
   */
  it('never produces more right answers than answers', () => {
    const payloads: PlayAnswer[][] = [
      [answer({ correct: true })],
      [answer({ correct: false })],
      [answer({ correct: true }), answer({ correct: true })],
      [answer({ questionId: 'a', correct: true }), answer({ questionId: 'b', correct: false })],
    ];
    for (const payload of payloads) {
      for (const increment of counterIncrementsFrom(payload)) {
        assert.ok(increment.correct <= increment.answered, JSON.stringify(increment));
        assert.equal(increment.answered, 1);
      }
    }
  });
});

describe('storedCountersFrom', () => {
  it('reads a pair the callable wrote', () => {
    assert.deepEqual(storedCountersFrom({ answered: 12, correct: 5 }), {
      answered: 12,
      correct: 5,
    });
  });

  // Every question nobody has finished a game with yet, and every question
  // written before the counters existed — the same reading `firestore.rules`
  // gives an absent counter.
  it('reads an absent pair, or an absent half, as zero', () => {
    assert.deepEqual(storedCountersFrom({}), { answered: 0, correct: 0 });
    assert.deepEqual(storedCountersFrom(undefined), { answered: 0, correct: 0 });
    assert.deepEqual(storedCountersFrom({ answered: 3 }), { answered: 3, correct: 0 });
  });

  it('accepts every answer right, which is correct equal to answered', () => {
    assert.deepEqual(storedCountersFrom({ answered: 4, correct: 4 }), { answered: 4, correct: 4 });
  });

  // Only a hand edit in the console can produce any of these.
  it('refuses a pair that is not two whole, non-negative counts with correct <= answered', () => {
    for (const broken of [
      { answered: 3, correct: 4 },
      { answered: -1, correct: 0 },
      { answered: 5, correct: -1 },
      { answered: 2.5, correct: 1 },
      { answered: 5, correct: 1.5 },
      { answered: '5', correct: 1 },
      { answered: 5, correct: true },
      { correct: 1 },
    ]) {
      assert.equal(storedCountersFrom(broken), null, JSON.stringify(broken));
    }
  });
});

describe('nextQuestionCounters', () => {
  const right: Pick<QuestionCounterIncrement, 'answered' | 'correct'> = { answered: 1, correct: 1 };
  const wrong: Pick<QuestionCounterIncrement, 'answered' | 'correct'> = { answered: 1, correct: 0 };

  it('adds one game to the stored pair', () => {
    assert.deepEqual(nextQuestionCounters({ answered: 9, correct: 4 }, right), {
      answered: 10,
      correct: 5,
    });
    assert.deepEqual(nextQuestionCounters({ answered: 9, correct: 4 }, wrong), {
      answered: 10,
      correct: 4,
    });
  });

  it("starts a question's first counts from this game", () => {
    assert.deepEqual(nextQuestionCounters({}, right), { answered: 1, correct: 1 });
    assert.deepEqual(nextQuestionCounters(undefined, wrong), { answered: 1, correct: 0 });
  });

  /**
   * Adding to a broken pair would carry the damage forward — and the owner's
   * edit validates the stored pair, so a pair `firestore.rules` refuses would
   * stop the question's author editing it. Starting again from this game is
   * the reading of a count nobody can trust.
   */
  it('replaces a broken pair rather than adding to it', () => {
    assert.deepEqual(nextQuestionCounters({ answered: 3, correct: 9 }, right), {
      answered: 1,
      correct: 1,
    });
    assert.deepEqual(nextQuestionCounters({ answered: 'lots', correct: 2 }, wrong), {
      answered: 1,
      correct: 0,
    });
  });
});
