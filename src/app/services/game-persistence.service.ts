import { Injectable, inject } from '@angular/core';
import {
  ALL_LIFELINES_AVAILABLE,
  DEFAULT_TIME_LIMIT,
  Difficulty,
  GameConfig,
  LIFELINE_IDS,
  LifelineState,
  PickedAnswer,
  QuestionSource,
  TriviaQuestion,
  isTimeLimitOption,
} from '../models/question.model';
import { CURRENT_GAME_KEY, GAME_STATE_STORE, OfflineDbService } from './offline-db.service';

/**
 * How long a saved game stays resumable. Long enough to cover a reload, a tab
 * crash, a phone locking mid-question or a short break; short enough that a
 * game abandoned yesterday doesn't reappear as an offer to "resume" something
 * the player has entirely forgotten starting.
 */
const SAVED_GAME_TTL_MS = 6 * 60 * 60 * 1000;

/** Bumped whenever the persisted shape changes; a mismatch discards rather than migrates. */
const SCHEMA_VERSION = 1;

export interface PersistedGame {
  version: number;
  savedAt: number;
  config: GameConfig;
  questions: TriviaQuestion[];
  currentIndex: number;
  score: number;
  /** True once the last question was answered — the player is on `/game-over`, not mid-game. */
  isComplete: boolean;
  /**
   * Ids of questions the player flagged while playing, to be reported on the
   * game-over screen.
   *
   * **Deliberately additive rather than a `SCHEMA_VERSION` bump.** A version
   * mismatch discards the save, and this field is optional in both directions:
   * a save written before it restores with no flags, and a save written with
   * it is ignored harmlessly by an older build. Bumping would throw away every
   * in-flight game at deploy time to gain nothing — the flags are the *least*
   * important thing in the snapshot, and losing the game to protect them would
   * be exactly backwards.
   */
  flaggedQuestionIds: string[];
  /**
   * The option the player picked for each question answered so far, in order —
   * an answer `id`, or `null` for a timeout. What the game-over recap renders.
   *
   * **Additive, and no `SCHEMA_VERSION` bump**, for the same reason as
   * `flaggedQuestionIds` above: a mismatch discards rather than migrates, so
   * bumping would throw away every in-flight game at deploy time. A save
   * written before this field restores with an empty history, which the recap
   * treats as "no recap" rather than as "you got none right" — see
   * `GameOverComponent.recap`.
   */
  answerHistory: PickedAnswer[];
  /**
   * Which lifelines are still unspent (`FEAT-002`), and which options 50/50 has
   * already removed from the question the player is looking at.
   *
   * Both additive, no `SCHEMA_VERSION` bump — the fourth time this call has
   * been made, for the same reason each time: a mismatch discards the game
   * rather than migrating it.
   *
   * They are two fields rather than one because they expire differently: the
   * availability flags last the whole round, the eliminated ids last exactly
   * one question. They still have to restore *together*, though — bringing back
   * "50/50 spent" without the options it removed would take the lifeline and
   * hand nothing back — which is why an unusable value for either resets both.
   */
  lifelines: LifelineState;
  eliminatedAnswerIds: string[];
}

/** As written to the object store: the same record plus the keyPath field. */
interface StoredGame extends PersistedGame {
  id: string;
}

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];
const SOURCES: readonly QuestionSource[] = ['open_trivia', 'custom', 'mixed'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAnswer(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['text'] === 'string' &&
    typeof value['isCorrect'] === 'boolean'
  );
}

function isQuestion(value: unknown): value is TriviaQuestion {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['question'] === 'string' &&
    typeof value['correct_answer'] === 'string' &&
    typeof value['category'] === 'string' &&
    Array.isArray(value['incorrect_answers']) &&
    Array.isArray(value['all_answers']) &&
    value['all_answers'].length > 0 &&
    value['all_answers'].every(isAnswer)
  );
}

/**
 * `timeLimit` is deliberately **not** required here, and the schema version was
 * not bumped for it — same call as `flaggedQuestionIds` before it. The field is
 * additive, an absent one has an unambiguous correct answer (every game saved
 * before the picker existed was played at 15 seconds, the only limit there
 * was), and bumping would have thrown away every in-progress game on deploy to
 * prevent a problem that does not exist. A *present* value still has to be one
 * of the real options: a hand-edited record naming a board that isn't real
 * would produce a game whose score the rules refuse.
 */
function isConfig(value: unknown): value is GameConfig {
  return (
    isRecord(value) &&
    typeof value['amount'] === 'number' &&
    typeof value['category'] === 'string' &&
    (value['difficulty'] === '' || DIFFICULTIES.includes(value['difficulty'] as Difficulty)) &&
    SOURCES.includes(value['source'] as QuestionSource) &&
    (value['timeLimit'] === undefined || isTimeLimitOption(value['timeLimit']))
  );
}

