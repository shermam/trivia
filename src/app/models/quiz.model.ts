import type { TimeLimitOption } from './question.model';

/**
 * A curated quiz (`FEAT-024`): a named, ordered set of community questions,
 * played as a unit through the same loop as a random game.
 *
 * Stored at `quizzes/{id}`, and **written by nobody through the app**:
 * `firestore.rules` refuses every client write, so a quiz is created from the
 * Firebase console or by `scripts/seed-quiz.mjs` on the Admin SDK. That is why
 * there is no exact-key allowlist to widen later and why the four fields marked
 * for other features below are optional rather than required on day one — a
 * collection with no client write path has no key set to freeze
 * (`docs/data-model.md`).
 *
 * The fields match `FEAT-024` §2's table. `id` is the document id, which is
 * also the `/quiz/:quizId` URL segment, so a quiz's address is chosen by
 * whoever writes it rather than minted.
 */
export interface Quiz {
  id: string;
  /** What the quiz is called. 1–80 characters. */
  title: string;
  /** What it is about, in a sentence or two. 0–300 characters; empty means none. */
  description: string;
  /**
   * The `custom_questions` ids it plays, **in order**. 1–25 of them, distinct.
   *
   * Ids rather than copies, so a quiz can rot without anybody touching it: a
   * question deleted, withdrawn by its author or no longer approved is simply
   * not found by the play-time read, and the quiz plays what remains (`FEAT-024`,
   * administrator decision of 8 October 2026). Only community questions can be
   * named — an Open Trivia DB question's id is minted per fetch and resolves to
   * nothing afterwards.
   */
  questionIds: string[];
  /** Who curated it — written by the console or the script, never by a client. */
  createdBy: string;
  /** Epoch ms, stamped by whoever wrote it rather than taken from the definition. */
  createdAt: number;
  /** Whether it is playable and listed. It is the whole of the read rule. */
  isPublished: boolean;
  /** Normalised topic tags, for browsing quizzes by topic (`FEAT-021`). */
  tags?: string[];
  /** A BCP-47 language tag (`FEAT-030`). */
  language?: string;
  /** A sponsor reference (`FEAT-035`, parked). */
  sponsorId?: string | null;
  /**
   * The time limit the curator recommends (`FEAT-018`).
   *
   * **Suggested, never imposed.** It pre-selects the quiz page's picker and the
   * player can always change it, `'unlimited'` included — a countdown a player
   * cannot turn off is the WCAG 2.2.1 failure audit G7 fixed (`CLAUDE.md` §4.5).
   */
  suggestedTimeLimit?: TimeLimitOption | null;
}

/**
 * What a game in progress remembers about the quiz it is playing, persisted
 * with the snapshot so a reload mid-quiz is still a quiz.
 *
 * The id and the title and nothing else: the questions are already in the
 * snapshot, and everything a screen does differently for a quiz game — no
 * leaderboard entry on `/game-over` — keys on this being present.
 */
export interface QuizContext {
  id: string;
  title: string;
}

/** Where quizzes live. */
export const QUIZZES_COLLECTION = 'quizzes';

/**
 * The bounds a quiz is written within. The seed script validates against them
 * (`utils/quiz-definition.util.ts`) and is the only validator a quiz has,
 * because there is no client write rule for `firestore.rules` to enforce them
 * in.
 */
export const QUIZ_TITLE_MAX_LENGTH = 80;
export const QUIZ_DESCRIPTION_MAX_LENGTH = 300;
export const QUIZ_MIN_QUESTIONS = 1;
/**
 * The longest game the setup screen offers, and the most ids the app resolves
 * for one quiz — one `IN` query's worth, so a quiz's questions are always a
 * bounded read (`CLAUDE.md` §4.1).
 */
export const QUIZ_MAX_QUESTIONS = 25;
export const QUIZ_MAX_TAGS = 8;
