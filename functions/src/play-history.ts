/**
 * What one completed game leaves behind at `users/{uid}/plays/{gameId}` —
 * which questions the player was shown, how they did on each, and how long
 * each one took (`FEAT-049`).
 *
 * Kept pure and separate from the callable for the reason `role.ts`,
 * `account-policy.ts` and `session-expiry.ts` are: `CLAUDE.md` §4.6 wants a
 * direct unit test on a decision a Cloud Function makes, and that stays cheap
 * only while the decision does not need Auth and Firestore standing up behind
 * it.
 *
 * **One document per game, not one per answer.** A 25-question game is one
 * write rather than twenty-five, against a callable that already does exactly
 * one; `gameId` is a natural id that is unique *and* idempotent under a retry,
 * which no per-answer document has; deletion and export walk one small
 * subcollection; and the retention sweep expires a whole game by a single `at`
 * field (`play-retention.ts`).
 *
 * **The payload is client-supplied, so it is bounded rather than attested** —
 * audit decision `A1` on a fourth surface. Somebody can lie to their own
 * recommender. That is comfortable here in a way it would not be on a
 * leaderboard, because the blast radius of a forged history is the liar's own
 * question selection: nothing in here is shown to another player, ranked
 * publicly, or spent.
 */

/**
 * The longest `questionId` this will store.
 *
 * A `custom_questions` id is a Firestore auto-id (20 characters) or a
 * hand-chosen one; 64 is comfortably above both and well below the 1,500-byte
 * ceiling a document id has, so the field cannot be used as free storage.
 */
export const MAX_QUESTION_ID_LENGTH = 64;

/**
 * The longest a single answer may claim to have taken.
 *
 * Two minutes, which is eight times the longest *bounded* question the app
 * offers (30 seconds plus the Extra Time lifeline) and a deliberate over-shoot
 * for the `unlimited` board, where the clock genuinely does not stop. It is not
 * a statement about how long a question takes — it is the point past which a
 * number stops being evidence of anything, because a player who left the tab
 * open overnight and a client sending `Number.MAX_SAFE_INTEGER` are
 * indistinguishable from here.
 */
export const MAX_ANSWER_MS = 120_000;

/**
 * Tag bounds, mirroring `src/app/utils/normalize-tag.util.ts` — the same
 * numbers and the same shape `firestore.rules` enforces on `custom_questions`.
 *
 * Spelled again rather than imported: `functions/` is a separate npm package
 * with its own `tsconfig`, so it cannot reach into `src/`. The duplication is
 * the point at which the two could drift, which is why the pattern below is
 * the normaliser's own regex character for character and why both suites probe
 * the same strings.
 */
export const MAX_TAGS_PER_ANSWER = 8;
export const MIN_TAG_LENGTH = 2;
export const MAX_TAG_LENGTH = 32;

/** Lower-case alphanumeric words joined by single hyphens — `normalizeTag`'s output. */
const TAG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

export type PlayDifficulty = (typeof DIFFICULTIES)[number];

/**
 * One question as the player met it.
 *
 * `questionId` is **absent** for an Open Trivia DB question rather than null or
 * empty. Their ids are minted per fetch and mean nothing across batches, so an
 * entry naming one would be an entry the recommender cannot use — and an absent
 * key says that without inventing a sentinel everything downstream would have
 * to know about.
 *
 * `tags` is a **snapshot**, not a reference. The recommender scores affinities
 * from what the player actually saw; re-reading each question's current tags at
 * recommendation time would be a read per question per game (`CLAUDE.md` §4.1)
 * and would also rewrite history when a question is re-tagged.
 */
export interface PlayAnswer {
  questionId?: string;
  correct: boolean;
  /** Time from the question appearing to the answer being committed. */
  ms: number;
  difficulty: PlayDifficulty;
  tags?: string[];
}

/** The document as stored. Every field is written by this module and nothing else. */
export interface PlayRecord {
  /** Epoch ms, when the game was banked — the retention key (`play-retention.ts`). */
  at: number;
  answers: PlayAnswer[];
}

