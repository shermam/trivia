import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { GameControllerService } from '../../services/game-controller.service';

const QUESTION_DURATION_SECONDS = 15;
const ANSWER_DELAY_MS = 2000;
const ANSWER_LABELS = ['A', 'B', 'C', 'D'];
const TIMER_RING_RADIUS = 18;
const TIMER_RING_CIRCUMFERENCE = 2 * Math.PI * TIMER_RING_RADIUS;

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

  protected readonly answerLabels = ANSWER_LABELS;
  protected readonly timerRingRadius = TIMER_RING_RADIUS;
  protected readonly timerRingCircumference = TIMER_RING_CIRCUMFERENCE;

  protected readonly timeLeft = signal(QUESTION_DURATION_SECONDS);
  protected readonly selectedAnswer = signal<string | null>(null);
  protected readonly isAnswered = signal(false);

  protected readonly timerRingOffset = computed(
    () =>
      TIMER_RING_CIRCUMFERENCE -
      (this.timeLeft() / QUESTION_DURATION_SECONDS) * TIMER_RING_CIRCUMFERENCE,
  );

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
      return 'bg-white hover:bg-zinc-50 hover:border-zinc-900 hover:shadow-[0_0_0_3px_rgba(0,0,0,0.08)] border-zinc-900/15 text-zinc-900';
    }

    const isCorrectAnswer = answer === question.correct_answer;
    const isSelected = answer === this.selectedAnswer();

    if (isCorrectAnswer) {
      return 'bg-green-50 border-green-700 text-green-900';
    }
    if (isSelected) {
      return 'bg-red-50 border-red-700 text-red-900';
    }
    return 'bg-white border-zinc-900/8 text-zinc-400 opacity-60';
  }

  protected answerBadgeClass(answer: string): string {
    const question = this.gameController.currentQuestion();
    if (!this.isAnswered() || !question) {
      return 'bg-zinc-100 text-zinc-600';
    }

    const isCorrectAnswer = answer === question.correct_answer;
    const isSelected = answer === this.selectedAnswer();

    if (isCorrectAnswer) {
      return 'bg-green-700 text-white';
    }
    if (isSelected) {
      return 'bg-red-700 text-white';
    }
    return 'bg-zinc-100 text-zinc-600';
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
