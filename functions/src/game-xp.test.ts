import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_ANSWERS_FOR_HARDNESS,
  STREAK_XP_PER_ANSWER,
  XP_BASE,
  gameXp,
  hardnessMultiplier,
  observedHardness,
} from './game-xp';
import { levelFor } from './levels';
import type { PlayAnswer } from './play-history';

/**
 * What one finished game is worth (`FEAT-041`), tested directly because it is
 * a decision `recordGameResult` makes and nothing else can see
 * (`CLAUDE.md` §4.6). Every expected number is worked out by hand in the test
 * that uses it, so a formula that drifted would not be agreeing with itself.
 */

const NO_QUESTIONS: ReadonlyMap<string, unknown> = new Map();

const answer = (overrides: Partial<PlayAnswer> = {}): PlayAnswer => ({
  correct: true,
  ms: 4_000,
  difficulty: 'medium',
  ...overrides,
});

/** A community question as the transaction reads it: two counters and its wrong answers. */
const question = (answered: number, correct: number, wrongAnswers = 3) => ({
  answered,
  correct,
  incorrect_answers: Array.from({ length: wrongAnswers }, (_, index) => `Wrong ${index}`),
});

describe('gameXp — the base', () => {
  it('pays a right answer by its label, and a wrong one nothing', () => {
    assert.deepEqual({ ...XP_BASE }, { easy: 10, medium: 15, hard: 20 });
    // One right answer is also a run of one, worth the streak bonus once.
    assert.equal(gameXp([answer({ difficulty: 'easy' })], NO_QUESTIONS), 10 + 2);
    assert.equal(gameXp([answer({ difficulty: 'medium' })], NO_QUESTIONS), 15 + 2);
    assert.equal(gameXp([answer({ difficulty: 'hard' })], NO_QUESTIONS), 20 + 2);
    assert.equal(gameXp([answer({ difficulty: 'hard', correct: false })], NO_QUESTIONS), 0);
  });

  it('adds every right answer in the game', () => {
    const game = [
      answer({ difficulty: 'easy' }),
      answer({ difficulty: 'hard', correct: false }),
      answer({ difficulty: 'hard' }),
      answer({ difficulty: 'medium', correct: false }),
    ];
    // 10 + 20, and two runs of one.
    assert.equal(gameXp(game, NO_QUESTIONS), 30 + 2);
  });

  /**
   * A game banked without its records — a client from before them, or a save
   * whose history could not be lined up — earns nothing rather than XP made
   * up from its totals. `null` is the same case: the callable SDK sends a
   * present-but-`undefined` key as `null`.
   */
  it('earns nothing for a game with no per-answer records', () => {
    assert.equal(gameXp(undefined, NO_QUESTIONS), 0);
    assert.equal(gameXp(null, NO_QUESTIONS), 0);
    assert.equal(gameXp([], NO_QUESTIONS), 0);
  });
});

describe('gameXp — the streak bonus', () => {
  it('pays 2 for each answer in the longest run of right answers', () => {
    assert.equal(STREAK_XP_PER_ANSWER, 2);
    const easy = (correct: boolean) => answer({ difficulty: 'easy', correct });
    // Runs of 2, then 3: six right answers at 10, and the bonus for the 3.
    const game = [true, true, false, true, true, true, false, true].map(easy);
    assert.equal(gameXp(game, NO_QUESTIONS), 60 + 2 * 3);
  });

  it('takes the longest run, not the last one or the sum of them', () => {
    const easy = (correct: boolean) => answer({ difficulty: 'easy', correct });
    const game = [true, true, true, true, false, true].map(easy);
    assert.equal(gameXp(game, NO_QUESTIONS), 50 + 2 * 4);
  });

  it('pays no bonus for a game without a right answer', () => {
    const game = [answer({ correct: false }), answer({ correct: false })];
    assert.equal(gameXp(game, NO_QUESTIONS), 0);
  });
});

