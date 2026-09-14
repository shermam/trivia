import { Difficulty, PickedAnswer, TriviaQuestion } from '../models/question.model';
import { readTags } from './normalize-tag.util';

/**
 * The per-answer records a finished game submits alongside its totals
 * (`FEAT-049`), and the one function that builds them.
 *
 * **A pure function in `utils/` rather than a method on the controller**, for
 * the reason `shuffle.util.ts` and `normalize-tag.util.ts` are: the shape it
 * produces is a contract with `functions/src/play-history.ts`, and a contract
 * is worth testing on its own rather than through whichever screen happens to
 * call it.
 *
 * Every bound below is spelled again in that file, which cannot be imported
 * from here — `functions/` is a separate npm package with its own `tsconfig`.
 * The duplication is where the two could drift, so the numbers are named
 * constants on both sides and both suites probe the same edges. What the client
 * decides is what it *sends*; the server independently refuses anything outside
 * the same bounds, because a client is not a place to enforce anything
 * (`CLAUDE.md` §4.1).
 */

/**
 * The longest a single answer may claim to have taken — two minutes.
 *
 * Not a statement about how long a question takes: it is the point past which
 * the number stops being evidence of anything, since a player who left the tab
 * open overnight on the `unlimited` board and a client sending nonsense are
 * indistinguishable from the server's side.
 */
export const MAX_ANSWER_MS = 120_000;

/** One question as the player met it, as `recordGameResult` accepts it. */
export interface PlayAnswerRecord {
  /** The bank question's id. **Absent** for an Open Trivia DB question. */
  questionId?: string;
  correct: boolean;
  ms: number;
  difficulty: Difficulty;
  /** The question's tags at play time, omitted when it has none. */
  tags?: string[];
}

/**
 * Whether the option the player picked was the right one.
 *
 * **The id, not the text, and the flag rather than a string comparison** — the
 * same rule the recap and the scorer follow (`CLAUDE.md` §4.4). A timeout and a
 * skip are both "not correct": the recommender's question is whether the player
 * got it right, and nothing downstream distinguishes the two ways of not doing
 * so.
 */
function wasCorrect(question: TriviaQuestion, picked: PickedAnswer): boolean {
  if (picked.kind !== 'answered') {
    return false;
  }
  return question.all_answers.find((answer) => answer.id === picked.id)?.isCorrect === true;
}

/**
 * The play history for a finished game, or `undefined` when there is none worth
 * sending.
 *
 * **All or nothing, because the two arrays are positional.** Entry `i` of the
 * history answers question `i`, and entry `i` of the durations times it — so a
 * history one short of the game does not describe a shorter game, it describes
 * a different one. That is reachable rather than theoretical: a save written
 * before either field existed restores with an empty array, and
 * `isUsableAnswerHistory` drops a history it cannot line up with its questions
 * rather than filtering it. Those games bank their totals and leave no history,
 * which is the right way round — `recordGameResult` refuses an array that does
 * not cover the whole game, and refusing means losing the totals too.
 *
 * The id is sent only for a question that came from the bank. Open Trivia DB
 * ids are minted per fetch and mean nothing across batches, so an entry naming
 * one would be an entry nothing can use — and the key is omitted rather than
 * nulled, because Firestore refuses an `undefined` field value outright.
 */
export function buildPlayAnswers(
  questions: readonly TriviaQuestion[],
  history: readonly PickedAnswer[],
  durations: readonly number[],
): PlayAnswerRecord[] | undefined {
  if (
    questions.length === 0 ||
    history.length !== questions.length ||
    durations.length !== questions.length
  ) {
    return undefined;
  }

  return questions.map((question, index) => {
    const record: PlayAnswerRecord = {
      correct: wasCorrect(question, history[index]),
      ms: boundedMs(durations[index]),
      difficulty: question.difficulty,
    };
    if (question.source === 'custom') {
      record.questionId = question.id;
    }
    // Read through the same predicate the chips render with, so a tag the rules
    // would refuse — one written straight into the console, say — never reaches
    // the payload and turns an honest game into a rejected submission.
    const tags = readTags(question.tags);
    if (tags) {
      record.tags = tags;
    }
    return record;
  });
}

/** A duration clamped into the range the server will accept. */
function boundedMs(ms: number): number {
  if (!Number.isFinite(ms)) {
    return 0;
  }
  return Math.min(Math.max(0, Math.round(ms)), MAX_ANSWER_MS);
}
