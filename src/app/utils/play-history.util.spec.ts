import {
  PickedAnswer,
  SKIPPED,
  TIMED_OUT,
  TriviaQuestion,
  answeredWith,
} from '../models/question.model';
import { MAX_ANSWER_MS, buildPlayAnswers } from './play-history.util';

/**
 * `FEAT-049` — what a finished game submits about the round itself.
 *
 * The bounds are enforced again in `functions/src/play-history.ts`, which is
 * the one that matters; what these cover is the client's half of the contract,
 * because a payload outside those bounds is a submission `recordGameResult`
 * refuses **whole** — the totals go with the history.
 */

function question(id: string, overrides: Partial<TriviaQuestion> = {}): TriviaQuestion {
  return {
    id,
    category: 'Science',
    type: 'multiple',
    difficulty: 'medium',
    question: `Question ${id}?`,
    correct_answer: 'A',
    incorrect_answers: ['B'],
    all_answers: [
      { id: `${id}:correct`, text: 'A', isCorrect: true },
      { id: `${id}:wrong`, text: 'B', isCorrect: false },
    ],
    source: 'open_trivia',
    ...overrides,
  };
}

const bankQuestion = (id: string, overrides: Partial<TriviaQuestion> = {}) =>
  question(id, { source: 'custom', ...overrides });

