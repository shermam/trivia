import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asPro, createTestEnv, submitQuestion, validQuestion } from './helpers';

/**
 * `question-bounds.json` — the bounds `firestore.rules` holds on a new
 * question's content, published for the writer the rules never see (the
 * question-generation pipeline, on the Admin SDK) — checked against the rules
 * by the emulator.
 *
 * **Every probe is derived from the file.** For each bound it writes a
 * question **at** the bound, which the rules must accept, and **one past it**,
 * which they must refuse. So the suite fails when the two disagree in either
 * direction: a file looser than the rules fails an "at" probe, a file tighter
 * than them fails a "past" one, and a number edited in one place without the
 * other is a red build rather than a comment gone stale.
 *
 * **Where a bound is not a number** — an enum, the tag pattern, the URL prefix
 * — the probes are a fixed list of candidates and the file decides which of
 * them the rules must accept. The lists hold today's values as well as their
 * near misses, so a value dropped from the file is probed as one the rules
 * must now refuse, and every value the file lists is probed whether or not a
 * list holds it. What no list can reach is a value the rules gain that nobody
 * thought to write down — the one direction that cannot hurt a writer keeping
 * to the file.
 *
 * **Lengths are UTF-16 code units, and the strings are built to say so.** A
 * string at a maximum is made of `é` — one unit, one code point, two UTF-8
 * bytes — so a rule counting bytes would refuse it; a string past a maximum is
 * made of `😀` — two units, one code point — so a rule counting code points
 * would accept it. Either way a probe would fail.
 *
 * **Each probe differs from an accepted question only in the bound it names**,
 * which is what makes a refusal mean something: the list probes keep the other
 * entries short and distinct, a tag probe is checked against the file's own
 * pattern before it is written, and a `boolean` probe carries the one wrong
 * answer that type demands. The per-index clauses of the two list checks are
 * `custom-questions.rules.spec.ts`'s to cover; an element bound is probed here
 * at the first and at the last position the file allows, so the published
 * "each" is checked at both ends.
 */

interface LengthBound {
  readonly minLength: number;
  readonly maxLength: number;
}

interface CountBound {
  readonly minCount: number;
  readonly maxCount: number;
}

interface QuestionBounds {
  readonly version: number;
  readonly source: {
    readonly repository: string;
    readonly file: string;
    readonly functions: readonly string[];
  };
  readonly question: LengthBound;
  readonly correct_answer: LengthBound;
  readonly incorrect_answers: CountBound & LengthBound;
  readonly explanation: LengthBound;
  readonly tags: CountBound & LengthBound & { readonly pattern: string };
  readonly format: { readonly values: readonly string[] };
  readonly difficulty: { readonly values: readonly string[] };
  readonly type: { readonly values: readonly string[]; readonly booleanIncorrectAnswers: number };
  readonly sourceUrl: LengthBound & { readonly prefix: string };
  readonly sourceTitle: LengthBound;
}

const raw = JSON.parse(readFileSync('question-bounds.json', 'utf8')) as Record<string, unknown>;
const bounds = raw as unknown as QuestionBounds;

/**
 * Every bound this suite probes. A key the file gains is a bound nobody checks
 * until it is added here, so the first test refuses one — the same stance the
 * pipeline's loader takes towards a key its validator does not enforce.
 */
const PROBED = [
  'question',
  'correct_answer',
  'incorrect_answers',
  'explanation',
  'tags',
  'format',
  'difficulty',
  'type',
  'sourceUrl',
  'sourceTitle',
] as const;

/** `matches()` is RE2's full match, so the pattern is applied as one whatever anchors it carries. */
const tagShape = new RegExp(`^(?:${bounds.tags.pattern})$`);

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnv('demo-rules-question-bounds');
});
afterAll(() => env.cleanup());
// Each probe is one create, and a create also opens the hour's quota counter
// at 1; a fresh database per probe keeps every one of them the first.
beforeEach(() => env.clearFirestore());

const WRITER = 'bounds-writer';

/**
 * A Pro subscriber's create — the write these bounds govern — of a valid
 * question with the overrides applied, in the same batch as its quota counter
 * (`submitQuestion` says why a bare create would prove nothing).
 */
const write = (overrides: Record<string, unknown>) =>
  submitQuestion(asPro(env, WRITER), { uid: WRITER, payload: validQuestion(WRITER, overrides) });

const accepted = (overrides: Record<string, unknown>) => assertSucceeds(write(overrides));
const refused = (overrides: Record<string, unknown>) => assertFails(write(overrides));
const expectRules = (accept: boolean, overrides: Record<string, unknown>) =>
  accept ? accepted(overrides) : refused(overrides);

