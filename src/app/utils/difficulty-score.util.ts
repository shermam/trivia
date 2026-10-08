import { Difficulty } from '../models/question.model';

/**
 * A question's difficulty as players have found it (`FEAT-023`): a number from
 * 0 (everybody gets it right) to 1 (nobody does), derived at read time from the
 * label the contributor gave it and the two counters `recordGameResult` keeps
 * on it — `answered` and `correct`.
 *
 * **Derived, never stored.** A stored score would be a third number able to
 * disagree with the two it is computed from, and a change to this formula would
 * be a migration over the whole bank. Computed here, a change is a client
 * deploy.
 *
 * **A pure function in `utils/`** for the reason `play-history.util.ts` is one:
 * the recap reads it today, and `FEAT-029`'s difficulty band and `FEAT-018`'s
 * ramping mode are meant to read the same number, so the arithmetic is worth
 * testing on its own rather than through whichever screen calls it first.
 *
 * The three steps, each checkable by hand:
 *
 * 1. **The label is the prior** — `easy` 0.25, `medium` 0.5, `hard` 0.75. A
 *    question nobody has answered scores exactly its label, which is what every
 *    question in the bank did before the counters existed, so no reader needs a
 *    special case for an uncalibrated question and nothing had to be
 *    backfilled.
 * 2. **The accuracy is corrected for guessing.** A question with `n` options is
 *    answered correctly by chance one time in `n` — half the time on a
 *    true-or-false question, a sixth of the time on six options (`FEAT-051`) —
 *    so the same knowledge produces a higher raw accuracy on two options than on
 *    six. `(accuracy − 1/n) / (1 − 1/n)` is the share of players who knew the
 *    answer, if everybody who did not know it guessed; an accuracy at or below
 *    chance is no evidence of knowledge at all, and reads as zero.
 * 3. **The label is shrunk towards what players did as `answered` grows.** The
 *    label counts as {@link PRIOR_WEIGHT} answers: with three answers the score
 *    sits close to the label, with three hundred it sits close to the corrected
 *    accuracy, and nothing switches over at a threshold. `answered` **is** the
 *    sample size, so no confidence field is stored beside it.
 *
 * Neither response time nor lifeline use is an input. Both are facts about a
 * player rather than about a question, and they live in the play history
 * (`FEAT-049`), where its retention and deletion reach them.
 */

/** What each contributor label means on the 0–1 scale, before anybody has answered. */
export const LABEL_DIFFICULTY: Readonly<Record<Difficulty, number>> = {
  easy: 0.25,
  medium: 0.5,
  hard: 0.75,
};

/**
 * How many answers the contributor's label is worth.
 *
 * Ten, because a label is one person's guess placed in one of three bins, and
 * ten answers is roughly where the observed accuracy becomes the better guess
 * of the two: its spread is about ±0.16 at ten answers, a bin's half-width is
 * 0.125, and a two-option question's correction doubles the spread on top. So a
 * question two players have answered still reads essentially as labelled, one
 * two hundred players have answered reads essentially as played, and each
 * answer moves the score a little rather than one answer moving it a lot.
 */
export const PRIOR_WEIGHT = 10;

/** The two counters as a usable pair. */
export interface QuestionCounters {
  answered: number;
  correct: number;
}

/** What {@link difficultyScore} reads off a question — a `TriviaQuestion` has all of it. */
export interface DifficultyInputs {
  difficulty: Difficulty;
  /** Its length plus the correct answer is the option count the guessing correction uses. */
  incorrect_answers: readonly unknown[];
  answered?: unknown;
  correct?: unknown;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The counters a question carries, or `null` when it carries none it can be
 * trusted for.
 *
 * **Re-checked rather than trusted** (`CLAUDE.md` §4.4): only the Admin SDK
 * writes these and `firestore.rules` bounds them, but `custom_questions` is a
 * public API the console writes to directly, and a saved game comes back from
 * disk. A pair that is not two whole, non-negative counts with no more right
 * answers than answers is no evidence of anything, so it is read as none and the
 * question scores its label. An absent `correct` beside a present `answered`
 * means none of them were right — the reading the callable and the rules give
 * an absent counter.
 */
export function readCounters(question: {
  answered?: unknown;
  correct?: unknown;
}): QuestionCounters | null {
  const { answered, correct = 0 } = question;
  if (answered === undefined || !isCount(answered) || !isCount(correct) || correct > answered) {
    return null;
  }
  return { answered, correct };
}

/**
 * The label's value on the scale, read through a `switch` rather than an index
 * into {@link LABEL_DIFFICULTY}: the type says the label is one of three, but a
 * console-written document is not bound by the type, and an index lookup on
 * `'constructor'` would return a function. Anything outside the three reads as
 * `medium` — the middle of the scale, which claims nothing.
 */
function labelValue(difficulty: Difficulty): number {
  switch (difficulty) {
    case 'easy':
    case 'medium':
    case 'hard':
      return LABEL_DIFFICULTY[difficulty];
    default:
      return LABEL_DIFFICULTY.medium;
  }
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The calibrated difficulty of a question, from 0 (easiest) to 1 (hardest).
 *
 * Returns the label's value **exactly** for a question with no usable counters
 * or none answered yet — not a value near it — so a recap of an uncalibrated
 * question reads `0.50` rather than something that rounds to it.
 */
export function difficultyScore(question: DifficultyInputs): number {
  const prior = labelValue(question.difficulty);
  const counters = readCounters(question);
  const options = question.incorrect_answers.length + 1;
  // One option is no choice at all: every answer is right by construction, so
  // the counts say nothing about the question. The rules make it unreachable
  // for anything written through the app.
  if (counters === null || counters.answered === 0 || options < 2) {
    return prior;
  }

  const chance = 1 / options;
  const accuracy = counters.correct / counters.answered;
  // Below chance is clamped to "nobody knew it", which is as hard as the scale
  // goes. A perfect record lands exactly on 1: the numerator and the
  // denominator are then the same number.
  const knew = clampUnit((accuracy - chance) / (1 - chance));
  const observed = 1 - knew;

  return (PRIOR_WEIGHT * prior + counters.answered * observed) / (PRIOR_WEIGHT + counters.answered);
}

/** The three bands the scale is read in, by `FEAT-023`'s table. */
export type DifficultyBand = 'Easy' | 'Medium' | 'Hard';

/** A score as the recap shows it: two decimals, and the band they fall in. */
export interface DifficultyRating {
  /** `"0.42"` — always two decimals, so every rating is the same width. */
  value: string;
  band: DifficultyBand;
}

/**
 * The score rounded to hundredths, and its band: `0.00`–`0.33` Easy,
 * `0.34`–`0.66` Medium, `0.67`–`1.00` Hard.
 *
 * **The band is read off the rounded value, not the raw one**, so the two
 * halves of the label can never disagree: a raw 0.335 shows as `0.34`, and
 * `0.34` is Medium — reading the band off 0.335 would print "0.34 • Easy".
 */
export function difficultyRating(score: number): DifficultyRating {
  const hundredths = Math.round(clampUnit(score) * 100);
  return {
    value: (hundredths / 100).toFixed(2),
    band: hundredths <= 33 ? 'Easy' : hundredths <= 66 ? 'Medium' : 'Hard',
  };
}
