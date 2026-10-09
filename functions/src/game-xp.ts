/**
 * What one finished game is worth in experience points (`FEAT-041`).
 *
 * Kept pure and separate from the callable for the reason `role.ts` and
 * `game-stats.ts` are: `CLAUDE.md` §4.6 wants a direct unit test on a decision
 * a Cloud Function makes, and that stays cheap only while the decision needs
 * no Auth or Firestore standing up behind it. `game-result.ts` applies it
 * inside `recordGameResult`'s transaction; `levels.ts` turns the running total
 * into a level.
 *
 * **Computed from what the transaction already holds, and nothing else**: the
 * game's per-answer records (`FEAT-049`) and, for each community question in
 * it, the stored `answered`/`correct` counters (`FEAT-023`) and its wrong
 * answers, all read in the one masked read the counters already needed. No
 * history is read and no second call is made, so a game costs exactly what it
 * did before.
 *
 * **Not `correctAnswers` under a new name.** Two players with the same number
 * of right answers earn different XP when one answered harder questions, or
 * answered them in a row — which no lifetime counter on `users/{uid}` can say.
 * `game-xp.test.ts` pins exactly that.
 *
 * **Bounded, not attested** — audit decision A1, as for the totals. The records
 * are client-supplied, so a player can lie their way to XP; what bounds it is
 * the payload's own bounds (at most 25 answers, one call per game id, sixty
 * games an hour), which make a game worth at most 800 XP. That is why a level
 * unlocks a cosmetic its owner sees and nothing anybody else does.
 */
import type { PlayAnswer, PlayDifficulty } from './play-history';
import { storedCountersFrom } from './question-counters';

/** What a right answer earns before hardness, by the question's label. A wrong one earns nothing. */
export const XP_BASE: Readonly<Record<PlayDifficulty, number>> = Object.freeze({
  easy: 10,
  medium: 15,
  hard: 20,
});

/**
 * How many recorded answers a question needs before how players did on it
 * changes what it pays.
 *
 * Ten, the weight `FEAT-023`'s calibration gives a contributor's label
 * (`PRIOR_WEIGHT` in `src/app/utils/difficulty-score.util.ts`): below it the
 * observed accuracy is too noisy to price an answer on — one answer moves it by
 * a tenth or more — and the label's base stands alone.
 */
export const MIN_ANSWERS_FOR_HARDNESS = 10;

/** XP per answer in the game's longest run of right answers. */
export const STREAK_XP_PER_ANSWER = 2;

/** The question fields the hardness reads, beyond the two counters themselves. */
export const XP_QUESTION_FIELDS = ['incorrect_answers'] as const;

/**
 * The multiplier for a question whose chance-corrected accuracy is `knew`:
 * `1.5 − knew`, held to 0.5…1.5.
 *
 * `knew` is the share of players who knew the answer — `FEAT-023`'s guessing
 * correction — so a question nobody knew pays half as much again as its label,
 * one everybody knew pays half, and one half of them knew pays its label.
 *
 * **The clamp is where below-chance accuracy lands.** A question answered right
 * less often than guessing would manage gives a negative `knew`, which
 * `FEAT-023` reads as "nobody knew it" — the hardest there is — and the ceiling
 * here is the same reading. The floor is the other end of the same scale.
 */
export function hardnessMultiplier(knew: number): number {
  return Math.min(1.5, Math.max(0.5, 1.5 - knew));
}

/**
 * How hard a community question has proved, as a multiplier on its base: from
 * its counters as stored **before** this game, so a player's own answer does
 * not set its own price — or 1 when there is nothing to go on.
 *
 * 1 for a question with fewer than {@link MIN_ANSWERS_FOR_HARDNESS} recorded
 * answers, for counters a hand edit has broken (`storedCountersFrom` reads them
 * as none), and for a question with no usable option count, since the guessing
 * correction needs to know how often a guess is right. The option count is the
 * wrong answers plus the right one, exactly as `FEAT-023` counts them.
 */
export function observedHardness(question: unknown): number {
  const counters = storedCountersFrom(question);
  if (counters === null || counters.answered < MIN_ANSWERS_FOR_HARDNESS) {
    return 1;
  }
  const wrong = (question as Record<string, unknown>)['incorrect_answers'];
  if (!Array.isArray(wrong) || wrong.length === 0) {
    return 1;
  }
  const chance = 1 / (wrong.length + 1);
  const accuracy = counters.correct / counters.answered;
  return hardnessMultiplier((accuracy - chance) / (1 - chance));
}

/**
 * The XP one finished game earns, as a whole number.
 *
 * - A right answer earns {@link XP_BASE} for its label, scaled by
 *   {@link observedHardness} when it is a community question the transaction
 *   read; an Open Trivia question, or one that no longer exists, pays its label.
 * - Plus {@link STREAK_XP_PER_ANSWER} for each answer in the longest run of
 *   right answers, taken from the records in the order they were asked. A
 *   record cannot tell a skip from a wrong answer, so a skip ends the run here
 *   where the game's own streak (`FEAT-004`) lets it pass — the bonus can come
 *   out smaller than the streak the game showed, never larger.
 * - Rounded once, at the end, so the result does not depend on the order the
 *   fractions were added in.
 *
 * `questions` maps a community question's id to its stored fields. A game with
 * no per-answer records — a client from before them, or a save whose history
 * could not be lined up with its questions — earns nothing: XP is computed
 * from the records, and making it up from the totals for exactly those games
 * would be the lifetime counters under a new name.
 */
export function gameXp(
  answers: readonly PlayAnswer[] | null | undefined,
  questions: ReadonlyMap<string, unknown>,
): number {
  if (answers == null) {
    return 0;
  }
  let earned = 0;
  let run = 0;
  let longestRun = 0;
  for (const answer of answers) {
    if (!answer.correct) {
      run = 0;
      continue;
    }
    run += 1;
    longestRun = Math.max(longestRun, run);
    const stored = answer.questionId === undefined ? undefined : questions.get(answer.questionId);
    earned += XP_BASE[answer.difficulty] * (stored === undefined ? 1 : observedHardness(stored));
  }
  return Math.round(earned + STREAK_XP_PER_ANSWER * longestRun);
}