function isTag(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_TAG_LENGTH &&
    value.length <= MAX_TAG_LENGTH &&
    TAG_PATTERN.test(value)
  );
}

function isValidTags(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length <= MAX_TAGS_PER_ANSWER && value.every((tag) => isTag(tag))
  );
}

function isValidAnswer(value: unknown): value is PlayAnswer {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { questionId, correct, ms, difficulty, tags } = value as Record<string, unknown>;

  if (
    questionId !== undefined &&
    (typeof questionId !== 'string' ||
      questionId.length === 0 ||
      questionId.length > MAX_QUESTION_ID_LENGTH)
  ) {
    return false;
  }
  if (typeof correct !== 'boolean') {
    return false;
  }
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 || ms > MAX_ANSWER_MS) {
    return false;
  }
  if (!DIFFICULTIES.includes(difficulty as PlayDifficulty)) {
    return false;
  }
  if (tags !== undefined && !isValidTags(tags)) {
    return false;
  }
  return true;
}

/**
 * Whether a submitted per-answer array is within every bound, and describes the
 * game it arrived with.
 *
 * **Length equal to `totalQuestions`, not merely below it.** A short array is
 * not a smaller history, it is a history that has lost track of which question
 * each entry belongs to — the array is positional in exactly the way
 * `GameControllerService.answerHistory` is, and the client omits it entirely
 * rather than sending a partial one (see `buildPlayAnswers` on the client
 * side). So there is no case where a short array is the honest thing to store.
 *
 * **No cross-check against `correctAnswers`, deliberately.** It is tempting to
 * require that the `correct: true` entries add up to the game's own count, and
 * it would buy nothing: the whole payload is client-supplied, so a liar sends
 * consistent lies, while an honest client can legitimately disagree with itself
 * after a restore — `parseSavedGame` clamps `correctAnswers` into range and the
 * history is restored all-or-nothing, so the two can survive a hand-edited save
 * in different states. A bound that only ever fires on an honest player is a
 * bound that costs them their game.
 */
export function isValidPlayAnswers(value: unknown, totalQuestions: number): value is PlayAnswer[] {
  return (
    Array.isArray(value) && value.length === totalQuestions && value.every((a) => isValidAnswer(a))
  );
}

/**
 * The document to store for this game, or `null` when the submission carried no
 * per-answer records at all.
 *
 * **Absent and `null` are the same case**, because the callable SDK cannot tell
 * a caller which one it sent: `encode()` in `@firebase/functions` maps
 * `undefined` to `null` for any key that is *present*, so `{ answers:
 * buildPlayAnswers(...) }` — the obvious way to write the call — arrives here
 * as `null` while omitting the key arrives as `undefined`. Treating the two
 * differently would make an invisible detail of the caller's object literal
 * decide whether the player keeps their lifetime totals.
 *
 * **Rebuilt key by key rather than passed through, and that is this function's
 * whole reason for existing.** The answers come off the wire, and `tx.set` of a
 * client-supplied object stores whatever else was in it — the server-side
 * equivalent of the missing exact-key `hasOnly()` allowlist that `CLAUDE.md`
 * §4.1 requires of a client-writable path. Rebuilding drops an unknown key
 * instead of refusing the write, which is the right way round: an older or
 * newer client sending a field this build has never heard of should still have
 * its game banked.
 *
 * A key that is absent stays absent. Firestore rejects an `undefined` field
 * value outright, so `questionId: undefined` would throw inside the transaction
 * and turn an Open Trivia game into an `internal` error.
 */
export function playRecordFrom(
  answers: PlayAnswer[] | null | undefined,
  nowMs: number,
): PlayRecord | null {
  if (answers == null) {
    return null;
  }
  return {
    at: nowMs,
    answers: answers.map((answer) => {
      const stored: PlayAnswer = {
        correct: answer.correct,
        ms: answer.ms,
        difficulty: answer.difficulty,
      };
      if (answer.questionId !== undefined) {
        stored.questionId = answer.questionId;
      }
      if (answer.tags !== undefined && answer.tags.length > 0) {
        stored.tags = [...answer.tags];
      }
      return stored;
    }),
  };
}
