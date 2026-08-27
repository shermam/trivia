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
import { Answer, DEFAULT_TIME_LIMIT } from '../../models/question.model';
import { GameControllerService } from '../../services/game-controller.service';
import { TriviaService } from '../../services/trivia.service';
import { IconComponent } from '../icon/icon.component';

/**
 * Fallback for a game whose config predates the adjustable timer (finding
 * G7) — a save written before the picker existed was played at 15 seconds.
 * The live value comes from `GameConfig.timeLimit`.
 */
const FALLBACK_DURATION_SECONDS: number =
  DEFAULT_TIME_LIMIT === 'unlimited' ? 15 : DEFAULT_TIME_LIMIT;
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

  /**
   * The chosen limit in seconds, or `null` for an unlimited game — in which
   * case no countdown runs at all: no interval, no ring, and no auto-answer
   * when the player takes their time. That last part is the point of WCAG
   * 2.2.1, and it is why this is a `null` rather than a very large number:
   * a big number is still a deadline, just a less obvious one.
   */
  protected readonly limitSeconds = computed<number | null>(() => {
    const chosen = this.gameController.config()?.timeLimit ?? FALLBACK_DURATION_SECONDS;
    return chosen === 'unlimited' ? null : chosen;
  });

  protected readonly isTimed = computed(() => this.limitSeconds() !== null);

  protected readonly timeLeft = signal<number>(FALLBACK_DURATION_SECONDS);
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
  /**
   * Which of the three result banners applies, as one value rather than a
   * chain of conditions repeated per branch.
   *
   * The template needs this three times over — the banners are stacked so the
   * reserved space is the tallest of them — and re-deriving `selectedAnswer()
   * === null` in each would be three chances to get one wrong.
   */
  protected readonly resultKind = computed<'none' | 'correct' | 'timeout' | 'incorrect'>(() => {
    if (!this.isAnswered() || !this.gameController.currentQuestion()) {
      return 'none';
    }
    const selected = this.selectedAnswer();
    if (selected?.isCorrect) {
      return 'correct';
    }
    // Distinct from a wrong answer: `null` means the timer ran out with
    // nothing chosen, which is a different sentence and a different icon.
    return selected === null ? 'timeout' : 'incorrect';
  });

  /**
   * What a screen reader hears, which is deliberately *not* what the banner
   * says any more.
   *
   * The visible banner used to name the correct answer, and that is what made
   * its height depend on the question: a long answer wrapped to a second line.
   * Sighted users do not need it spelled out — the correct option is already
   * the only one with an emerald border while every other option is dimmed to
   * 60% — but that highlight is a purely visual cue, so the announcement keeps
   * the answer in words.
   */
  protected readonly resultAnnouncement = computed(() => {
    const question = this.gameController.currentQuestion();
    if (!question) {
      return '';
    }
    switch (this.resultKind()) {
      case 'correct':
        return 'Correct.';
      case 'timeout':
        return `Time's up. The correct answer was ${question.correct_answer}.`;
      case 'incorrect':
        return `Incorrect. The correct answer is ${question.correct_answer}.`;
      default:
        return '';
    }
  });

  protected readonly timerRingOffset = computed(() => {
    const limit = this.limitSeconds();
    if (limit === null) {
      return 0;
    }
    return TIMER_RING_CIRCUMFERENCE - (this.timeLeft() / limit) * TIMER_RING_CIRCUMFERENCE;
  });

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
    const limit = this.limitSeconds();
    if (limit === null) {
      // No deadline, so nothing to schedule. Returning before creating the
      // interval is what makes "unlimited" actually unlimited rather than
      // merely long, and it also means a backgrounded tab has no timer to
      // throttle.
      return;
    }
    this.deadline = Date.now() + limit * 1000;
    this.timeLeft.set(limit);
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
    // The whole answer, not `answer?.isCorrect`: only this call site knows
    // *which* option was picked, and a timeout (`null`) is not the same thing
    // as a wrong answer. The recap needs both.
    this.gameController.registerAnswer(answer);

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
