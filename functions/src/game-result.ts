import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import {
  type GameResultSubmission,
  type StatsDecision,
  type UserStats,
  nextUserStats,
} from './game-stats';
import { nextQuestionCounters } from './question-counters';

/** The documents one banked game touches, named by the caller. */
export interface GameResultRefs {
  /** `users/{uid}` — the lifetime totals, and the duplicate check's `lastGameId`. */
  user: DocumentReference;
  /** `users/{uid}/plays/{gameId}` — the round itself (`FEAT-049`). */
  play: (gameId: string) => DocumentReference;
  /** `custom_questions/{questionId}` — where the difficulty counters live (`FEAT-023`). */
  question: (questionId: string) => DocumentReference;
}

/**
 * Only the two counters are read off a question — not its 2,000-character
 * statement, its answers or its justification. A read is billed per document
 * whatever it returns, so this saves bandwidth rather than money, and it is
 * free.
 */
const COUNTER_FIELDS = ['answered', 'correct'];

/**
 * The body of `recordGameResult`'s transaction, taking the transaction rather
 * than opening one — which is what makes it reachable from a unit test, the
 * same split `applySupporterSince` and `applySetIfNotStale` make. Everything
 * it writes is what `nextUserStats` decided; what is only testable here is the
 * order things happen in and what is left alone.
 *
 * **The duplicate and rate checks come first, and a refusal touches nothing.**
 * The decision is made from the totals document alone, and a refused one
 * returns before any question is read or any document written — so the
 * `lastGameId` that stops a reload of `/game-over` banking a game twice stops it
 * counting the game twice into a question's counters too (`FEAT-023`).
 *
 * **Every read before any write**, which a Firestore transaction requires: the
 * totals, then the questions this game named, then the writes.
 *
 * **A question that no longer exists is skipped, never created.** An author may
 * withdraw one between the draw and the end of the game, and an `update` on a
 * missing document would fail the whole transaction and cost the player their
 * totals, while a merging `set` would resurrect a two-field husk of a question
 * the author deleted. So each question is read first, and only one that is still
 * there is counted.
 *
 * **The counts are written whole rather than as `FieldValue.increment`.** The
 * transaction has already read them, so the value written is exactly as current
 * as an increment would be, and computing it here is what lets a pair a hand
 * edit has broken be replaced rather than carried forward
 * (`nextQuestionCounters`).
 */
export async function applyGameResult(
  transaction: Transaction,
  refs: GameResultRefs,
  submission: unknown,
  nowMs: number,
): Promise<StatsDecision> {
  const snapshot = await transaction.get(refs.user);
  const current = snapshot.exists ? (snapshot.data() as UserStats) : null;

  // `submission` is `request.data`, which is anything at all; `nextUserStats`
  // validates it before trusting a field of it.
  const decision = nextUserStats(current, submission as GameResultSubmission, nowMs);
  if (!decision.accepted) {
    return decision;
  }

  const questionRefs = decision.counters.map((increment) => refs.question(increment.questionId));
  // `getAll` refuses an empty list of documents, and a game with no bank
  // question in it is the common case — every Open Trivia game.
  const questions =
    questionRefs.length > 0
      ? await transaction.getAll(...questionRefs, { fieldMask: COUNTER_FIELDS })
      : [];

  transaction.set(refs.user, decision.stats);
  // The play history, in the same transaction and under the same game id
  // (`FEAT-049`). `lastGameId` *is* that id, so nothing here re-reads the
  // payload — the decision already validated it, and the duplicate check that
  // protects the totals therefore protects this document too.
  //
  // `null` whenever the submission carried no per-answer records: a pre-feature
  // client, or a game restored from a save whose history could not be lined up
  // with its questions. Those games bank their totals and leave no history,
  // which is the right way round.
  if (decision.play) {
    transaction.set(refs.play(decision.stats.lastGameId), decision.play);
  }
  decision.counters.forEach((increment, index) => {
    if (!questions[index].exists) {
      return;
    }
    // The two fields by name and nothing else, so the update cannot reach the
    // question's content whatever the read handed back.
    const next = nextQuestionCounters(questions[index].data(), increment);
    transaction.update(questionRefs[index], { answered: next.answered, correct: next.correct });
  });
  return decision;
}
