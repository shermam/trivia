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
  readonly percentage = computed(() =>
    this.totalQuestions() === 0 ? 0 : Math.round((this.score() / this.totalQuestions()) * 100),
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
      this.router.navigateByUrl('/game-over');
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
    this.router.navigateByUrl('/');
  }
}
