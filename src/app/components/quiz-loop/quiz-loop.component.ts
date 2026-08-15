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
import { Answer } from '../../models/question.model';
import { GameControllerService } from '../../services/game-controller.service';
import { TriviaService } from '../../services/trivia.service';
import { IconComponent } from '../icon/icon.component';

const QUESTION_DURATION_SECONDS = 15;
const QUESTION_DURATION_MS = QUESTION_DURATION_SECONDS * 1000;
/**
 * The countdown ticks several times a second rather than once, so expiry is
 * caught promptly (within a tick of the true deadline) instead of up to a full
 * second late. It's cheap because each tick only reads the clock and sets a
 * signal — the displayed value still changes at most once a second.
 */
const TIMER_TICK_MS = 250;
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
  imports: [NgClass, IconComponent],
  templateUrl: './quiz-loop.component.html',
  styleUrl: './quiz-loop.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuizLoopComponent implements OnInit, OnDestroy {
  protected readonly gameController = inject(GameControllerService);

  /**
   * True when this game's questions came from the offline pool instead of the
   * network (`TriviaService.getQuestions()` fell back after the fetch threw).
   * Surfaced as a banner so the player knows they're on cached questions —
   * previously this signal was set but never read anywhere in the UI (B5).
   * It's set once at game start and doesn't change mid-game, so a plain banner
   * is right; there's no live status change to announce.
   */
  protected readonly playingOffline = inject(TriviaService).playingOffline;

  protected readonly answerLabel = answerLabel;
  protected readonly timerRingRadius = TIMER_RING_RADIUS;
  protected readonly timerRingCircumference = TIMER_RING_CIRCUMFERENCE;

  protected readonly timeLeft = signal(QUESTION_DURATION_SECONDS);
  protected readonly selectedAnswer = signal<Answer | null>(null);
  protected readonly isAnswered = signal(false);

  /**
   * What a screen reader is told the moment a question is answered (G3).
   *
   * The coloured banner below the options conveys the result visually and was
   * announced to nobody: it appears without focus moving, and the quiz
   * auto-advances two seconds later, so a screen reader user got the next
   * question with no idea whether the last one was right.
   *
   * The text is duplicated rather than shared with the banner because the two
   * have different jobs — the banner is glanceable ("Correct! Well done."),
   * this has to stand alone without the colour or the icon that give the visual
   * version half its meaning.
   */
  protected readonly resultAnnouncement = computed(() => {
    if (!this.isAnswered()) {
      return '';
    }
    const question = this.gameController.currentQuestion();
    if (!question) {
      return '';
    }
    const selected = this.selectedAnswer();
    if (selected?.isCorrect) {
      return 'Correct.';
    }
    if (selected === null) {
      return `Time's up. The correct answer was ${question.correct_answer}.`;
    }
    return `Incorrect. The correct answer is ${question.correct_answer}.`;
  });

  protected readonly timerRingOffset = computed(
    () =>
      TIMER_RING_CIRCUMFERENCE -
      (this.timeLeft() / QUESTION_DURATION_SECONDS) * TIMER_RING_CIRCUMFERENCE,
  );

  /**
   * Whether the question on screen is flagged, and what to announce about it.
   *
   * Flagging is deliberately the cheapest interaction this screen has — one
   * click, no dialog, nothing to confirm — because a countdown is running and
   * anything heavier would make reporting compete with answering. The detail
   * (why it's wrong) is asked for on `/game-over`, where there is no clock.
   */
  protected isFlagged(questionId: string): boolean {
    return this.gameController.flaggedQuestionIds().has(questionId);
  }

  protected readonly flagNotice = computed(() => {
    const question = this.gameController.currentQuestion();
    return question !== null && this.gameController.flaggedQuestionIds().has(question.id);
  });

  /**
   * Announced text for the live region. Includes the question's position so
   * flagging a second question announces something *different* from the
   * first: identical text set twice is a no-op for a signal, and a live
   * region only announces on mutation — the bug the H4 review found on the
   * game-over screen, in the same shape.
   */
  protected readonly flagAnnouncement = computed(() => {
    const question = this.gameController.currentQuestion();
    if (!question) {
      return '';
    }
    const position = this.gameController.currentIndex() + 1;
    return this.gameController.flaggedQuestionIds().has(question.id)
      ? `Question ${position} flagged. You'll be asked for details at the end of the game.`
      : '';
  });

  protected toggleFlag(questionId: string): void {
    this.gameController.toggleQuestionFlag(questionId);
  }

  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private advanceTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock instant (ms since epoch) the current question's countdown expires. */
  private deadline = 0;

  /**
   * A hidden tab has its `setInterval` throttled to as little as one tick a
   * minute, so a tick-counting countdown effectively pauses while backgrounded
   * — the deadline it's meant to enforce silently stops advancing. Because the
   * timer reads the wall clock instead, the next tick after the tab wakes
   * recovers the true elapsed time on its own; re-syncing the moment we become
   * visible again just makes that recovery immediate rather than waiting on the
   * throttled interval to fire. Guarded on `timerHandle` so it's inert between
   * questions (during the result delay) when no countdown is running.
   */
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible' && this.timerHandle !== null) {
      this.tickTimer();
    }
  };

  ngOnInit(): void {
    // Reaching here means hasActiveGameGuard passed — a question is in memory
    // (finding F4; the no-game redirect lives on the route, not here).
    document.addEventListener('visibilitychange', this.onVisibilityChange);
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
    this.deadline = Date.now() + QUESTION_DURATION_MS;
    this.timeLeft.set(QUESTION_DURATION_SECONDS);
    this.timerHandle = setInterval(() => this.tickTimer(), TIMER_TICK_MS);
  }

  /**
   * Derives the seconds remaining from the wall clock rather than by decrementing
   * a counter each tick. An accumulated count drifts against real time, and — the
   * reason this is finding B10 — a backgrounded tab throttles the interval, so a
   * counted-down timer stalls exactly when the deadline should still be running.
   */
  private tickTimer(): void {
    const remainingMs = this.deadline - Date.now();
    this.timeLeft.set(Math.max(0, Math.ceil(remainingMs / 1000)));
    if (remainingMs <= 0) {
      this.stopTimer();
      this.commitAnswer(null);
    }
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
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }
}