describe('buildPlayAnswers', () => {
  it('records one entry per question, in the order they were asked', () => {
    const questions = [question('q0'), question('q1')];
    const history: PickedAnswer[] = [answeredWith('q0:correct'), answeredWith('q1:wrong')];

    expect(buildPlayAnswers(questions, history, [1_200, 7_400])).toEqual([
      { correct: true, ms: 1_200, difficulty: 'medium' },
      { correct: false, ms: 7_400, difficulty: 'medium' },
    ]);
  });

  /**
   * Correctness comes from the answer's own `isCorrect` flag, found by **id** —
   * the same rule the recap and the scorer follow. Two options can carry the
   * same text, and matching on it once let a wrong answer score as correct
   * (`CLAUDE.md` §4.4).
   */
  it('reads correctness from the id, not from the text', () => {
    const duplicate = question('q0', {
      all_answers: [
        { id: 'q0:a', text: 'Paris', isCorrect: false },
        { id: 'q0:b', text: 'Paris', isCorrect: true },
      ],
    });

    expect(buildPlayAnswers([duplicate], [answeredWith('q0:a')], [500])?.[0].correct).toBe(false);
    expect(buildPlayAnswers([duplicate], [answeredWith('q0:b')], [500])?.[0].correct).toBe(true);
  });

  it('records a timeout and a skip as not correct', () => {
    const questions = [question('q0'), question('q1')];

    expect(buildPlayAnswers(questions, [TIMED_OUT, SKIPPED], [15_000, 900])).toEqual([
      { correct: false, ms: 15_000, difficulty: 'medium' },
      { correct: false, ms: 900, difficulty: 'medium' },
    ]);
  });

  it('records an id that no longer names an option as not correct', () => {
    // Reachable only through a hand-edited save, and it must not throw: the
    // alternative to answering "not correct" is losing the whole submission.
    const answers = buildPlayAnswers([question('q0')], [answeredWith('q0:gone')], [500]);

    expect(answers?.[0].correct).toBe(false);
  });

  it('carries each question’s own difficulty', () => {
    const questions = [
      question('q0', { difficulty: 'easy' }),
      question('q1', { difficulty: 'hard' }),
    ];

    expect(
      buildPlayAnswers(questions, [TIMED_OUT, TIMED_OUT], [1, 2])?.map((a) => a.difficulty),
    ).toEqual(['easy', 'hard']);
  });

  // ---------------------------------------------------------------------------
  // Which questions are identified, and which are not
  // ---------------------------------------------------------------------------

  /**
   * An Open Trivia DB id is minted per fetch and means nothing across batches,
   * so an entry naming one would be an entry the recommender cannot use. The
   * key is **omitted**, not nulled: Firestore refuses an `undefined` field
   * value outright.
   */
  it('omits the question id for an Open Trivia question', () => {
    const [entry] = buildPlayAnswers([question('q0')], [TIMED_OUT], [1_000]) ?? [];

    expect('questionId' in entry).toBe(false);
  });

  it('records the question id for one drawn from the bank', () => {
    const answers = buildPlayAnswers([bankQuestion('abc123')], [TIMED_OUT], [1_000]);

    expect(answers?.[0].questionId).toBe('abc123');
  });

  it('snapshots the tags a bank question carried at play time', () => {
    const answers = buildPlayAnswers(
      [bankQuestion('abc123', { tags: ['world-war-2', 'europe'] })],
      [TIMED_OUT],
      [1_000],
    );

    expect(answers?.[0].tags).toEqual(['world-war-2', 'europe']);
  });

  it('omits the tags when a question has none', () => {
    const [entry] = buildPlayAnswers([bankQuestion('abc123')], [TIMED_OUT], [1_000]) ?? [];

    expect('tags' in entry).toBe(false);
  });

  /**
   * Read through the same predicate the chips render with. `custom_questions`
   * is a public API a console can write to directly, so a stored tag the rules
   * would refuse is reachable — and sending one turns an honest game into a
   * submission the server rejects whole.
   */
  it('drops a stored tag the rules would never have accepted', () => {
    const answers = buildPlayAnswers(
      [bankQuestion('abc123', { tags: ['World War 2', 'ok-tag', 'x'.repeat(40)] })],
      [TIMED_OUT],
      [1_000],
    );

    expect(answers?.[0].tags).toEqual(['ok-tag']);
  });

  // ---------------------------------------------------------------------------
  // Durations
  // ---------------------------------------------------------------------------

  it('clamps a duration past the bound the server accepts', () => {
    const answers = buildPlayAnswers([question('q0')], [TIMED_OUT], [MAX_ANSWER_MS + 5_000]);

    expect(answers?.[0].ms).toBe(MAX_ANSWER_MS);
  });

  it('floors a negative duration at zero, which is a clock that went backwards', () => {
    expect(buildPlayAnswers([question('q0')], [TIMED_OUT], [-1])?.[0].ms).toBe(0);
  });

  it('rounds a fractional duration to a whole millisecond', () => {
    // `recordGameResult` requires an integer, so a fractional value would be
    // refused along with the rest of the submission.
    expect(buildPlayAnswers([question('q0')], [TIMED_OUT], [1_234.6])?.[0].ms).toBe(1_235);
  });

  it('records a non-finite duration as zero rather than sending it', () => {
    expect(buildPlayAnswers([question('q0')], [TIMED_OUT], [Number.NaN])?.[0].ms).toBe(0);
    expect(buildPlayAnswers([question('q0')], [TIMED_OUT], [Infinity])?.[0].ms).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // When there is nothing worth sending
  // ---------------------------------------------------------------------------

  /**
   * All or nothing, because both arrays are positional: a history one short of
   * the game describes a *different* game rather than a smaller one. Reachable
   * — a save written before either field existed restores with an empty array,
   * and an unusable history is dropped whole on restore.
   */
  it.each([
    ['no history at all', [] as PickedAnswer[], [1_000]],
    ['no durations at all', [TIMED_OUT], [] as number[]],
    ['a short history', [TIMED_OUT], [1_000, 2_000]],
    ['a short duration list', [TIMED_OUT, TIMED_OUT], [1_000]],
  ])('sends nothing for %s', (_label, history, durations) => {
    const questions = [question('q0'), question('q1')];

    expect(buildPlayAnswers(questions, history, durations)).toBeUndefined();
  });

  it('sends nothing for a game with no questions', () => {
    expect(buildPlayAnswers([], [], [])).toBeUndefined();
  });
});