/** One UTF-16 code unit and one code point, but two UTF-8 bytes. */
const ONE_UNIT = '\u00e9';
/** Two UTF-16 code units — a surrogate pair — but one code point. */
const TWO_UNITS = '\u{1F600}';

/** `units` long, built so that a rule counting bytes would measure it longer. */
const textOf = (units: number) => ONE_UNIT.repeat(units);

/** `units` long, built so that a rule counting code points would measure it shorter. */
const textPast = (units: number) =>
  TWO_UNITS.repeat(Math.floor(units / 2)) + ONE_UNIT.repeat(units % 2);

/** `n` distinct short wrong answers, none of them the base question's correct answer. */
const wrongAnswers = (n: number) => Array.from({ length: n }, (_, i) => `Wrong ${i + 1}`);

/** `n` distinct short tags in the stored shape. */
const someTags = (n: number) => Array.from({ length: n }, (_, i) => `topic-${i + 1}`);

/** The probe at the first position of a list as short as the file allows, and at the last of one as long. */
const atPositions = (fill: (n: number) => string[], count: CountBound) =>
  [
    ['first', (probe: string) => [probe, ...fill(Math.max(count.minCount, 1) - 1)]],
    ['last', (probe: string) => [...fill(count.maxCount - 1), probe]],
  ] as const;

describe('question-bounds.json: the file itself', () => {
  it('holds exactly the bounds this suite probes', () => {
    const stated = Object.keys(raw).filter(
      (key) => !['$comment', 'version', 'source'].includes(key),
    );
    expect(stated.sort()).toEqual([...PROBED].sort());
  });

  it('is version 1 of the format and names the rules it states', () => {
    expect(bounds.version).toBe(1);
    expect(bounds.source).toEqual({
      repository: 'shermam/trivia',
      file: 'firestore.rules',
      functions: ['isValidQuestionShape', 'isValidCustomQuestion'],
    });
  });

  // A rename in the rules would otherwise leave the file pointing a reader,
  // and the pipeline's comparison, at functions that no longer exist.
  it('names functions that exist in the rules file it names', () => {
    const rules = readFileSync(bounds.source.file, 'utf8');
    for (const name of bounds.source.functions) {
      expect(rules, `${name}() not found in ${bounds.source.file}`).toMatch(
        new RegExp(`\\bfunction ${name}\\(`),
      );
    }
  });

  // A probe built from a malformed number would test nothing: 'x'.repeat(NaN)
  // is '', which the rules refuse for a reason that has nothing to do with the
  // bound. So the numbers are checked for being numbers first.
  it('states every length and count as an integer, minimum no greater than maximum', () => {
    const sections: [string, Partial<LengthBound & CountBound>][] = PROBED.map((key) => [
      key,
      raw[key] as Partial<LengthBound & CountBound>,
    ]);
    for (const [key, section] of sections) {
      for (const [min, max] of [
        ['minLength', 'maxLength'],
        ['minCount', 'maxCount'],
      ] as const) {
        if (!(min in section) && !(max in section)) {
          continue;
        }
        expect(Number.isInteger(section[min]), `${key}.${min}`).toBe(true);
        expect(Number.isInteger(section[max]), `${key}.${max}`).toBe(true);
        expect(section[min]! >= 0 && section[min]! <= section[max]!, `${key}.${min}`).toBe(true);
      }
    }
  });

  // The boolean probe's refused case adds one wrong answer; that is only a
  // probe of the boolean clause while it stays inside the list's own count.
  it('keeps a boolean question’s wrong answers inside the list’s count', () => {
    const { minCount, maxCount } = bounds.incorrect_answers;
    expect(bounds.type.booleanIncorrectAnswers).toBeGreaterThanOrEqual(minCount);
    expect(bounds.type.booleanIncorrectAnswers + 1).toBeLessThanOrEqual(maxCount);
  });

  // The URL probes are the prefix plus filler, so the prefix has to fit inside
  // the shortest one for its length probes to be about length.
  it('states a URL prefix that fits inside the shortest URL', () => {
    expect(bounds.sourceUrl.prefix.length).toBeLessThanOrEqual(bounds.sourceUrl.minLength);
  });
});

/** The four probes of a free-text field: at and below its minimum, at and past its maximum. */
function lengthProbes(key: 'question' | 'correct_answer' | 'explanation' | 'sourceTitle') {
  const { minLength, maxLength } = bounds[key];
  describe(`${key}: ${minLength}–${maxLength} UTF-16 code units`, () => {
    it(`accepts ${minLength} (minLength)`, () => accepted({ [key]: textOf(minLength) }));
    if (minLength > 0) {
      it(`refuses ${minLength - 1}`, () => refused({ [key]: textOf(minLength - 1) }));
    }
    it(`accepts ${maxLength} (maxLength)`, () => accepted({ [key]: textOf(maxLength) }));
    it(`refuses ${maxLength + 1}`, () => refused({ [key]: textPast(maxLength + 1) }));
  });
}

