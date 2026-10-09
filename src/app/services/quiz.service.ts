import { Injectable, inject } from '@angular/core';
import { TriviaQuestion } from '../models/question.model';
import { Quiz } from '../models/quiz.model';
import { isQuizDocumentId, readQuiz } from '../utils/quiz-definition.util';
import { FirebaseService } from './firebase.service';
import { TriviaService } from './trivia.service';

/**
 * What loading one quiz found (`FEAT-024`).
 *
 * - `ready` — a published quiz with at least one question that can be played.
 *   `unavailable` counts the ones that cannot, which the quiz page states
 *   before Start rather than letting a ten-question quiz quietly play eight.
 * - `empty` — a published quiz none of whose questions can be played right
 *   now, which says so instead of starting.
 * - `notFound` — nothing playable under that address: no such quiz, an
 *   unpublished one, an address that cannot name a document, or a document
 *   with no title to show. One state, because every one of those reads the
 *   same to a player and telling them apart would tell a stranger which drafts
 *   exist.
 *
 * A failure to read is none of these: `load` throws it, so the page can offer
 * a retry rather than claim the quiz is gone (`CLAUDE.md` §4.4).
 */
export type QuizLoad =
  | { kind: 'ready'; quiz: Quiz; questions: TriviaQuestion[]; unavailable: number }
  | { kind: 'empty'; quiz: Quiz }
  | { kind: 'notFound' };

/**
 * Curated quizzes as the app reads them (`FEAT-024`): the list on `/`, and one
 * quiz with its questions resolved for `/quiz/:quizId`.
 *
 * **Reads only, and there is no write path for it to grow.** `quizzes` refuses
 * every client write (`firestore.rules`); a quiz is written by the console or by
 * `scripts/seed-quiz.mjs`. What this service adds over `FirebaseService` is the
 * reading of what came back — `readQuiz` re-checks every stored field, because
 * the console can write anything and a quiz typed there never met the
 * script's validator.
 *
 * **Bounded reads, all of them on arrival**: the quiz document by its id, then
 * its questions (`TriviaService.getQuizQuestions`) — one query when every
 * question can be read, and one `get` per question when one cannot, since a
 * single unreadable name refuses that query whole
 * (`FirebaseService.getApprovedQuestionsByIds`). A quiz of up to twenty-five
 * questions therefore costs one get, one query and at most twenty-five more
 * gets; Start spends nothing, because it plays the questions this already
 * holds.
 */
@Injectable({ providedIn: 'root' })
export class QuizService {
  private readonly firebaseService = inject(FirebaseService);
  private readonly triviaService = inject(TriviaService);

  /**
   * The newest published quizzes, as many as `QUIZ_LIST_LIMIT` allows, with
   * any the app cannot use left out — a document with no title, an unpublished
   * one, and one naming no question at all, which would be a link to a quiz
   * that can never start.
   */
  async listPublished(): Promise<Quiz[]> {
    const documents = await this.firebaseService.getPublishedQuizzes();
    return documents
      .map((document) => readQuiz(document.id, document.data))
      .filter(
        (quiz): quiz is Quiz => quiz !== null && quiz.isPublished && quiz.questionIds.length > 0,
      );
  }

  /**
   * One quiz and the questions it can play right now, in its own order.
   *
   * An address that cannot name a document is `notFound` without a read: it
   * reaches here straight from the URL, and a `/` in it would otherwise become
   * a path the REST client refuses with an exception rather than a 404.
   */
  async load(quizId: string): Promise<QuizLoad> {
    if (!isQuizDocumentId(quizId)) {
      return { kind: 'notFound' };
    }
    const document = await this.firebaseService.getQuiz(quizId);
    const quiz = document ? readQuiz(document.id, document.data) : null;
    if (!quiz || !quiz.isPublished) {
      return { kind: 'notFound' };
    }

    const questions = await this.triviaService.getQuizQuestions(quiz.questionIds);
    if (questions.length === 0) {
      return { kind: 'empty', quiz };
    }
    return {
      kind: 'ready',
      quiz,
      questions,
      unavailable: quiz.questionIds.length - questions.length,
    };
  }
}
