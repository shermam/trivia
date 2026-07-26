import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { GameControllerService } from '../../services/game-controller.service';

const QUESTION_DURATION_SECONDS = 15;
const ANSWER_DELAY_MS = 2000;

@Component({
  selector: 'app-quiz-loop',
  standalone: true,
  imports: [],
  templateUrl: './quiz-loop.component.html',
  styleUrl: './quiz-loop.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuizLoopComponent implements OnInit, OnDestroy {
  protected readonly gameController = inject(GameControllerService);
  private readonly router = inject(Router);

  protected readonly timeLeft = signal(QUESTION_DURATION_SECONDS);
  protected readonly selectedAnswer = signal<string | null>(null);
  protected readonly isAnswered = signal(false);

  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private advanceTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    if (!this.gameController.currentQuestion()) {
      this.router.navigateByUrl('/');
      return;
    }
    this.startTimer();
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }

  protected selectAnswer(answer: string): void {
    if (this.isAnswered()) {
      return;
    }
    this.stopTimer();
    this.commitAnswer(answer);
  }

  protected answerClass(answer: string): string {
    const question = this.gameController.currentQuestion();
    if (!this.isAnswered() || !question) {
      return 'bg-white hover:bg-indigo-50 border-slate-300 text-slate-800';
    }

    const isCorrectAnswer = answer === question.correct_answer;
    const isSelected = answer === this.selectedAnswer();

    if (isCorrectAnswer) {
      return 'bg-green-100 border-green-500 text-green-800';
    }
    if (isSelected) {
      return 'bg-red-100 border-red-500 text-red-800';
    }
    return 'bg-white border-slate-300 text-slate-400 opacity-60';
  }

  private startTimer(): void {
    this.timeLeft.set(QUESTION_DURATION_SECONDS);
    this.timerHandle = setInterval(() => {
      const next = Math.max(0, this.timeLeft() - 1);
      this.timeLeft.set(next);
      if (next <= 0) {
        this.stopTimer();
        this.commitAnswer(null);
      }
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private commitAnswer(answer: string | null): void {
    const question = this.gameController.currentQuestion();
    if (!question) {
      return;
    }

    this.selectedAnswer.set(answer);
    this.isAnswered.set(true);
    this.gameController.registerAnswer(answer === question.correct_answer);

    this.advanceTimeoutHandle = setTimeout(() => this.goToNextQuestion(), ANSWER_DELAY_MS);
  }

  private goToNextQuestion(): void {
    const wasLastQuestion = this.gameController.isLastQuestion();
    this.gameController.advanceQuestion();

    if (wasLastQuestion) {
      return;
    }

    this.isAnswered.set(false);
    this.selectedAnswer.set(null);
    this.startTimer();
  }

  private clearTimers(): void {
    this.stopTimer();
    if (this.advanceTimeoutHandle !== null) {
      clearTimeout(this.advanceTimeoutHandle);
      this.advanceTimeoutHandle = null;
    }
  }
}
