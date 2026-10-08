import {
  type DifficultyInputs,
  LABEL_DIFFICULTY,
  PRIOR_WEIGHT,
  difficultyBand,
  difficultyScore,
  readCounters,
} from './difficulty-score.util';

/** A question with `options` options, labelled `difficulty`, carrying the given counters. */
function question(
  options: number,
  counters: { answered?: unknown; correct?: unknown } = {},
  difficulty: DifficultyInputs['difficulty'] = 'medium',
): DifficultyInputs {
  return {
    difficulty,
    incorrect_answers: Array.from({ length: options - 1 }, (_, index) => `Wrong ${index}`),
    ...counters,
  };
}

describe('difficultyScore', () => {
  describe('a question nobody has answered scores exactly its label', () => {
    it('reads each label as its fixed value', () => {
      expect(difficultyScore(question(4, {}, 'easy'))).toBe(0.25);
      expect(difficultyScore(question(4, {}, 'medium'))).toBe(0.5);
      expect(difficultyScore(question(4, {}, 'hard'))).toBe(0.75);
    });

    it('reads a question whose counters stand at zero the same way', () => {
      expect(difficultyScore(question(4, { answered: 0, correct: 0 }, 'hard'))).toBe(0.75);
    });

    // A console-written document is not bound by the type.
    it('reads a label outside the three as the middle of the scale', () => {
      for (const label of ['expert', 'constructor', '']) {
        expect(
          difficultyScore(question(4, {}, label as DifficultyInputs['difficulty'])),
          label,
        ).toBe(0.5);
      }
    });
  });

  /**
   * **The spec's own acceptance row: no counters, three plays, three hundred.**
   * The middle case is the one that catches a missing prior — without it,
   * three right answers out of three would score a medium question as easy as
   * a question can be.
   */
  describe('the label is shrunk towards what players did as the answers grow', () => {
    it('keeps a question three players have all got right close to its label', () => {
      const score = difficultyScore(question(4, { answered: 3, correct: 3 }));

      // (10 × 0.5 + 3 × 0) / 13
      expect(score).toBeCloseTo(5 / 13, 10);
      expect(difficultyBand(score)).toBe('medium');
    });

    it('moves a question three hundred players have all got right almost all the way', () => {
      const score = difficultyScore(question(4, { answered: 300, correct: 300 }));

      expect(score).toBeCloseTo(5 / 310, 10);
      expect(difficultyBand(score)).toBe('easy');
    });

    it('weighs the label as ten answers, no more and no less', () => {
      // Ten answers, every one wrong, on a medium question: the label and the
      // players carry equal weight, so the score lands halfway between 0.5 and 1.
      expect(PRIOR_WEIGHT).toBe(10);
      expect(difficultyScore(question(4, { answered: 10, correct: 0 }))).toBeCloseTo(0.75, 10);
    });

    it('moves monotonically away from the label as the same accuracy accumulates', () => {
      const scores = [0, 1, 3, 10, 30, 100, 300, 3000].map((answered) =>
        difficultyScore(question(4, { answered, correct: answered })),
      );
      for (let index = 1; index < scores.length; index += 1) {
        expect(scores[index]).toBeLessThan(scores[index - 1]);
      }
      expect(scores[0]).toBe(0.5);
    });
  });

  /**
   * The same raw accuracy means different things at different option counts
   * (`FEAT-051`): getting a true-or-false question right half the time is
   * pure guessing, and getting a six-option one right half the time is not.
   */
  describe('the accuracy is corrected for guessing, by the option count', () => {
    const halfRight = { answered: 300, correct: 150 };

    it('reads half right on two options as nobody knowing it', () => {
      // (0.5 − 1/2) / (1 − 1/2) = 0, so observed difficulty 1.
      expect(difficultyScore(question(2, halfRight))).toBeCloseTo((5 + 300) / 310, 10);
    });

    it('reads half right on four options as a third of players knowing it', () => {
      // (0.5 − 1/4) / (1 − 1/4) = 1/3, so observed difficulty 2/3.
      expect(difficultyScore(question(4, halfRight))).toBeCloseTo((5 + 200) / 310, 10);
    });

    it('reads half right on six options as two fifths of players knowing it', () => {
      // (0.5 − 1/6) / (1 − 1/6) = 0.4, so observed difficulty 0.6.
      expect(difficultyScore(question(6, halfRight))).toBeCloseTo((5 + 180) / 310, 10);
    });

    it('ranks the same accuracy harder the fewer options there were to guess from', () => {
      const two = difficultyScore(question(2, halfRight));
      const four = difficultyScore(question(4, halfRight));
      const six = difficultyScore(question(6, halfRight));

      expect(two).toBeGreaterThan(four);
      expect(four).toBeGreaterThan(six);
    });

    it('reads an accuracy exactly at chance as nobody knowing it, at every count', () => {
      for (const options of [2, 3, 4, 5, 6]) {
        const atChance = { answered: options * 50, correct: 50 };
        expect(difficultyScore(question(options, atChance)), `${options} options`).toBeCloseTo(
          (5 + options * 50) / (10 + options * 50),
          10,
        );
      }
    });
  });

  describe('the corrected accuracy is clamped into [0, 1]', () => {
    // Below chance is no evidence of knowledge at all — not negative knowledge
    // — so it reads as the floor rather than as a difficulty above 1.
    it('clamps an accuracy below chance to nobody knowing it', () => {
      const belowChance = difficultyScore(question(4, { answered: 300, correct: 30 }));

      expect(belowChance).toBeCloseTo((5 + 300) / 310, 10);
      expect(belowChance).toBeLessThanOrEqual(1);
    });

    it('scores every answer wrong on two options no harder than the clamp allows', () => {
      expect(difficultyScore(question(2, { answered: 300, correct: 0 }))).toBeCloseTo(
        (5 + 300) / 310,
        10,
      );
    });

    // The other edge: a perfect record lands exactly on the top of the
    // corrected scale, so the observed difficulty is exactly 0.
    it('lands a perfect record exactly at the top, at two, four and six options', () => {
      for (const options of [2, 4, 6]) {
        expect(
          difficultyScore(question(options, { answered: 90, correct: 90 }, 'hard')),
          `${options} options`,
        ).toBeCloseTo(7.5 / 100, 10);
      }
    });

    it('never leaves [0, 1], whatever the counts, labels and option counts', () => {
      for (const label of ['easy', 'medium', 'hard'] as const) {
        for (const options of [2, 3, 4, 5, 6]) {
          for (const answered of [1, 2, 7, 50, 999]) {
            for (const correct of [0, 1, Math.floor(answered / 2), answered]) {
              if (correct > answered) {
                continue;
              }
              const score = difficultyScore(question(options, { answered, correct }, label));
              expect(score).toBeGreaterThanOrEqual(0);
              expect(score).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    });
  });

  /**
   * Re-checked rather than trusted (`CLAUDE.md` §4.4): a pair that cannot be a
   * count is no evidence, so the question scores its label rather than a number
   * built from it.
   */
  describe('counters that cannot be trusted read as none', () => {
    it('scores its label when the pair is broken', () => {
      for (const broken of [
        { answered: 3, correct: 4 },
        { answered: -1, correct: 0 },
        { answered: 5, correct: -1 },
        { answered: 2.5, correct: 1 },
        { answered: 5, correct: 1.5 },
        { answered: '5', correct: 1 },
        { answered: 5, correct: null },
        { answered: Number.POSITIVE_INFINITY, correct: 1 },
        { correct: 2 },
      ]) {
        expect(difficultyScore(question(4, broken, 'hard')), JSON.stringify(broken)).toBe(0.75);
      }
    });

    // One option is no choice: every answer is right by construction.
    it('scores its label when there is nothing to choose between', () => {
      expect(difficultyScore(question(1, { answered: 40, correct: 40 }, 'easy'))).toBe(0.25);
    });
  });
});

describe('readCounters', () => {
  it('reads a pair the callable wrote', () => {
    expect(readCounters({ answered: 12, correct: 5 })).toEqual({ answered: 12, correct: 5 });
  });

  it('reads an absent right-answer count beside a present one as none right', () => {
    expect(readCounters({ answered: 4 })).toEqual({ answered: 4, correct: 0 });
  });

  it('reads no counters at all as none', () => {
    expect(readCounters({})).toBeNull();
  });
});

describe('difficultyBand', () => {
  it("puts each label's own value in that label's band", () => {
    expect(difficultyBand(LABEL_DIFFICULTY.easy)).toBe('easy');
    expect(difficultyBand(LABEL_DIFFICULTY.medium)).toBe('medium');
    expect(difficultyBand(LABEL_DIFFICULTY.hard)).toBe('hard');
  });

  it('draws the bands at the spec table', () => {
    expect(difficultyBand(0)).toBe('easy');
    expect(difficultyBand(0.33)).toBe('easy');
    expect(difficultyBand(0.34)).toBe('medium');
    expect(difficultyBand(0.66)).toBe('medium');
    expect(difficultyBand(0.67)).toBe('hard');
    expect(difficultyBand(1)).toBe('hard');
  });

  /**
   * The table is written in hundredths, so a score between two of its rows is
   * read to two places: the edges are 0.335 and 0.665. Thirds would put both
   * of the middle rows here in the other band.
   */
  it("reads a score between the table's rows on its value to two places", () => {
    expect(difficultyBand(0.334)).toBe('easy');
    expect(difficultyBand(0.336)).toBe('medium');
    expect(difficultyBand(0.664)).toBe('medium');
    expect(difficultyBand(0.666)).toBe('hard');
  });

  it('reads a score outside the scale as the band at that end', () => {
    expect(difficultyBand(-0.2)).toBe('easy');
    expect(difficultyBand(1.4)).toBe('hard');
  });

  // The recap shows a question's band rather than its score, so a question
  // players have found harder than its author did has to land in a different
  // word — the case the pill exists to show.
  it('moves a question out of its label once enough players disagree with it', () => {
    const labelledEasy = (answered: number, correct: number) =>
      difficultyBand(difficultyScore(question(4, { answered, correct }, 'easy')));

    expect(labelledEasy(3, 0)).toBe('medium');
    expect(labelledEasy(30, 6)).toBe('hard');
    expect(labelledEasy(30, 30)).toBe('easy');
  });
});