/** Fills in the limit a pre-G7 save was necessarily played under. */
function withTimeLimit(config: GameConfig): GameConfig {
  return { ...config, timeLimit: config.timeLimit ?? DEFAULT_TIME_LIMIT };
}

/**
 * Validates a record read back out of the store before any of it reaches the
 * app's signals.
 *
 * Not a security boundary — it is the player's own browser, holding their own
 * score, and the only thing that ever gets *published* (a leaderboard write) is
 * validated server-side by `firestore.rules` regardless of what this returns.
 * It is a robustness boundary: the database outlives deploys, so this will be
 * handed shapes written by older versions of the app, half-written values, and
 * whatever a curious player typed into devtools. Anything unrecognised is
 * discarded rather than trusted, because the alternative is an exception during
 * bootstrap, which white-screens the whole app rather than just losing a game.
 *
 * Takes an already-deserialized value: IndexedDB stores structured clones, so
 * unlike a string-based store there is no parse step here that could itself
 * throw.
 */
function parseSavedGame(parsed: unknown, now: number): PersistedGame | null {
  if (!isRecord(parsed) || parsed['version'] !== SCHEMA_VERSION) {
    return null;
  }

  const {
    savedAt,
    config,
    questions,
    currentIndex,
    score,
    isComplete,
    flaggedQuestionIds,
    answerHistory,
    lifelines,
    eliminatedAnswerIds,
  } = parsed;

  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) {
    return null;
  }
  // A save from the future means a clock that has since moved backwards; treat
  // it as current rather than as expired, so a timezone/NTP correction doesn't
  // silently eat a game in progress.
  if (now - savedAt > SAVED_GAME_TTL_MS) {
    return null;
  }
  if (!isConfig(config)) {
    return null;
  }
  if (!Array.isArray(questions) || questions.length === 0 || !questions.every(isQuestion)) {
    return null;
  }
  if (
    typeof currentIndex !== 'number' ||
    !Number.isInteger(currentIndex) ||
    currentIndex < 0 ||
    currentIndex >= questions.length
  ) {
    return null;
  }
  if (
    typeof score !== 'number' ||
    !Number.isInteger(score) ||
    score < 0 ||
    score > questions.length
  ) {
    return null;
  }

  return {
    version: SCHEMA_VERSION,
    savedAt,
    config: withTimeLimit(config),
    questions,
    currentIndex,
    score,
    isComplete: isComplete === true,
    // Anything unrecognised is dropped rather than rejecting the whole save:
    // a flag is a hint about a question, and losing one is not worth losing
    // the game it belongs to. Ids that no longer match a question in this
    // save are filtered out, so a truncated or edited record can't produce a
    // flag pointing at nothing.
    flaggedQuestionIds: Array.isArray(flaggedQuestionIds)
      ? flaggedQuestionIds.filter(
          (id): id is string =>
            typeof id === 'string' && questions.some((question) => question.id === id),
        )
      : [],
    // Dropped wholesale rather than filtered, unlike the flags above, and the
    // difference is that this array is *positional*: entry `i` is the answer to
    // question `i`. Filtering out one bad entry would silently shift every
    // later answer onto the wrong question, which is worse than no recap —
    // it would confidently show the player picking things they never picked.
    // So it is all-or-nothing, and the recap renders only when the history
    // covers the whole game.
    answerHistory: isUsableAnswerHistory(answerHistory, questions) ? answerHistory : [],
    // Both or neither, per the field comment: restoring a spent 50/50 without
    // the options it removed is strictly worse than restoring a fresh set.
    ...restoreLifelines(lifelines, eliminatedAnswerIds, questions[currentIndex]),
  };
}

/**
 * Whether a restored answer history can be trusted to line up with its
 * questions: no longer than the game, and every entry a recognised outcome —
 * with an `answered` id belonging to *that* question's own options.
 *
 * The last clause is the one that matters. An id that exists in the game but
 * on a different question would render a plausible, wrong recap rather than
 * an obviously broken one.
 *
 * It also rejects the **previous shape** (`string | null`), which is how a game
 * in flight across the `FEAT-002` deploy loses its recap and keeps its score.
 */