describe('gameXp — observed hardness', () => {
  /**
   * The ≥ 10 threshold, at its edge: nine recorded answers and the label
   * stands alone; ten and how players did changes the price. Nobody got this
   * question right in either case, so the second pays the ceiling.
   */
  it('prices a question by how players did only from ten recorded answers', () => {
    assert.equal(MIN_ANSWERS_FOR_HARDNESS, 10);
    const game = [answer({ questionId: 'q1', difficulty: 'hard' })];
    const nine = new Map([['q1', question(9, 0)]]);
    const ten = new Map([['q1', question(10, 0)]]);

    assert.equal(gameXp(game, nine), 20 + 2);
    assert.equal(gameXp(game, ten), 20 * 1.5 + 2);
  });

  /**
   * The scaling itself, by hand. Four options, so a guess is right a quarter
   * of the time and `knew = (accuracy − 0.25) / 0.75`:
   *
   * - 55 of 100 right: knew 0.4, so × 1.1 — a medium answer pays 16.5;
   * - 85 of 100 right: knew 0.8, so × 0.7 — it pays 10.5.
   *
   * Two answers in a row, so the bonus is 4 either way.
   */
  it('pays a question most players miss more than one everybody gets', () => {
    const game = [answer({ questionId: 'hard-one' }), answer({ questionId: 'easy-one' })];
    const counters = new Map([
      ['hard-one', question(100, 55)],
      ['easy-one', question(100, 85)],
    ]);
    // 16.5 + 10.5 + 4.
    assert.equal(gameXp(game, counters), 31);
    assert.ok(observedHardness(question(100, 55)) > observedHardness(question(100, 85)));
  });

  /**
   * The guessing correction is `FEAT-023`'s, so the option count matters: half
   * of a true-or-false question's players getting it right is what guessing
   * alone produces — nobody knew it — while half of a six-option question's is
   * a good deal of knowledge.
   */
  it('corrects for guessing by the question’s own option count', () => {
    assert.equal(observedHardness(question(20, 10, 1)), 1.5);
    // Six options: knew = (0.5 − 1/6) / (5/6) = 0.4, so × 1.1.
    assert.ok(Math.abs(observedHardness(question(20, 10, 5)) - 1.1) < 1e-9);
  });

  it('pays half the label for a question every player has got right', () => {
    // Prices from the map it is handed and nothing else; the transaction hands
    // it the counters as they were before this game (`game-result.test.ts`).
    const game = [answer({ questionId: 'q1', difficulty: 'easy' })];
    assert.equal(gameXp(game, new Map([['q1', question(10, 10)]])), 10 * 0.5 + 2);
  });

  it('pays the label for an Open Trivia question, and for one it was not handed', () => {
    const game = [
      answer({ difficulty: 'hard' }),
      answer({ questionId: 'gone', difficulty: 'hard' }),
    ];
    // 20 + 20, and a run of two.
    assert.equal(gameXp(game, NO_QUESTIONS), 40 + 4);
  });

  it('pays the label for counters a hand edit has broken, or no option count', () => {
    for (const stored of [
      { answered: 12, correct: 20, incorrect_answers: ['a', 'b', 'c'] },
      { answered: 'many', correct: 0, incorrect_answers: ['a'] },
      { answered: 40, correct: 0 },
      { answered: 40, correct: 0, incorrect_answers: 'three' },
      { answered: 40, correct: 0, incorrect_answers: [] },
      null,
      'q1',
    ]) {
      assert.equal(observedHardness(stored), 1, JSON.stringify(stored));
    }
  });
});

describe('gameXp — one question, paid once', () => {
  /**
   * **The forged game the review found.** Twenty-five entries naming one
   * question that nobody knew (×1.5): the first wrong, the next twenty-four
   * right. The difficulty counters count it once — one answer, wrong — so
   * paying every entry would have earned 24 × 30 + 2 × 24 = 768 XP for one
   * wrong answer, at a price the forged entries' own counts never move. The
   * first entry decides, as it does for the counters: nothing is earned.
   */
  it('pays nothing for a question whose first entry is wrong, however often it repeats', () => {
    const counters = new Map([['q', question(40, 10)]]);
    const forged = [
      answer({ questionId: 'q', difficulty: 'hard', correct: false }),
      ...Array.from({ length: 24 }, () => answer({ questionId: 'q', difficulty: 'hard' })),
    ];

    assert.equal(gameXp(forged, counters), 0);
  });

  it('pays a repeated question once, by its first entry, and runs past the repeats', () => {
    const counters = new Map([['q', question(40, 10)]]);
    const game = [
      answer({ questionId: 'q', difficulty: 'hard' }),
      answer({ questionId: 'q', difficulty: 'hard', correct: false }),
      answer({ questionId: 'q', difficulty: 'hard' }),
      answer({ difficulty: 'easy' }),
    ];
    // 30 for the question once, 10 for the Open Trivia answer, and the run of
    // two they make with the repeats passed over.
    assert.equal(gameXp(game, counters), 30 + 10 + 2 * 2);
  });

  it('pays every Open Trivia entry, which has no id to repeat', () => {
    const game = Array.from({ length: 3 }, () => answer({ difficulty: 'easy' }));
    assert.equal(gameXp(game, NO_QUESTIONS), 30 + 2 * 3);
  });
});

