import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { Router } from '@angular/router';
import { Answer } from '../../models/question.model';
import { GameControllerService } from '../../services/game-controller.service';

const QUESTION_DURATION_SECONDS = 15;
const ANSWER_DELAY_MS = 2000;
/**
 * Option labels are derived from the index rather than read out of a fixed
 * array. The array had four entries while `firestore.rules` permitted up to
 * six answers, so a five-answer question rendered a blank badge — finding B2.
 * Deriving makes the mismatch impossible rather than merely fixed: the rules
 * are tightened to what the form can produce in the same change, and this
 * still holds if that ever moves again, or for a legacy document written
 * under the older bound.
 */
function answerLabel(index: number): string {
  return String.fromCharCode(65 + index);
}
const TIMER_RING_RADIUS = 18;
const TIMER_RING_CIRCUMFERENCE = 2 * Math.PI * TIMER_RING_RADIUS;

@Component({
  selector: 'app-quiz-loop',
  standalone: true,
  imports: [NgClass],
  templateUrl: './quiz-loop.component.html',
  styleUrl: './quiz-loop.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuizLoopComponent implements OnInit, OnDestroy {
  protected readonly gameController = inject(GameControllerService);
  private readonly router = inject(Router);

  protected readonly answerLabel = answerLabel;
  protected readonly timerRingRadius = TIMER_RING_RADIUS;
  protected readonly timerRingCircumference = TIMER_RING_CIRCUMFERENCE;

  protected readonly timeLeft = signal(QUESTION_DURATION_SECONDS);
  protected readonly selectedAnswer = signal<Answer | null>(null);
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
      void this.router.navigateByUrl('/');
      return;
    }
    this.startTimer();
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }

  protected selectAnswer(answer: Answer): void {
    if (this.isAnswered()) {
      return;
    }
    this.stopTimer();
    this.commitAnswer(answer);
  }

  protected answerClass(answer: Answer): string {
    const question = this.gameController.currentQuestion();
    if (!this.isAnswered() || !question) {
      return 'bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 hover:border-emerald-600 hover:shadow-[0_0_0_3px_rgba(5,150,105,0.08)] border-slate-900/15 dark:border-white/15 text-slate-900 dark:text-slate-50';
    }

    const isCorrectAnswer = answer.isCorrect;
    const isSelected = answer.id === this.selectedAnswer()?.id;

    if (isCorrectAnswer) {
      return 'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-700 dark:border-emerald-400 text-emerald-900 dark:text-emerald-200';
    }
    if (isSelected) {
      return 'bg-red-50 dark:bg-red-500/15 border-red-700 dark:border-red-400 text-red-900 dark:text-red-200';
    }
    return 'bg-white dark:bg-slate-800 border-slate-900/8 dark:border-white/10 text-slate-400 dark:text-slate-500 opacity-60';
  }

  protected answerBadgeClass(answer: Answer): string {
    const question = this.gameController.currentQuestion();
    if (!this.isAnswered() || !question) {
      return 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300';
    }

    const isCorrectAnswer = answer.isCorrect;
    const isSelected = answer.id === this.selectedAnswer()?.id;

    if (isCorrectAnswer) {
      return 'bg-emerald-700 text-white';
    }
    if (isSelected) {
      return 'bg-red-700 text-white';
    }
    return 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300';
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

  private commitAnswer(answer: Answer | null): void {
    const question = this.gameController.currentQuestion();
    if (!question) {
      return;
    }

    this.selectedAnswer.set(answer);
    this.isAnswered.set(true);
    this.gameController.registerAnswer(answer?.isCorrect === true);

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
