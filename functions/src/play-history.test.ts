import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ANSWER_MS,
  MAX_QUESTION_ID_LENGTH,
  MAX_TAGS_PER_ANSWER,
  MAX_TAG_LENGTH,
  MIN_TAG_LENGTH,
  type PlayAnswer,
  isValidPlayAnswers,
  playRecordFrom,
} from './play-history';

const NOW = 1_757_900_000_000;

function answer(overrides: Partial<PlayAnswer> = {}): PlayAnswer {
  return {
    questionId: 'bank-question-1',
    correct: true,
    ms: 4_200,
    difficulty: 'medium',
    tags: ['world-war-2'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Accept cases first, deliberately. `CLAUDE.md` §4.6: a suite of nothing but
// reject cases passes against a validator that refuses everything, and that has
// already shipped once in this repo.
// ---------------------------------------------------------------------------

test('accepts one well-formed answer for a one-question game', () => {
  assert.equal(isValidPlayAnswers([answer()], 1), true);
});

test('accepts a full 25-question game', () => {
  const answers = Array.from({ length: 25 }, (_, index) =>
    answer({ questionId: `bank-question-${index}` }),
  );

  assert.equal(isValidPlayAnswers(answers, 25), true);
});

/**
 * An Open Trivia DB question: no id, no tags. This is the majority case today
 * and stays so until the bank is big enough to retire the external source, so
 * it is the shape most worth pinning.
 */
test('accepts an answer with neither a question id nor tags', () => {
  assert.equal(isValidPlayAnswers([{ correct: false, ms: 15_000, difficulty: 'hard' }], 1), true);
});

test('accepts an empty tag list', () => {
  assert.equal(isValidPlayAnswers([answer({ tags: [] })], 1), true);
});

test('accepts every difficulty the app offers', () => {
  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    assert.equal(isValidPlayAnswers([answer({ difficulty })], 1), true, difficulty);
  }
});

test('accepts every bound at its inclusive edge', () => {
  assert.equal(isValidPlayAnswers([answer({ ms: 0 })], 1), true, 'answered instantly');
  assert.equal(isValidPlayAnswers([answer({ ms: MAX_ANSWER_MS })], 1), true, 'the slowest answer');
  assert.equal(
    isValidPlayAnswers([answer({ questionId: 'x'.repeat(MAX_QUESTION_ID_LENGTH) })], 1),
    true,
    'the longest question id',
  );
  assert.equal(
    isValidPlayAnswers(
      [answer({ tags: Array.from({ length: MAX_TAGS_PER_ANSWER }, (_, i) => `tag-${i}`) })],
      1,
    ),
    true,
    'the most tags',
  );
  assert.equal(
    isValidPlayAnswers([answer({ tags: ['x'.repeat(MAX_TAG_LENGTH)] })], 1),
    true,
    'the longest tag',
  );
  assert.equal(
    isValidPlayAnswers([answer({ tags: ['x'.repeat(MIN_TAG_LENGTH)] })], 1),
    true,
    'the shortest tag',
  );
});

// ---------------------------------------------------------------------------
// The array itself
// ---------------------------------------------------------------------------

/**
 * The length bound is an equality, not a ceiling. A short array is not a
 * smaller history — it is one that has lost track of which question each entry
 * belongs to, because the array is positional.
 */
test('refuses an array that does not describe this game', () => {
  assert.equal(isValidPlayAnswers([answer(), answer()], 3), false, 'too short');
  assert.equal(isValidPlayAnswers([answer(), answer(), answer()], 2), false, 'too long');
  assert.equal(isValidPlayAnswers([], 1), false, 'empty for a game with a question');
});

test('accepts an empty array only for a game with no questions', () => {
  // Unreachable through the app — `isValidSubmission` requires at least one
  // question — and pinned anyway, because it is what makes the rule above an
  // equality rather than a special case with an exception in it.
  assert.equal(isValidPlayAnswers([], 0), true);
});

test('refuses anything that is not an array', () => {
  for (const bad of [null, undefined, 'answers', 42, {}, { length: 1 }]) {
    assert.equal(isValidPlayAnswers(bad, 1), false, JSON.stringify(bad) ?? 'undefined');
  }
});

// ---------------------------------------------------------------------------
// Per-entry bounds. Every one of these is a value somebody could send.
// ---------------------------------------------------------------------------

test('refuses an entry that is not an object', () => {
  for (const bad of [null, undefined, 'answered', 1, []]) {
    assert.equal(isValidPlayAnswers([bad], 1), false, JSON.stringify(bad) ?? 'undefined');
  }
});

test('refuses a question id that is empty, over-long or not a string', () => {
  assert.equal(isValidPlayAnswers([answer({ questionId: '' })], 1), false);
  assert.equal(
    isValidPlayAnswers([answer({ questionId: 'x'.repeat(MAX_QUESTION_ID_LENGTH + 1) })], 1),
    false,
  );
  assert.equal(
    isValidPlayAnswers([{ ...answer(), questionId: 42 } as unknown as PlayAnswer], 1),
    false,
  );
});

test('refuses a correctness flag that is not a boolean', () => {
  for (const bad of [undefined, null, 'true', 1, 0]) {
    assert.equal(
      isValidPlayAnswers([{ ...answer(), correct: bad } as unknown as PlayAnswer], 1),
      false,
      JSON.stringify(bad) ?? 'undefined',
    );
  }
});

test('refuses a duration outside the plausible range', () => {
  for (const bad of [-1, MAX_ANSWER_MS + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isValidPlayAnswers([answer({ ms: bad })], 1), false, String(bad));
  }
  assert.equal(
    isValidPlayAnswers([{ ...answer(), ms: '1000' } as unknown as PlayAnswer], 1),
    false,
    'a numeric string',
  );
  assert.equal(
    isValidPlayAnswers([{ ...answer(), ms: undefined } as unknown as PlayAnswer], 1),
    false,
    'absent',
  );
});

test('refuses a difficulty outside the three the app has', () => {
  for (const bad of ['Easy', 'expert', '', undefined, null, 1]) {
    assert.equal(
      isValidPlayAnswers([{ ...answer(), difficulty: bad } as unknown as PlayAnswer], 1),
      false,
      JSON.stringify(bad) ?? 'undefined',
    );
  }
});

test('refuses more tags than a question may carry', () => {
  const tags = Array.from({ length: MAX_TAGS_PER_ANSWER + 1 }, (_, i) => `tag-${i}`);

  assert.equal(isValidPlayAnswers([answer({ tags })], 1), false);
});

/**
 * The tag *shape*, not merely its length. These are the strings
 * `normalizeTag()` can never produce and `firestore.rules` refuses on
 * `custom_questions` — spelled again here because `functions/` cannot import
 * the normaliser, which is exactly where the two could drift apart.
 */
test('refuses a tag that is not in the normalised shape', () => {
  for (const bad of [
    'World War 2',
    'world_war_2',
    'World-War-2',
    '-leading',
    'trailing-',
    'double--hyphen',
    'a',
    'x'.repeat(MAX_TAG_LENGTH + 1),
    'matemática',
    '',
  ]) {
    assert.equal(isValidPlayAnswers([answer({ tags: [bad] })], 1), false, bad);
  }
});

test('refuses a tag list that is not an array of strings', () => {
  assert.equal(
    isValidPlayAnswers([{ ...answer(), tags: 'world-war-2' } as unknown as PlayAnswer], 1),
    false,
  );
  assert.equal(
    isValidPlayAnswers([{ ...answer(), tags: [42] } as unknown as PlayAnswer], 1),
    false,
  );
});

test('refuses a whole game because one entry is bad', () => {
  const answers = [answer(), answer({ ms: -1 }), answer()];

  assert.equal(isValidPlayAnswers(answers, 3), false);
});

// ---------------------------------------------------------------------------
// What actually gets stored
// ---------------------------------------------------------------------------

test('stores nothing when the submission carried no answers', () => {
  assert.equal(playRecordFrom(undefined, NOW), null);
});

/**
 * `null` is the *same* case, and the reason is on the wire rather than in the
 * game: `encode()` in `@firebase/functions` maps a present-but-`undefined` key
 * to `null`, so `{ answers: buildPlayAnswers(...) }` arrives as `null` and
 * omitting the key arrives as `undefined`. Whether the player keeps their
 * lifetime totals must not turn on which way the caller spelled its object.
 */
test('stores nothing when the answers field arrived as null', () => {
  assert.equal(playRecordFrom(null, NOW), null);
});

test('stamps the document with the instant the game was banked', () => {
  assert.equal(playRecordFrom([answer()], NOW)?.at, NOW);
});

/**
 * **The exact-key allowlist, server side.** `users/{uid}` has no client write
 * path and therefore no `hasOnly()` to lean on, so the payload is rebuilt key
 * by key rather than passed through — otherwise anything else the client put in
 * the object would be stored alongside the fields this schema names.
 */
test('drops a key nothing has allowlisted', () => {
  const record = playRecordFrom(
    [{ ...answer(), nickname: 'anything at all', tags: ['ok-tag'] } as unknown as PlayAnswer],
    NOW,
  );

  assert.deepEqual(record?.answers, [
    {
      correct: true,
      ms: 4_200,
      difficulty: 'medium',
      questionId: 'bank-question-1',
      tags: ['ok-tag'],
    },
  ]);
});

/**
 * An absent key stays absent rather than becoming `undefined`: Firestore
 * rejects an `undefined` field value outright, so writing one would turn every
 * Open Trivia game into an `internal` error from inside the transaction.
 */
test('omits the question id and the tags rather than writing undefined', () => {
  const record = playRecordFrom([{ correct: false, ms: 900, difficulty: 'easy' }], NOW);
  const [stored] = record?.answers ?? [];

  assert.deepEqual(stored, { correct: false, ms: 900, difficulty: 'easy' });
  assert.equal('questionId' in stored, false);
  assert.equal('tags' in stored, false);
});

test('omits an empty tag list, which says what an absent key already says', () => {
  const [stored] = playRecordFrom([answer({ tags: [] })], NOW)?.answers ?? [];

  assert.equal('tags' in stored, false);
});

test('copies the tag list rather than keeping the caller array', () => {
  const tags = ['world-war-2'];
  const record = playRecordFrom([answer({ tags })], NOW);
  tags.push('mutated-after-the-fact');

  assert.deepEqual(record?.answers[0].tags, ['world-war-2']);
});

test('keeps the answers in the order they were asked', () => {
  const record = playRecordFrom(
    [answer({ questionId: 'first' }), answer({ questionId: 'second' })],
    NOW,
  );

  assert.deepEqual(
    record?.answers.map((a) => a.questionId),
    ['first', 'second'],
  );
});
