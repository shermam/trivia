import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MAX_TAGS_PER_ANSWER,
  MAX_TAG_LENGTH,
  MIN_TAG_LENGTH,
  isValidPlayAnswers,
} from './play-history';

/**
 * `question-bounds.json` — the bounds `firestore.rules` holds on a question, as
 * the repository publishes them — against this package's copies of the two a
 * play record restates: the topic tags and the difficulty.
 *
 * A play record snapshots both from each question the player met
 * (`play-history.ts`), and `recordGameResult` refuses the whole game when the
 * record fails its shape check. So the shape here has to admit everything a
 * question may carry: a tag the rules let onto a question and this module
 * refused would cost every player who met that question their game. The copies
 * are spelled again rather than imported — `functions/` cannot reach `src/` —
 * and this holds them to the published file, which
 * `firestore-tests/question-bounds.rules.spec.ts` holds to the rules.
 *
 * Read relative to the compiled test, two levels above `lib/`. Test-only:
 * nothing the deployed functions run reads it.
 */
const bounds = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'question-bounds.json'), 'utf8'),
) as {
  tags: { maxCount: number; minLength: number; maxLength: number; pattern: string };
  difficulty: { values: string[] };
};

/** One answer carrying the given tags, in an otherwise valid one-question record. */
const recordWithTags = (tags: string[]) => [{ correct: true, ms: 1_000, difficulty: 'easy', tags }];

test('names the published tag count and lengths', () => {
  assert.equal(MAX_TAGS_PER_ANSWER, bounds.tags.maxCount);
  assert.equal(MIN_TAG_LENGTH, bounds.tags.minLength);
  assert.equal(MAX_TAG_LENGTH, bounds.tags.maxLength);
});

test('admits exactly the tags the published pattern and lengths admit', () => {
  // Applied as a full match, the way the rules' `matches()` applies it.
  const shape = new RegExp(`^(?:${bounds.tags.pattern})$`);
  const { minLength, maxLength } = bounds.tags;
  for (const tag of [
    'history',
    'world-war-2',
    'a1',
    'History',
    'world_war_2',
    'world war 2',
    '-history',
    'history-',
    'world--war',
    'café',
    'history\n',
    'a',
    'a'.repeat(maxLength),
    'a'.repeat(maxLength + 1),
  ]) {
    const published = shape.test(tag) && tag.length >= minLength && tag.length <= maxLength;
    assert.equal(isValidPlayAnswers(recordWithTags([tag]), 1), published, JSON.stringify(tag));
  }
});

test('admits as many tags as a question may carry, and no more', () => {
  const tags = (n: number) => Array.from({ length: n }, (_, i) => `topic-${i + 1}`);
  assert.equal(isValidPlayAnswers(recordWithTags(tags(bounds.tags.maxCount)), 1), true);
  assert.equal(isValidPlayAnswers(recordWithTags(tags(bounds.tags.maxCount + 1)), 1), false);
});

test('admits exactly the published difficulties', () => {
  for (const difficulty of new Set([...bounds.difficulty.values, 'Easy', 'expert', ''])) {
    const published = bounds.difficulty.values.includes(difficulty);
    assert.equal(
      isValidPlayAnswers([{ correct: true, ms: 1_000, difficulty }], 1),
      published,
      difficulty,
    );
  }
});
