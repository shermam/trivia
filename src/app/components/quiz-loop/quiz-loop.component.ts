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
import { Answer, DEFAULT_TIME_LIMIT, LifelineId } from '../../models/question.model';
import { STREAK_INDICATOR_THRESHOLD, multiplierLabel } from '../../models/scoring';
import { AudioService } from '../../services/audio.service';
import { GameControllerService } from '../../services/game-controller.service';
import { TriviaService } from '../../services/trivia.service';
import { IconComponent } from '../icon/icon.component';
import { RenderedTextComponent } from '../rendered-text/rendered-text.component';

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
 * What Extra Time adds to *this question's* deadline (`FEAT-002`).
 *
 * It does not change `GameConfig.timeLimit`, does not carry into the next
 * question and does not move the run to another board — a 15s game with one
 * extended question still ranks on the 15s board, which is what respecting
 * finding G7's per-limit leaderboards means here.
 */
const EXTRA_TIME_SECONDS = 15;
/**
 * How many seconds of a timed question end with an audible tick (`FEAT-003`).
 *
 * The same five seconds the ring already turns red for, so the two cues say the
 * same thing in two channels rather than each inventing its own deadline. An
 * unlimited game has no deadline and therefore no tick at all — the countdown
 * that would drive it is never started.
 */
