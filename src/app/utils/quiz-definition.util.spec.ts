import {
  QUIZ_DESCRIPTION_MAX_LENGTH,
  QUIZ_MAX_QUESTIONS,
  QUIZ_MAX_TAGS,
  QUIZ_TITLE_MAX_LENGTH,
} from '../models/quiz.model';
import { isDocumentReference, readQuiz, validateQuizDefinition } from './quiz-definition.util';

/**
 * The bounds a curated quiz is written within (`FEAT-024`).
 *
 * **There is no client write rule, so this is the only validator a quiz has**
 * — `scripts/seed-quiz.mjs` imports it from the app's source — and every bound
 * is pinned at both edges: the largest value it accepts and the smallest it
 * refuses. A bound tested only from one side passes against a validator that
 * has drifted by one.
 */

/** A definition every bound accepts; spread over it for the variants. */
function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'world-cup-1998',
    title: 'The 1998 World Cup',
    description: 'Ten questions, in the order the tournament played them.',
    questionIds: ['q-1', 'q-2', 'q-3'],
    createdBy: 'curator-uid',
    isPublished: false,
    ...overrides,
  };
}

function problemsOf(input: unknown): string[] {
  const result = validateQuizDefinition(input);
  return result.ok ? [] : result.problems;
}

/** `n` distinct question ids. */
const ids = (n: number) => Array.from({ length: n }, (_, index) => `q-${index}`);