lengthProbes('question');
lengthProbes('correct_answer');
lengthProbes('explanation');
lengthProbes('sourceTitle');

describe('incorrect_answers', () => {
  const { minCount, maxCount, minLength, maxLength } = bounds.incorrect_answers;

  describe(`${minCount}–${maxCount} of them`, () => {
    it(`accepts ${minCount} (minCount)`, () =>
      accepted({ incorrect_answers: wrongAnswers(minCount) }));
    if (minCount > 0) {
      it(`refuses ${minCount - 1}`, () =>
        refused({ incorrect_answers: wrongAnswers(minCount - 1) }));
    }
    it(`accepts ${maxCount} (maxCount)`, () =>
      accepted({ incorrect_answers: wrongAnswers(maxCount) }));
    it(`refuses ${maxCount + 1}`, () => refused({ incorrect_answers: wrongAnswers(maxCount + 1) }));
  });

  describe.each(atPositions(wrongAnswers, bounds.incorrect_answers))(
    `each ${minLength}–${maxLength} UTF-16 code units — at the %s position`,
    (_where, list) => {
      it(`accepts ${minLength} (minLength)`, () =>
        accepted({ incorrect_answers: list(textOf(minLength)) }));
      if (minLength > 0) {
        it(`refuses ${minLength - 1}`, () =>
          refused({ incorrect_answers: list(textOf(minLength - 1)) }));
      }
      it(`accepts ${maxLength} (maxLength)`, () =>
        accepted({ incorrect_answers: list(textOf(maxLength)) }));
      it(`refuses ${maxLength + 1}`, () =>
        refused({ incorrect_answers: list(textPast(maxLength + 1)) }));
    },
  );
});

describe('tags', () => {
  const { minCount, maxCount, minLength, maxLength } = bounds.tags;

  describe(`${minCount}–${maxCount} of them`, () => {
    it(`accepts ${minCount} (minCount)`, () => accepted({ tags: someTags(minCount) }));
    if (minCount > 0) {
      it(`refuses ${minCount - 1}`, () => refused({ tags: someTags(minCount - 1) }));
    }
    it(`accepts ${maxCount} (maxCount)`, () => accepted({ tags: someTags(maxCount) }));
    it(`refuses ${maxCount + 1}`, () => refused({ tags: someTags(maxCount + 1) }));
  });

  /**
   * A tag is ASCII by its pattern, so the unit question does not arise; what
   * has to hold instead is that the probe is a tag the file's own pattern
   * accepts, or a refusal would be the pattern's rather than the length's.
   */
  const tagOf = (length: number) => {
    const tag = 'a'.repeat(length);
    expect(tagShape.test(tag), `"${tag}" is not in the file's own tag shape`).toBe(true);
    return tag;
  };

  describe.each(atPositions(someTags, bounds.tags))(
    `each ${minLength}–${maxLength} characters — at the %s position`,
    (_where, list) => {
      it(`accepts ${minLength} (minLength)`, () => accepted({ tags: list(tagOf(minLength)) }));
      if (minLength > 1) {
        it(`refuses ${minLength - 1}`, () => refused({ tags: list(tagOf(minLength - 1)) }));
      }
      it(`accepts ${maxLength} (maxLength)`, () => accepted({ tags: list(tagOf(maxLength)) }));
      it(`refuses ${maxLength + 1}`, () => refused({ tags: list(tagOf(maxLength + 1)) }));
    },
  );

  /**
   * Today's shapes and their near misses — every feature of the pattern has a
   * string that leans on it: the alphabet, the digits, a joining hyphen, a
   * leading, trailing or doubled one, upper case, an underscore, a space, a
   * letter outside ASCII, a symbol, and a trailing newline (which a `$` that
   * meant "end of line" would let through).
   */
  const CANDIDATES = [
    'history',
    'world-war-2',
    'a1',
    '1999',
    'x-y-z',
    'web-3-0-and-more',
    'History',
    'WORLD-WAR-2',
    'world_war_2',
    'world war 2',
    '-history',
    'history-',
    'world--war',
    'café',
    'c++',
    'dot.net',
    'history\n',
  ];

  describe(`the pattern ${bounds.tags.pattern}`, () => {
    for (const tag of CANDIDATES) {
      const accept = tagShape.test(tag) && tag.length >= minLength && tag.length <= maxLength;
      it(`${accept ? 'accepts' : 'refuses'} ${JSON.stringify(tag)}`, () =>
        expectRules(accept, { tags: [tag] }));
    }
  });
});