function isUsableAnswerHistory(
  value: unknown,
  questions: TriviaQuestion[],
): value is PickedAnswer[] {
  if (!Array.isArray(value) || value.length > questions.length) {
    return false;
  }
  return value.every((picked, index) => {
    if (!isRecord(picked)) {
      return false;
    }
    switch (picked['kind']) {
      case 'timedOut':
      case 'skipped':
        return true;
      case 'answered':
        return questions[index].all_answers.some((answer) => answer.id === picked['id']);
      default:
        return false;
    }
  });
}

/**
 * Lifeline availability, or `null` if the stored value is not a complete set of
 * three booleans.
 *
 * All-or-nothing rather than per-key defaulting, and the direction of the
 * default matters: a partial record filled in with `true` **refunds** whatever
 * was missing, so a truncated or hand-edited save would be worth spending a
 * lifeline to produce. Reset the whole set instead, which is the same answer a
 * fresh game gives.
 */
function parseLifelines(value: unknown): LifelineState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!LIFELINE_IDS.every((id) => typeof value[id] === 'boolean')) {
    return null;
  }
  return Object.fromEntries(LIFELINE_IDS.map((id) => [id, value[id]])) as unknown as LifelineState;
}

/** Eliminated ids are only meaningful against the question on screen. */
function isUsableEliminatedIds(
  value: unknown,
  question: TriviaQuestion | undefined,
): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  if (value.length === 0) {
    return true;
  }
  if (question === undefined) {
    return false;
  }
  return value.every(
    (id) => typeof id === 'string' && question.all_answers.some((answer) => answer.id === id),
  );
}

function restoreLifelines(
  lifelines: unknown,
  eliminatedAnswerIds: unknown,
  currentQuestion: TriviaQuestion | undefined,
): Pick<PersistedGame, 'lifelines' | 'eliminatedAnswerIds'> {
  const parsed = parseLifelines(lifelines);
  if (parsed === null || !isUsableEliminatedIds(eliminatedAnswerIds, currentQuestion)) {
    return { lifelines: ALL_LIFELINES_AVAILABLE, eliminatedAnswerIds: [] };
  }
  return { lifelines: parsed, eliminatedAnswerIds };
}

/**
 * Reads and writes the in-progress game to `localStorage`, so a game survives a
 * reload, a tab crash, or a PWA relaunch (finding B8). Kept separate from
 * `GameControllerService` so the storage format, its validation and its expiry
 * are testable without standing up the whole controller.
 *
 * **Backed by IndexedDB, in the same database as the offline question pool**
 * (`OfflineDbService`), rather than by `localStorage`. `localStorage` would be
 * the simpler API and holds this payload comfortably, but it is synchronous and
 * blocks the main thread on every read and write, and the app already runs an
 * IndexedDB store for offline play — so one storage mechanism, one schema and
 * one place to reason about eviction beats two, which matters more as further
 * state becomes worth persisting. The cost is that reading is asynchronous, and
 * bootstrap has to account for it: see `GameControllerService.restoreSavedGame()`
 * and the app initializer that awaits it.
 *
 * Every access is wrapped, because storage can be unavailable outright (Safari
 * private mode, IndexedDB disabled, a quota refusal) — losing the ability to
 * save a game must never take the game itself down with it.
 */
@Injectable({ providedIn: 'root' })
export class GamePersistenceService {
  private readonly db = inject(OfflineDbService);

  async load(): Promise<PersistedGame | null> {
    let stored: unknown;
    try {
      const db = await this.db.open();
      stored = await new Promise<unknown>((resolve, reject) => {
        const request = db
          .transaction(GAME_STATE_STORE, 'readonly')
          .objectStore(GAME_STATE_STORE)
          .get(CURRENT_GAME_KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error as Error);
      });
    } catch {
      return null;
    }

    if (stored === undefined) {
      return null;
    }

    const saved = parseSavedGame(stored, Date.now());
    if (!saved) {
      // Expired or unreadable — drop it so it isn't re-examined on every load.
      await this.clear();
    }
    return saved;
  }

  async save(game: Omit<PersistedGame, 'version' | 'savedAt'>): Promise<void> {
    const payload: StoredGame = {
      ...game,
      id: CURRENT_GAME_KEY,
      version: SCHEMA_VERSION,
      savedAt: Date.now(),
    };

    try {
      const db = await this.db.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(GAME_STATE_STORE, 'readwrite');
        tx.objectStore(GAME_STATE_STORE).put(payload);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as Error);
      });
    } catch {
      // Storage full or unavailable. The game carries on in memory; it just
      // won't survive a reload, which is exactly the pre-B8 behaviour.
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.db.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(GAME_STATE_STORE, 'readwrite');
        tx.objectStore(GAME_STATE_STORE).delete(CURRENT_GAME_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as Error);
      });
    } catch {
      // Nothing to do — see save().
    }
  }
}