describe('hardnessMultiplier', () => {
  it('is 1.5 − knew across the scale', () => {
    assert.equal(hardnessMultiplier(0), 1.5);
    assert.equal(hardnessMultiplier(0.5), 1);
    assert.equal(hardnessMultiplier(1), 0.5);
  });

  /**
   * Below chance, the corrected accuracy goes negative — a question answered
   * right less often than guessing would manage. `FEAT-023` reads that as
   * "nobody knew it", and the ceiling is the same reading: never more than
   * half as much again as the label. The floor holds the other end.
   */
  it('holds the multiplier to 0.5…1.5 at both ends', () => {
    assert.equal(hardnessMultiplier(-1 / 3), 1.5);
    assert.equal(hardnessMultiplier(-4), 1.5);
    assert.equal(hardnessMultiplier(1.25), 0.5);
    // 0 right of 20 on four options: knew = (0 − 0.25) / 0.75 = −⅓.
    assert.equal(observedHardness(question(20, 0)), 1.5);
  });
});

describe('gameXp — rounding', () => {
  /**
   * Rounded once, at the end. Two options, 10 of 16 right: knew =
   * (0.625 − 0.5) / 0.5 = 0.25, so × 1.25 exactly — every step of it a binary
   * fraction, so the halves below are exact rather than near.
   *
   * One easy answer: 12.5 + 2 = 14.5, which rounds to 15. Two: 25 + 4 = 29,
   * where rounding each answer first would have made 13 + 13 + 4 = 30.
   */
  it('rounds the total once, to the nearest whole number', () => {
    const ids = ['q1', 'q2', 'q3'];
    const counters = new Map(ids.map((id) => [id, question(16, 10, 1)]));
    const [first, second, third] = ids.map((id) => answer({ questionId: id, difficulty: 'easy' }));
    assert.equal(gameXp([first], counters), 15);
    assert.equal(gameXp([first, second], counters), 29);
    assert.ok(Number.isInteger(gameXp([first, second, third], counters)));
  });
});

/**
 * **The test the spec asks for by name: XP is not `correctAnswers` under a new
 * name.** Two players bank the same eight games with the same number of right
 * answers — five of ten each time, forty in all — and end up at different
 * levels, because one answered the bank's hardest questions in a run and the
 * other its easiest ones, scattered.
 *
 * Per game, by hand:
 *
 * - **Ana** answers five hard questions in a row that 10 of 40 players got
 *   right on four options: knew = (0.25 − 0.25) / 0.75 = 0, so × 1.5 — each
 *   pays 30. 5 × 30 + a run of 5 × 2 = **160**.
 * - **Bo** answers five easy questions that 40 of 40 got right: knew = 1, so
 *   × 0.5 — each pays 5 — never two in a row. 5 × 5 + 2 = **27**.
 *
 * Eight such games each, against counters held still: Ana 1,280 XP (level 4),
 * Bo 216 XP (level 1).
 */
describe('two players with identical correct answers', () => {
  // Ten different questions each, as a real game deals them — every one with
  // the counters its player's description gives it.
  const ids = (prefix: string) => Array.from({ length: 10 }, (_, index) => `${prefix}-${index}`);
  const hard = new Map(ids('hard').map((id) => [id, question(40, 10)]));
  const easy = new Map(ids('easy').map((id) => [id, question(40, 40)]));
  const ana = ids('hard').map((id, index) =>
    answer({ questionId: id, difficulty: 'hard', correct: index < 5 }),
  );
  const bo = ids('easy').map((id, index) =>
    answer({ questionId: id, difficulty: 'easy', correct: index % 2 === 0 }),
  );

  it('reach different XP totals, and different levels', () => {
    const correct = (game: PlayAnswer[]) => game.filter((entry) => entry.correct).length;
    assert.equal(correct(ana), correct(bo), 'the two games have the same correctAnswers');

    const games = 8;
    const anaXp = games * gameXp(ana, hard);
    const boXp = games * gameXp(bo, easy);

    assert.equal(gameXp(ana, hard), 160);
    assert.equal(gameXp(bo, easy), 27);
    assert.equal(anaXp, 1_280);
    assert.equal(boXp, 216);
    assert.equal(levelFor(anaXp), 4);
    assert.equal(levelFor(boXp), 1);
  });
});