describe('validateQuizDefinition — what passes', () => {
  it('accepts a minimal definition and returns it cleaned', () => {
    const result = validateQuizDefinition(
      definition({ title: '  The 1998 World Cup  ', description: undefined }),
    );
    expect(result).toEqual({
      ok: true,
      definition: {
        id: 'world-cup-1998',
        title: 'The 1998 World Cup',
        description: '',
        questionIds: ['q-1', 'q-2', 'q-3'],
        createdBy: 'curator-uid',
        isPublished: false,
      },
    });
  });

  it('accepts every optional field the schema names', () => {
    const result = validateQuizDefinition(
      definition({
        tags: ['football', 'history'],
        language: 'pt-BR',
        sponsorId: null,
        suggestedTimeLimit: 'unlimited',
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.definition).toMatchObject({
      tags: ['football', 'history'],
      language: 'pt-BR',
      sponsorId: null,
      suggestedTimeLimit: 'unlimited',
    });
  });

  it('accepts each suggested time limit the picker offers, and null', () => {
    for (const limit of [15, 30, 'unlimited', null]) {
      expect(problemsOf(definition({ suggestedTimeLimit: limit })), String(limit)).toEqual([]);
    }
  });

  it('reports every problem at once rather than the first', () => {
    expect(problemsOf({ id: 'X', title: '' })).toHaveLength(5);
  });
});

describe('validateQuizDefinition — the bounds, at both edges', () => {
  it('takes a title of exactly the maximum and refuses one past it', () => {
    expect(problemsOf(definition({ title: 'x'.repeat(QUIZ_TITLE_MAX_LENGTH) }))).toEqual([]);
    expect(problemsOf(definition({ title: 'x'.repeat(QUIZ_TITLE_MAX_LENGTH + 1) }))).toHaveLength(
      1,
    );
  });

  it('refuses a title that is empty once trimmed, or not a string', () => {
    expect(problemsOf(definition({ title: '   ' }))).toHaveLength(1);
    expect(problemsOf(definition({ title: 42 }))).toHaveLength(1);
    expect(problemsOf(definition({ title: undefined }))).toHaveLength(1);
  });

  it('takes a description of exactly the maximum and refuses one past it', () => {
    expect(
      problemsOf(definition({ description: 'x'.repeat(QUIZ_DESCRIPTION_MAX_LENGTH) })),
    ).toEqual([]);
    expect(
      problemsOf(definition({ description: 'x'.repeat(QUIZ_DESCRIPTION_MAX_LENGTH + 1) })),
    ).toHaveLength(1);
  });

  it('takes an empty description and refuses one that is not a string', () => {
    expect(problemsOf(definition({ description: '' }))).toEqual([]);
    expect(problemsOf(definition({ description: null }))).toHaveLength(1);
  });

  it('takes one question and refuses none', () => {
    expect(problemsOf(definition({ questionIds: ids(1) }))).toEqual([]);
    expect(problemsOf(definition({ questionIds: [] }))).toHaveLength(1);
  });

  it(`takes ${QUIZ_MAX_QUESTIONS} questions and refuses ${QUIZ_MAX_QUESTIONS + 1}`, () => {
    expect(problemsOf(definition({ questionIds: ids(QUIZ_MAX_QUESTIONS) }))).toEqual([]);
    expect(problemsOf(definition({ questionIds: ids(QUIZ_MAX_QUESTIONS + 1) }))).toHaveLength(1);
  });

  it('refuses a question named twice', () => {
    expect(problemsOf(definition({ questionIds: ['q-1', 'q-2', 'q-1'] }))).toHaveLength(1);
  });

  it('names each question id that cannot address a document', () => {
    const problems = problemsOf(
      definition({ questionIds: ['q-1', 'a/b', '', '.', '..', '__reserved__', 7] }),
    );
    expect(problems).toHaveLength(6);
    expect(problems[0]).toContain('questionIds[1]');
  });

  it('refuses a questionIds that is not a list', () => {
    expect(problemsOf(definition({ questionIds: 'q-1' }))).toHaveLength(1);
  });

  it('takes a slug id of 3 and 64 characters and refuses 2 and 65', () => {
    expect(problemsOf(definition({ id: 'abc' }))).toEqual([]);
    expect(problemsOf(definition({ id: 'a'.repeat(64) }))).toEqual([]);
    expect(problemsOf(definition({ id: 'ab' }))).toHaveLength(1);
    expect(problemsOf(definition({ id: 'a'.repeat(65) }))).toHaveLength(1);
  });

  it('refuses an id that is not lower-case kebab-case', () => {
    for (const id of ['World-Cup', 'world_cup', '-world', 'world--cup', 'world cup', 'a/b']) {
      expect(problemsOf(definition({ id })), id).toHaveLength(1);
    }
  });

  it('takes a createdBy of 128 characters and refuses an empty one or 129', () => {
    expect(problemsOf(definition({ createdBy: 'x'.repeat(128) }))).toEqual([]);
    expect(problemsOf(definition({ createdBy: '  ' }))).toHaveLength(1);
    expect(problemsOf(definition({ createdBy: 'x'.repeat(129) }))).toHaveLength(1);
  });

  // Required, and boolean: leaving it out is a decision the operator has to
  // make on purpose, not one a default makes for them.
  it('requires isPublished, as a boolean', () => {
    expect(problemsOf(definition({ isPublished: true }))).toEqual([]);
    expect(problemsOf(definition({ isPublished: undefined }))).toHaveLength(1);
    expect(problemsOf(definition({ isPublished: 'true' }))).toHaveLength(1);
  });

  it(`takes ${QUIZ_MAX_TAGS} tags and refuses ${QUIZ_MAX_TAGS + 1}`, () => {
    const tags = Array.from({ length: QUIZ_MAX_TAGS + 1 }, (_, index) => `tag-${index}`);
    expect(problemsOf(definition({ tags: tags.slice(0, QUIZ_MAX_TAGS) }))).toEqual([]);
    expect(problemsOf(definition({ tags }))).toHaveLength(1);
  });

  it('refuses a tag the normaliser would not produce, and a duplicate', () => {
    expect(problemsOf(definition({ tags: ['World Cup'] }))).toHaveLength(1);
    expect(problemsOf(definition({ tags: ['football', 'football'] }))).toHaveLength(1);
  });

  it('takes a BCP-47 language tag and refuses anything else', () => {
    for (const language of ['en', 'pt-BR', 'es-419']) {
      expect(problemsOf(definition({ language })), language).toEqual([]);
    }
    for (const language of ['English', 'pt_BR', '', 3]) {
      expect(problemsOf(definition({ language })), String(language)).toHaveLength(1);
    }
  });

  it('takes a sponsorId of null or a string, and refuses an empty one', () => {
    expect(problemsOf(definition({ sponsorId: 'sponsor-1' }))).toEqual([]);
    expect(problemsOf(definition({ sponsorId: '' }))).toHaveLength(1);
    expect(problemsOf(definition({ sponsorId: 7 }))).toHaveLength(1);
  });

  it('refuses a suggested time limit the picker does not offer', () => {
    for (const limit of [20, '15', 'none']) {
      expect(problemsOf(definition({ suggestedTimeLimit: limit })), String(limit)).toHaveLength(1);
    }
  });
});

describe('validateQuizDefinition — what the file may carry', () => {
  // The script stamps it, and keeps the first one on every rewrite, so a quiz
  // republished to fix a typo does not jump to the top of the list on `/`.
  it('refuses a createdAt, which the script stamps', () => {
    const problems = problemsOf(definition({ createdAt: 1 }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('createdAt');
  });

  it('names an unknown field rather than writing it', () => {
    const problems = problemsOf(definition({ isPublised: true }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"isPublised"');
  });

  it('refuses anything that is not an object', () => {
    for (const input of [null, [], 'quiz', 3]) {
      expect(problemsOf(input), JSON.stringify(input)).toHaveLength(1);
    }
  });
});

describe('isDocumentReference', () => {
  it('takes an auto-id and a slug', () => {
    expect(isDocumentReference('aB3dE5gH7jK9mN1pQ2rS')).toBe(true);
    expect(isDocumentReference('world-cup-1998')).toBe(true);
  });

  it('refuses what a __name__ filter would refuse, so one id cannot sink a whole read', () => {
    for (const value of ['', 'a/b', '.', '..', '__reserved__', 'x'.repeat(129), null, 3]) {
      expect(isDocumentReference(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('readQuiz — the app reads what the console may have written', () => {
  const stored = {
    title: 'The 1998 World Cup',
    description: 'Ten questions.',
    questionIds: ['q-1', 'q-2'],
    createdBy: 'curator-uid',
    createdAt: 1_759_900_000_000,
    isPublished: true,
  };

  it('reads a well-formed quiz as it was written', () => {
    expect(readQuiz('world-cup-1998', stored)).toEqual({ id: 'world-cup-1998', ...stored });
  });

  it('returns null for a quiz with no title to show', () => {
    expect(readQuiz('q', { ...stored, title: '  ' })).toBeNull();
    expect(readQuiz('q', { ...stored, title: 7 })).toBeNull();
  });

  // Dropped rather than refused: none of these is a reason to take a quiz
  // offline, and the quiz page says how many questions it can actually play.
  it('drops question ids it cannot use, duplicates, and anything past the bound', () => {
    const quiz = readQuiz('q', {
      ...stored,
      questionIds: ['q-1', 'a/b', 'q-1', 42, ...ids(QUIZ_MAX_QUESTIONS + 3)],
    });
    expect(quiz?.questionIds).toHaveLength(QUIZ_MAX_QUESTIONS);
    expect(quiz?.questionIds.slice(0, 2)).toEqual(['q-1', 'q-0']);
  });

  it('reads a questionIds that is not a list as none', () => {
    expect(readQuiz('q', { ...stored, questionIds: 'q-1' })?.questionIds).toEqual([]);
  });

  it('reads a non-string description as none', () => {
    expect(readQuiz('q', { ...stored, description: 3 })?.description).toBe('');
  });

  it('reads isPublished as true only when it is the boolean true', () => {
    expect(readQuiz('q', { ...stored, isPublished: 'true' })?.isPublished).toBe(false);
    expect(readQuiz('q', { ...stored, isPublished: undefined })?.isPublished).toBe(false);
  });

  it('keeps a suggested time limit the picker offers and drops one it does not', () => {
    expect(readQuiz('q', { ...stored, suggestedTimeLimit: 30 })?.suggestedTimeLimit).toBe(30);
    expect(readQuiz('q', { ...stored, suggestedTimeLimit: null })?.suggestedTimeLimit).toBeNull();
    expect(readQuiz('q', { ...stored, suggestedTimeLimit: 45 })).not.toHaveProperty(
      'suggestedTimeLimit',
    );
  });

  it('reads tags through the same check every other reader uses', () => {
    expect(readQuiz('q', { ...stored, tags: ['football', 'Not A Tag'] })?.tags).toEqual([
      'football',
    ]);
  });
});