const TICK_WINDOW_SECONDS = 5;
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
  imports: [NgClass, IconComponent, RenderedTextComponent],
  templateUrl: './quiz-loop.component.html',
  styleUrl: './quiz-loop.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuizLoopComponent implements OnInit, OnDestroy {
  protected readonly gameController = inject(GameControllerService);
  private readonly audio = inject(AudioService);

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
   * How long the current question's countdown runs for, which is the chosen
   * limit **plus any Extra Time spent on it** — and therefore not the same as
   * `limitSeconds()`.
   *
   * The ring needs its own denominator because `timeLeft` can now exceed the
   * limit: dividing by `limitSeconds()` after an extension gives a ratio above
   * 1, a negative `stroke-dashoffset`, and a ring that draws itself inside out.
   */
  private readonly questionDuration = signal<number>(FALLBACK_DURATION_SECONDS);

  protected readonly lifelines = this.gameController.lifelines;

  /**
   * The streak badge (`FEAT-004`).
   *
   * **Rendered on every question and only made `invisible`**, never added and
   * removed, because it sits in the wrapping badge row beside the category and
   * difficulty pills: a pill that appeared on the third correct answer would
   * re-wrap that row and move the question text down the screen, mid-round,
   * while the clock runs (`CLAUDE.md` §4.4).
   *
   * Reserving the box is only half of it — the *contents* have to be a
   * constant width too, or the badge would jostle as the numbers changed. They
   * are, by construction rather than by a measured minimum: the streak sits in
   * a two-character `tabular-nums` slot (25 questions is the longest game the
   * setup screen offers) and the multiplier is always written to one decimal,
   * so `×1.0` and `×1.5` occupy the same space.
   */
  protected readonly showsStreak = computed(
    () => this.gameController.currentStreak() >= STREAK_INDICATOR_THRESHOLD,
  );

  protected readonly multiplierLabel = multiplierLabel;

  /**
   * Tier colour, and the one animation on this screen.
   *
   * The pulse is on the top tier alone: it is the "on fire" state the spec
   * asks to celebrate, it is rare, and scoping it there means no timer to
   * schedule and no teardown to forget (`CLAUDE.md` §4.4). `motion-safe:`
   * because a looping animation is exactly what a reader who asked for less
   * motion asked to be spared — enforced by `npm run motion:verify`, and only
   * enforced because nobody can see the omission without the OS setting on.
   */
  protected readonly streakClass = computed(() => {
    const base =
      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors';
    switch (this.gameController.scoreMultiplier()) {
      case 3:
        return `${base} bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300 motion-safe:animate-pulse`;
      case 2:
        return `${base} bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300`;
      case 1.5:
        return `${base} bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300`;
      default:
        return `${base} bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400`;
    }
  });

  /**
   * What a screen reader is told when the multiplier tier moves.
   *
   * **Tier changes only, not every correct answer.** The result region beside
   * this one already announces "Correct." on each one, and a second region
   * repeating the running count on top of it would make the useful part — that
   * answers are now worth more — harder to hear rather than easier.
   *
   * Carries the question's position for the reason the flag and lifeline
   * regions do: signals compare with `Object.is`, so reaching 1.5× twice in a
   * game would set identical text the second time, and a live region only
   * announces on mutation.
   */
  protected readonly streakAnnouncement = signal('');

  /**
   * Extra Time is **hidden** on an unlimited game and 50/50 is **disabled** on
   * a two-option question, and the asymmetry is deliberate.
   *
   * Whether the game is timed is fixed before the first question and cannot
   * change while this component is alive, so hiding the button costs no layout
   * shift — it is simply a two-button toolbar for that whole game. Whether a
   * question is true/false changes *per question*, so hiding 50/50 would resize
   * the toolbar mid-round, which is the thing `CLAUDE.md` §4.4 forbids. A
   * disabled button keeps its box.
   */
  protected readonly showsExtraTime = this.isTimed;

  protected readonly canUseFiftyFifty = computed(() => {
    const question = this.gameController.currentQuestion();
    if (!question) {
      return false;
    }
    // Mirrors `useFiftyFifty()`'s own rule — never reduce a question to a
    // single option — so the button's enabled state and what the service will
    // actually do cannot disagree.
    return question.all_answers.filter((answer) => !answer.isCorrect).length > 1;
  });

  protected readonly eliminatedAnswerIds = this.gameController.eliminatedAnswerIds;

  protected isEliminated(answer: Answer): boolean {
    return this.eliminatedAnswerIds().includes(answer.id);
  }

  /**
   * Announced when a lifeline is spent (G3). Carries the question's position
   * for the same reason `flagAnnouncement` does: a live region only announces
   * on mutation, so identical text set twice says nothing the second time.
   */
  protected readonly lifelineAnnouncement = signal('');

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
    if (this.limitSeconds() === null) {
      return 0;
    }
    // Against the question's own duration, not the game's limit — see
    // `questionDuration`. Clamped anyway, because a tick can land a few
    // milliseconds before the deadline moves.
    const duration = this.questionDuration();
    const fraction = duration <= 0 ? 0 : Math.min(1, this.timeLeft() / duration);
    return TIMER_RING_CIRCUMFERENCE - fraction * TIMER_RING_CIRCUMFERENCE;
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
   * The last whole second the countdown ticked *audibly* on, so the cue fires
   * at most once per second (`FEAT-003`).
   *
   * The interval runs four times a second and the tick rides it rather than a
   * timer of its own — a second `setInterval` would be a second thing to tear
   * down, and it would drift against the deadline this one derives from the
   * wall clock (`CLAUDE.md` §4.4). Reset per question by `startTimer()`, and
   * seeded with the question's own duration so the first reading of that second
   * is not itself a tick.
   */
  private lastTickedSecond = 0;

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
    // An eliminated option is `disabled` in the template, so this is the
    // belt to that braces — a click can still arrive programmatically, and
    // scoring a 50/50'd option would be the one bug this feature could
    // introduce into the score itself.
    if (this.isAnswered() || this.isEliminated(answer)) {
      return;
    }
    this.stopTimer();
    this.commitAnswer(answer);
  }

  protected useFiftyFifty(): void {
    if (!this.canUseLifeline('fiftyFifty')) {
      return;
    }
    if (!this.gameController.useFiftyFifty()) {
      return;
    }
    // After the consume, never before it: the cue reports that the lifeline was
    // spent, and a sound on a press that did nothing would be a false report.
    this.audio.playLifeline();
    const remaining = this.gameController
      .currentQuestion()
      ?.all_answers.filter((answer) => !this.isEliminated(answer)).length;
    this.announce(`Fifty-fifty used. ${remaining} options remain.`);
  }

  protected useExtraTime(): void {
    // `isTimed()` as well as the availability flag: on an unlimited game there
    // is no deadline to move, and spending the lifeline to do nothing would be
    // the worst outcome of the three. The button is not rendered there either.
    if (!this.canUseLifeline('extraTime') || !this.isTimed()) {
      return;
    }
    if (!this.gameController.consumeLifeline('extraTime')) {
      return;
    }
    this.audio.playLifeline();
    this.deadline += EXTRA_TIME_SECONDS * 1000;
    this.questionDuration.update((seconds) => seconds + EXTRA_TIME_SECONDS);
    // Repaint the countdown now rather than up to a tick later, so the number
    // jumps the instant the button is pressed.
    this.tickTimer();
    this.announce(`Extra time added. ${EXTRA_TIME_SECONDS} seconds more on this question.`);
  }

  protected useSkip(): void {
    if (!this.canUseLifeline('skip')) {
      return;
    }
    if (!this.gameController.consumeLifeline('skip')) {
      return;
    }
    // The lifeline cue and *only* the lifeline cue: a skip ends the question
    // without an outcome, so neither answer cue applies to it.
    this.audio.playLifeline();
    this.stopTimer();
    // No result banner and no `ANSWER_DELAY_MS` pause: there is no result to
    // read. The whole point of Skip is not to sit here.
    this.gameController.registerSkippedQuestion();
    this.goToNextQuestion();
  }

  /** A lifeline is spendable only while the question is still live. */
  protected canUseLifeline(id: LifelineId): boolean {
    if (this.isAnswered() || !this.gameController.currentQuestion()) {
      return false;
    }
    if (!this.lifelines()[id]) {
      return false;
    }
    return id === 'fiftyFifty' ? this.canUseFiftyFifty() : true;
  }

  /** One box either way, so spending a lifeline cannot resize the row (§4.4). */
  protected lifelineClass(available: boolean): string {
    const base =
      'flex flex-1 items-center justify-center gap-1.5 rounded-xl border-[1.5px] px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed';
    return available
      ? `${base} border-slate-900/15 dark:border-white/15 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 hover:border-emerald-600 hover:bg-slate-50 dark:hover:bg-slate-700`
      : `${base} border-slate-900/8 dark:border-white/10 bg-slate-50 dark:bg-slate-800/40 text-slate-400 dark:text-slate-600`;
  }

  private announce(message: string): void {
    this.lifelineAnnouncement.set(`Question ${this.gameController.currentIndex() + 1}: ${message}`);
  }

  protected answerClass(answer: Answer): string {
    const question = this.gameController.currentQuestion();
    // Removed by 50/50: muted and non-interactive, but still occupying its
    // cell. Collapsing the grid to two options would reflow the answers under
    // the player's cursor at the moment they are reading them (§4.4).
    if (this.isEliminated(answer)) {
      return 'bg-slate-50 dark:bg-slate-800/40 border-slate-900/8 dark:border-white/10 text-slate-400 dark:text-slate-600 opacity-50 line-through';
    }
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
    if (this.isEliminated(answer)) {
      return 'bg-slate-100 dark:bg-slate-800 text-slate-300 dark:text-slate-600';
    }
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
    this.questionDuration.set(limit);
    this.lastTickedSecond = limit;
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
    const secondsLeft = Math.max(0, Math.ceil(remainingMs / 1000));
    this.timeLeft.set(secondsLeft);
    this.playCountdownTick(secondsLeft);
    if (remainingMs <= 0) {
      this.stopTimer();
      this.commitAnswer(null);
    }
  }

  /**
   * At most one tick per remaining second, and only inside the last few.
   *
   * Driven by the *second the clock reads* rather than by how often the
   * interval fired, which is what makes it right in the two cases that would
   * otherwise double- or under-count: the interval runs four times a second,
   * and a tab returning from the background re-reads the clock and finds
   * several seconds gone at once (one tick, not six). Zero is deliberately
   * excluded — the question resolving plays its own cue, and two sounds on the
   * same instant is a clash rather than emphasis.
   */
  private playCountdownTick(secondsLeft: number): void {
    if (secondsLeft === this.lastTickedSecond) {
      return;
    }
    this.lastTickedSecond = secondsLeft;
    if (secondsLeft > 0 && secondsLeft <= TICK_WINDOW_SECONDS && !this.isAnswered()) {
      this.audio.playTimerTick();
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
    // A timeout and a wrong answer get the same cue, because they are the same
    // event to the player: the question is over and it scored nothing. Skip
    // gets none at all — `useSkip()` never reaches here, and a sound on a
    // question the player chose to leave would be the app reacting to a
    // decision rather than to an outcome.
    if (answer?.isCorrect === true) {
      this.audio.playCorrect();
    } else {
      this.audio.playIncorrect();
    }
    // Read before the answer is registered, so the comparison below is against
    // the tier this question was played under rather than the one it produced.
    const multiplierBefore = this.gameController.scoreMultiplier();
    // The whole answer, not `answer?.isCorrect`: only this call site knows
    // *which* option was picked, and a timeout (`null`) is not the same thing
    // as a wrong answer. The recap needs both.
    this.gameController.registerAnswer(answer);
    this.announceStreakChange(multiplierBefore);

    this.advanceTimeoutHandle = setTimeout(() => this.goToNextQuestion(), ANSWER_DELAY_MS);
  }

  private announceStreakChange(multiplierBefore: number): void {
    const multiplier = this.gameController.scoreMultiplier();
    if (multiplier === multiplierBefore) {
      return;
    }
    const position = this.gameController.currentIndex() + 1;
    this.streakAnnouncement.set(
      multiplier > multiplierBefore
        ? `Question ${position}: streak of ${this.gameController.currentStreak()}. ` +
            `Answers are now worth ${multiplierLabel(multiplier)} times their points.`
        : `Question ${position}: streak lost. ` +
            `Answers are back to ${multiplierLabel(multiplier)} times their points.`,
    );
  }

  private goToNextQuestion(): void {
    const wasLastQuestion = this.gameController.isLastQuestion();
    this.gameController.advanceQuestion();

    if (wasLastQuestion) {
      return;
    }

    this.isAnswered.set(false);
    this.selectedAnswer.set(null);
    this.lifelineAnnouncement.set('');
    this.streakAnnouncement.set('');
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
