import { type DocumentReference, FieldValue, type Transaction } from 'firebase-admin/firestore';
import {
  type GameResultSubmission,
  type StatsDecision,
  type StoredUserStats,
  nextUserStats,
} from './game-stats';
import { XP_QUESTION_FIELDS, gameXp } from './game-xp';
import { readXp } from './levels';
import { nextQuestionCounters } from './question-counters';

/** The documents one banked game touches, named by the caller. */
export interface GameResultRefs {
  /** `users/{uid}` — the lifetime totals, the ring of recent game ids and the daily counter. */
  user: DocumentReference;
  /** `users/{uid}/plays/{gameId}` — the round itself (`FEAT-049`). */
  play: (gameId: string) => DocumentReference;
  /** `custom_questions/{questionId}` — where the difficulty counters live (`FEAT-023`). */
  question: (questionId: string) => DocumentReference;
}

/**
 * What is read off a question: its two counters, and its wrong answers — for
 * their number alone, which is the option count the XP's guessing correction
 * needs (`game-xp.ts`) and which nothing else on the document records. Not its
 * 2,000-character statement or its justification. A read is billed per
 * document whatever it returns, so the mask saves bandwidth rather than money,
 * and widening it cost no read.
 */
const QUESTION_FIELDS = ['answered', 'correct', ...XP_QUESTION_FIELDS];

/** What a banked game added to the player's XP, and the total it came to. */
export interface XpAward {
  /** `users/{uid}.xp` after this game. */
  total: number;
  /** What this game earned (`gameXp`). */
  gained: number;
}

/**
 * The decision, and for a banked game the XP it earned — which is only known
 * once the questions it named have been read, after the decision is made.
 */
export type GameResultOutcome =
  | (Extract<StatsDecision, { accepted: true }> & { xp: XpAward })
  | Extract<StatsDecision, { accepted: false }>;

/**
 * The body of `recordGameResult`'s transaction, taking the transaction rather
 * than opening one — which is what makes it reachable from a unit test, the
 * same split `applySupporterSince` and `applySetIfNotStale` make. Everything
 * it writes is what `nextUserStats` decided; what is only testable here is the
 * order things happen in and what is left alone.
 *
 * **The duplicate check and both budgets come first, and a refusal touches
 * nothing.** The decision is made from the totals document alone, and a
 * refused one returns before any question is read or any document written — so
 * the ring of recent game ids that stops a reload of `/game-over` banking a
 * game twice stops it counting the game twice into a question's counters too
 * (`FEAT-023`), and a call over the daily ceiling or the hourly window writes
 * nothing at all: not the totals, not the XP, not the play history, not the
 * counters, and not the ring or the day's count either.
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
 *
 * **XP rides the same transaction and the same refusals** (`FEAT-041`). It is
 * priced from the questions' counters as read here, before this game's answers
 * are added to them, and merged into `users/{uid}` beside the totals — so a
 * duplicate or a call over either budget, which returns before anything else
 * is read, adds nothing to it either.
 *
 * **The ring replaces `lastGameId` in place.** A document that still carries
 * the old field is read as a ring of one (`recentGameIdsOf`), and the write
 * that banks its next game deletes the field beside writing the ring — so no
 * migration runs over the collection, and an account that never plays again
 * keeps a field nothing reads, which deleting the account removes with the
 * document.
 */
export async function applyGameResult(
  transaction: Transaction,
  refs: GameResultRefs,
  submission: unknown,
  nowMs: number,
): Promise<GameResultOutcome> {
  const snapshot = await transaction.get(refs.user);
  // `Partial`, because the document can exist with no totals in it — an
  // avatar chosen before the first finished game creates it (`FEAT-038`).
  const current = snapshot.exists ? (snapshot.data() as StoredUserStats & { xp?: unknown }) : null;

  // `submission` is `request.data`, which is anything at all; `nextUserStats`
  // validates it before trusting a field of it.
  const decision = nextUserStats(current, submission as GameResultSubmission, nowMs);
  if (!decision.accepted) {
    return decision;
  }

  const questionRefs = decision.counters.map((increment) => refs.question(increment.questionId));
  // A game with no bank question in it is the common case — every Open Trivia
  // game — and asks for nothing. (An empty `getAll` returns nothing here, after
  // the totals read; as a transaction's first read it fails outright, measured
  // against the emulator.)
  const questions =
    questionRefs.length > 0
      ? await transaction.getAll(...questionRefs, { fieldMask: QUESTION_FIELDS })
      : [];

  // What the game earned (`game-xp.ts`), priced from each question that is
  // still there as it stood before this game. The records are the decision's
  // rebuilt copy, so nothing here reads the raw payload.
  const stored = new Map<string, unknown>();
  decision.counters.forEach((increment, index) => {
    if (questions[index].exists) {
      stored.set(increment.questionId, questions[index].data());
    }
  });
  const gained = gameXp(decision.play?.answers, stored);
  const xp: XpAward = { total: readXp(current?.xp) + gained, gained };

  // **Merged, not replaced.** The totals and the XP are this function's
  // fields, not the whole document: `setAvatar` keeps the player's avatar
  // choice beside them (`FEAT-038`), and a plain `set` would erase it with
  // every game banked. The decision always carries every totals field, so
  // merging loses nothing the replace used to guarantee — it only stops
  // reaching past them. The ring is an array, which a merge replaces whole
  // rather than combining, and the day's count a map of two keys both written.
  transaction.set(
    refs.user,
    {
      ...decision.stats,
      xp: xp.total,
      ...(decision.dropsLastGameId ? { lastGameId: FieldValue.delete() } : {}),
    },
    { merge: true },
  );
  // The play history, in the same transaction and under the same game id
  // (`FEAT-049`). The ring's newest entry *is* that id, so nothing here
  // re-reads the payload — the decision already validated it, and the
  // duplicate check that protects the totals therefore protects this document
  // too.
  //
  // `null` whenever the submission carried no per-answer records: a pre-feature
  // client, or a game restored from a save whose history could not be lined up
  // with its questions. Those games bank their totals and leave no history,
  // which is the right way round.
  if (decision.play) {
    transaction.set(refs.play(decision.gameId), decision.play);
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
  return { ...decision, xp };
}
