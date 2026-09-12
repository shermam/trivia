import {
  BASE_QUESTION_POINTS,
  MAX_SCORE_MULTIPLIER,
  STREAK_INDICATOR_THRESHOLD,
  displayScore,
  maxScoreFor,
  multiplierForStreak,
  multiplierLabel,
  pointsForStreak,
} from './scoring';

/**
 * The scoring decision, `FEAT-004`. Pure functions, so the tier boundaries can
 * be walked one streak at a time rather than inferred from a game that happens
 * to cross them.
 *
 * The boundaries are the specification, and the off-by-one at each is the
 * mistake worth catching: "3–4 Correct: 1.5×" means the **third** consecutive
 * correct answer is the first to earn it, not the fourth.
 */
describe('multiplierForStreak', () => {
  const expected: readonly [number, number][] = [
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1.5],
    [4, 1.5],
    [5, 2],
    [6, 2],
    [7, 2],
    [8, 3],
    [9, 3],
    [25, 3],
  ];

  for (const [streak, multiplier] of expected) {
    it(`is ${multiplier}× at a streak of ${streak}`, () => {
      expect(multiplierForStreak(streak)).toBe(multiplier);
    });
  }

  // The table is ordered longest-first and matched on the first hit, which is
  // the kind of list that silently stops working if an entry is added out of
  // order. Walking the whole range catches that; walking the boundaries alone
  // would not.
  it('never exceeds the ceiling the rules enforce, at any streak', () => {
    for (let streak = 0; streak <= 25; streak++) {
      expect(multiplierForStreak(streak)).toBeLessThanOrEqual(MAX_SCORE_MULTIPLIER);
    }
  });

  it('never goes down as the streak grows', () => {
    for (let streak = 1; streak <= 25; streak++) {
      expect(multiplierForStreak(streak)).toBeGreaterThanOrEqual(multiplierForStreak(streak - 1));
    }
  });

  it('shows the badge one answer before the first bonus tier', () => {
    expect(multiplierForStreak(STREAK_INDICATOR_THRESHOLD)).toBe(1);
    expect(multiplierForStreak(STREAK_INDICATOR_THRESHOLD + 1)).toBeGreaterThan(1);
  });
});

describe('pointsForStreak', () => {
  it('is worth the base at a plain streak', () => {
    expect(pointsForStreak(1)).toBe(BASE_QUESTION_POINTS);
  });

  // The half point is the whole reason `points` and `score` are separate
  // numbers: a 1.5× tier on a one-point base cannot produce an integer.
  it('produces a half point at the 1.5× tier', () => {
    expect(pointsForStreak(3)).toBe(1.5);
  });

  it('tops out at the ceiling', () => {
    expect(pointsForStreak(8)).toBe(BASE_QUESTION_POINTS * MAX_SCORE_MULTIPLIER);
  });
});

/**
 * The bound the leaderboard rules enforce, checked against what the game can
 * actually produce rather than against itself. A perfect run has to fit under
 * the ceiling with room to spare, or a legitimate score would be refused as a
 * bare `permission-denied` (`CLAUDE.md` §4.4).
 */
describe('the score a real game can reach stays inside the rules bound', () => {
  function perfectRun(questions: number): number {
    let points = 0;
    for (let streak = 1; streak <= questions; streak++) {
      points += pointsForStreak(streak);
    }
    return displayScore(points);
  }

  for (const questions of [1, 5, 10, 15, 20, 25]) {
    it(`a perfect ${questions}-question run scores within the ceiling`, () => {
      expect(perfectRun(questions)).toBeLessThanOrEqual(maxScoreFor(questions));
    });
  }

  it('a perfect 25-question run is worth well under the 75-point ceiling', () => {
    expect(perfectRun(25)).toBe(65);
    expect(maxScoreFor(25)).toBe(75);
  });

  // The direction that matters for ranking: multipliers have to be worth
  // chasing, or the feature is a badge with no consequence.
  it('beats the unmultiplied score for a long perfect run', () => {
    expect(perfectRun(10)).toBeGreaterThan(10);
  });
});

describe('displayScore', () => {
  it('leaves a whole total alone', () => {
    expect(displayScore(7)).toBe(7);
  });

  it('rounds a half point up', () => {
    expect(displayScore(4.5)).toBe(5);
  });

  /*
   * Rounding must not be able to push a total over the ceiling, because the
   * client would then submit a score `firestore.rules` refuses. It cannot: the
   * ceiling is `totalQuestions * MAX_SCORE_MULTIPLIER`, an integer, and
   * rounding a value at or below an integer never crosses it.
   */
  it('cannot round a total over the rules ceiling', () => {
    for (const questions of [1, 5, 25]) {
      expect(displayScore(maxScoreFor(questions))).toBeLessThanOrEqual(maxScoreFor(questions));
      expect(displayScore(maxScoreFor(questions) - 0.5)).toBeLessThanOrEqual(
        maxScoreFor(questions),
      );
    }
  });
});

/*
 * The label is fixed-width on purpose: it sits in a badge that must not change
 * size as the tier changes (`CLAUDE.md` §4.4), and it reserves its space by
 * being the same length in every state rather than by a measured minimum. A
 * bare `String(multiplier)` would give "1" and "1.5" and move the badge.
 */
describe('multiplierLabel', () => {
  it('writes every tier to the same width', () => {
    const labels = [1, 1.5, 2, 3].map(multiplierLabel);

    expect(labels).toEqual(['1.0', '1.5', '2.0', '3.0']);
    expect(new Set(labels.map((label) => label.length)).size).toBe(1);
  });
});
