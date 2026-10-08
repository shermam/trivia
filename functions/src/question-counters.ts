/**
 * The two counters a community question carries (`FEAT-023`): how many times
 * it has been answered in a banked game, and how many of those answers were
 * right. The app derives a calibrated difficulty from them at read time
 * (`src/app/utils/difficulty-score.util.ts`); nothing derived is stored, so a
 * change to the formula is a client deploy rather than a migration over the
 * bank.
 *
 * Kept pure and separate from the callable for the reason `game-stats.ts` and
 * `play-history.ts` are: `CLAUDE.md` §4.6 wants a direct unit test on a
 * decision a Cloud Function makes, and that stays cheap only while the decision
 * does not need Auth and Firestore standing up behind it. `game-result.ts`
 * applies what these functions decide, inside `recordGameResult`'s
 * transaction.
 *
 * **The counts are counted from `FEAT-049`'s per-answer records, not from a
 * second list.** Every entry that names a `custom_questions` id is one answer
 * to that question; an Open Trivia entry names none — its ids are minted per
 * fetch and there is no document to count against — and counts nothing.
 *
 * **They are aggregate, and that is the distinction the Privacy Policy rests
 * on.** A counter records that a question was answered, never who answered it:
 * no uid, no time and no game id is written beside it, so nothing can join it
 * back to the play history it was counted from — and nothing ever should.
 *
 * **Bounded, not attested** — audit decision `A1` once more. The outcomes are
 * client-supplied, so somebody can skew a question's difficulty by lying about
 * their own round. What bounds it is one game's worth per call (below), one
 * call per game id, and sixty games an hour per account (`game-stats.ts`).
 * That is calibration, not a security boundary: the report channel catches a
 * bad question; this catches a badly labelled one.
 */
import type { PlayAnswer } from './play-history';

/** What one banked game adds to one question's counters. */
export interface QuestionCounterIncrement {
  questionId: string;
  /** Always 1: one game answers a question once. */
  answered: number;
  /** 1 when that answer was right, 0 otherwise — never more than `answered`. */
  correct: number;
}

/** The pair as stored on a `custom_questions` document. */
export interface QuestionCounters {
  answered: number;
  correct: number;
}

/**
 * The increments one game's per-answer records produce: one per bank question
 * named, in the order the game asked them.
 *
 * **A question is counted once per game, however many entries name it.** A
 * real game never holds the same bank question twice — the draw reads each
 * document once — so for every honest payload this is exactly one increment
 * per entry. What it changes is the forged payload that names one question
 * twenty-five times: without it, a single call would move that question's
 * counters by twenty-five answers, where `FEAT-023`'s bound is one honest
 * game's worth per call. The first entry is the one counted; which one is
 * arbitrary, because only a forged payload can disagree with itself.
 *
 * **`correct` is derived from the same entry as `answered`**, so an increment
 * can never claim a right answer to a question it did not count as answered —
 * the invariant the stored pair has to keep (`correct <= answered`).
 *
 * `null` and `undefined` are the same case — a game with no history — for the
 * reason `playRecordFrom` gives: the callable SDK encodes a present-but-
 * `undefined` key as `null`. Either way nothing is counted.
 */
export function counterIncrementsFrom(
  answers: readonly PlayAnswer[] | null | undefined,
): QuestionCounterIncrement[] {
  if (answers == null) {
    return [];
  }
  const counted = new Set<string>();
  const increments: QuestionCounterIncrement[] = [];
  for (const answer of answers) {
    const { questionId } = answer;
    if (questionId === undefined || counted.has(questionId)) {
      continue;
    }
    counted.add(questionId);
    increments.push({ questionId, answered: 1, correct: answer.correct ? 1 : 0 });
  }
  return increments;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The counters as stored on a question, or `null` when they cannot be read as a
 * pair.
 *
 * **Absent means zero**, which is every question nobody has finished a game
 * with yet — and the same reading `firestore.rules` gives an absent counter.
 * A pair that is present but broken (not whole numbers, negative, or more right
 * answers than answers) is `null`: only `recordGameResult` writes these fields,
 * and it never writes such a pair, so one can only have come from a hand edit in
 * the console.
 */
export function storedCountersFrom(data: unknown): QuestionCounters | null {
  const fields = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const answered = fields['answered'] ?? 0;
  const correct = fields['correct'] ?? 0;
  if (!isCount(answered) || !isCount(correct) || correct > answered) {
    return null;
  }
  return { answered, correct };
}

/**
 * What a question's counters become once one increment is added.
 *
 * **A broken stored pair is replaced rather than added to.** Adding to it would
 * carry the damage forward — `FieldValue.increment` on a field holding a string
 * sets the field to the increment and leaves its partner alone, which can leave
 * more right answers than answers — and the owner's edit validates the stored
 * pair against `firestore.rules`' shape, so a pair the rules refuse would stop
 * the question's author editing it. Starting again from this game's answer is
 * the honest reading of a count nobody can trust: evidence of nothing.
 */
export function nextQuestionCounters(
  stored: unknown,
  increment: Pick<QuestionCounterIncrement, 'answered' | 'correct'>,
): QuestionCounters {
  const current = storedCountersFrom(stored) ?? { answered: 0, correct: 0 };
  return {
    answered: current.answered + increment.answered,
    correct: current.correct + increment.correct,
  };
}