describe('sourceUrl', () => {
  const { prefix, minLength, maxLength } = bounds.sourceUrl;
  /** `units` long, the prefix first, filled as {@link textOf} or {@link textPast} fills. */
  const url = (units: number, fill: (units: number) => string = textOf) =>
    units < prefix.length ? prefix.slice(0, units) : prefix + fill(units - prefix.length);

  describe(`${minLength}–${maxLength} UTF-16 code units`, () => {
    it(`accepts ${minLength} (minLength)`, () => accepted({ sourceUrl: url(minLength) }));
    it(`refuses ${minLength - 1}`, () => refused({ sourceUrl: url(minLength - 1) }));
    it(`accepts ${maxLength} (maxLength)`, () => accepted({ sourceUrl: url(maxLength) }));
    it(`refuses ${maxLength + 1}`, () => refused({ sourceUrl: url(maxLength + 1, textPast) }));
  });

  const CANDIDATES = [
    'https://en.wikipedia.org/wiki/Water',
    'http://en.wikipedia.org/wiki/Water',
    'HTTPS://en.wikipedia.org/wiki/Water',
    'Https://en.wikipedia.org/wiki/Water',
    ' https://en.wikipedia.org/wiki/Water',
    'https:/en.wikipedia.org/wiki/Water',
    '//en.wikipedia.org/wiki/Water',
    'ftp://example.org/water.txt',
    'javascript:alert(1)//https://',
  ];

  describe(`the prefix ${prefix}`, () => {
    for (const candidate of CANDIDATES) {
      const accept =
        candidate.startsWith(prefix) &&
        candidate.length >= minLength &&
        candidate.length <= maxLength;
      it(`${accept ? 'accepts' : 'refuses'} ${JSON.stringify(candidate)}`, () =>
        expectRules(accept, { sourceUrl: candidate }));
    }
  });
});

/**
 * An enum's probes: every value the file lists, and a fixed list of today's
 * values and their near misses, each accepted exactly when the file lists it.
 */
function enumProbes(key: 'format' | 'difficulty', candidates: readonly unknown[]) {
  const values: readonly unknown[] = bounds[key].values;
  describe(`${key}: ${values.join(', ')}`, () => {
    for (const value of new Set([...values, ...candidates])) {
      const accept = values.includes(value);
      it(`${accept ? 'accepts' : 'refuses'} ${JSON.stringify(value)}`, () =>
        expectRules(accept, { [key]: value }));
    }
  });
}

enumProbes('format', ['plain', 'markdown', 'Plain', 'MARKDOWN', 'md', 'html', 'latex', 'text', '']);
enumProbes('difficulty', [
  'easy',
  'medium',
  'hard',
  'Easy',
  'MEDIUM',
  'expert',
  'very-hard',
  'normal',
  '',
  2,
]);

describe('type', () => {
  const { values, booleanIncorrectAnswers } = bounds.type;
  const booleanAnswers = ['False', 'Maybe', 'Unknown', 'Sometimes', 'Never', 'Always'];

  /**
   * A question of the given type that is otherwise well formed for it: a
   * `boolean` one carries `True` and the number of wrong answers the file says
   * that type takes — so a candidate is accepted or refused for its name, and
   * never for its answers.
   */
  const ofType = (type: unknown): Record<string, unknown> =>
    type === 'boolean'
      ? {
          type,
          correct_answer: 'True',
          incorrect_answers: booleanAnswers.slice(0, booleanIncorrectAnswers),
        }
      : { type };

  describe(`${values.join(', ')}`, () => {
    const candidates = ['multiple', 'boolean', 'Multiple', 'BOOLEAN', 'single', 'true-false', ''];
    for (const value of new Set<unknown>([...values, ...candidates])) {
      const accept = (values as readonly unknown[]).includes(value);
      it(`${accept ? 'accepts' : 'refuses'} ${JSON.stringify(value)}`, () =>
        expectRules(accept, ofType(value)));
    }
  });

  describe(`a boolean question carries exactly ${booleanIncorrectAnswers} wrong answer(s)`, () => {
    it(`accepts ${booleanIncorrectAnswers} (booleanIncorrectAnswers)`, () =>
      accepted(ofType('boolean')));
    it(`refuses ${booleanIncorrectAnswers + 1}`, () =>
      refused({
        ...ofType('boolean'),
        incorrect_answers: booleanAnswers.slice(0, booleanIncorrectAnswers + 1),
      }));
  });
});
