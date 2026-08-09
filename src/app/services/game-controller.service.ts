import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { GameConfig, TriviaQuestion } from '../models/question.model';
import { TriviaService } from './trivia.service';

/** Holds all in-progress game state so it survives navigation between the setup, quiz, and game-over screens. */
@Injectable({ providedIn: 'root' })
export class GameControllerService {
  private readonly triviaService = inject(TriviaService);
  private readonly router = inject(Router);

  readonly config = signal<GameConfig | null>(null);
  readonly questions = signal<TriviaQuestion[]>([]);
  readonly currentIndex = signal(0);
  readonly score = signal(0);
  readonly isLoading = signal(false);
  readonly loadError = signal<string | null>(null);

  readonly totalQuestions = computed(() => this.questions().length);
  readonly currentQuestion = computed<TriviaQuestion | null>(
    () => this.questions()[this.currentIndex()] ?? null,
  );
  readonly isLastQuestion = computed(() => this.currentIndex() >= this.totalQuestions() - 1);
  /** Accuracy: how many were answered correctly. Shown on the game-over screen. */
  readonly percentage = computed(() =>
    this.totalQuestions() === 0 ? 0 : Math.round((this.score() / this.totalQuestions()) * 100),
  );

  /**
   * How far through the quiz the player is — *position*, not accuracy. Drives
   * the bar under the quiz header, and deliberately agrees with the "Question
   * N / M" label beside it: on question 1 of 10 both say 1 of 10, and on the
   * last question the bar is full.
   *
   * `currentIndex` is zero-based, so it counts the questions *behind* you. The
   * bar used it directly and was a question out at every step: 0% while
   * looking at the first question, and 90% on the last of ten — it could never
   * fill, because `advanceQuestion()` navigates away instead of incrementing
   * past the end.
   */
  readonly progressPercentage = computed(() =>
    this.totalQuestions() === 0
      ? 0
      : Math.round(((this.currentIndex() + 1) / this.totalQuestions()) * 100),
  );

  async startGame(config: GameConfig): Promise<void> {
    this.isLoading.set(true);
    this.loadError.set(null);

    try {
      const questions = await this.triviaService.getQuestions(config);

      if (questions.length === 0) {
        this.loadError.set(
          'No questions were found for the selected options. Try a different category, difficulty, or source.',
        );
        return;
      }

      this.config.set(config);
      this.questions.set(questions);
      this.currentIndex.set(0);
      this.score.set(0);
      await this.router.navigateByUrl('/play');
    } catch {
      this.loadError.set('Failed to load questions. Please check your connection and try again.');
    } finally {
      this.isLoading.set(false);
    }
  }

  registerAnswer(isCorrect: boolean): void {
    if (isCorrect) {
      this.score.update((value) => value + 1);
    }
  }

  advanceQuestion(): void {
    if (this.isLastQuestion()) {
      void this.router.navigateByUrl('/game-over');
      return;
    }
    this.currentIndex.update((value) => value + 1);
  }

  resetGame(): void {
    this.config.set(null);
    this.questions.set([]);
    this.currentIndex.set(0);
    this.score.set(0);
    this.loadError.set(null);
    void this.router.navigateByUrl('/');
  }
}
