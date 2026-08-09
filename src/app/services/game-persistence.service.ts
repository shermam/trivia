import { Injectable } from '@angular/core';
import { Difficulty, GameConfig, QuestionSource, TriviaQuestion } from '../models/question.model';

const STORAGE_KEY = 'trivia-game-in-progress';

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

function isConfig(value: unknown): value is GameConfig {
  return (
    isRecord(value) &&
    typeof value['amount'] === 'number' &&
    typeof value['category'] === 'string' &&
    (value['difficulty'] === '' || DIFFICULTIES.includes(value['difficulty'] as Difficulty)) &&
    SOURCES.includes(value['source'] as QuestionSource)
  );
}

/**
 * Validates a blob read back out of `localStorage` before any of it reaches the
 * app's signals.
 *
 * Not a security boundary — it is the player's own browser, holding their own
 * score, and the only thing that ever gets *published* (a leaderboard write) is
 * validated server-side by `firestore.rules` regardless of what this returns.
 * It is a robustness boundary: `localStorage` outlives deploys, so this will be
 * handed shapes written by older versions of the app, half-written values, and
 * whatever a curious player typed into devtools. Anything unrecognised is
 * discarded rather than trusted, because the alternative is an exception during
 * bootstrap, which white-screens the whole app rather than just losing a game.
 */
function parseSavedGame(raw: string, now: number): PersistedGame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed['version'] !== SCHEMA_VERSION) {
    return null;
  }

  const { savedAt, config, questions, currentIndex, score, isComplete } = parsed;

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
    config,
    questions,
    currentIndex,
    score,
    isComplete: isComplete === true,
  };
}

/**
 * Reads and writes the in-progress game to `localStorage`, so a game survives a
 * reload, a tab crash, or a PWA relaunch (finding B8). Kept separate from
 * `GameControllerService` so the storage format, its validation and its expiry
 * are testable without standing up the whole controller.
 *
 * `localStorage` rather than `sessionStorage`: the population this is for —
 * offline/PWA players on a phone — routinely lose the *tab*, not just the page,
 * and `sessionStorage` dies with it. Every access is wrapped, because storage
 * throws rather than degrades when it is full or disabled (Safari private mode
 * being the classic case), and losing the ability to save a game must never
 * take the game itself down with it.
 */
@Injectable({ providedIn: 'root' })
export class GamePersistenceService {
  load(): PersistedGame | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
    if (!raw) {
      return null;
    }

    const saved = parseSavedGame(raw, Date.now());
    if (!saved) {
      // Expired or unreadable — drop it so it can't be re-examined on every load.
      this.clear();
    }
    return saved;
  }

  save(game: Omit<PersistedGame, 'version' | 'savedAt'>): void {
    const payload: PersistedGame = {
      ...game,
      version: SCHEMA_VERSION,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Storage full or unavailable. The game carries on in memory; it just
      // won't survive a reload, which is exactly the pre-B8 behaviour.
    }
  }

  clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to do — see save().
    }
  }
}
