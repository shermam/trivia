import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  ALL_LIFELINES_AVAILABLE,
  Answer,
  GameConfig,
  LifelineState,
  SKIPPED,
  TimeLimitOption,
  TriviaQuestion,
} from '../../models/question.model';
import { multiplierForStreak } from '../../models/scoring';
import { AudioService } from '../../services/audio.service';
import { GameControllerService } from '../../services/game-controller.service';
import { TriviaService } from '../../services/trivia.service';
import { QuizLoopComponent } from './quiz-loop.component';

function makeQuestion(overrides: Partial<TriviaQuestion> = {}): TriviaQuestion {
  const all_answers: Answer[] = [
    { id: 'q1:correct', text: 'Paris', isCorrect: true },
    { id: 'q1:incorrect-0', text: 'London', isCorrect: false },
  ];
  return {
    id: 'q1',
    category: 'Geography',
    type: 'multiple',
    difficulty: 'easy',
    question: 'Capital of France?',
    correct_answer: 'Paris',
    incorrect_answers: ['London'],
    all_answers,
    source: 'open_trivia',
    ...overrides,
  };
}

function setup(
  options: {
    playingOffline?: boolean;
    question?: TriviaQuestion;
    timeLimit?: TimeLimitOption;
    lifelines?: LifelineState;
    currentStreak?: number;
  } = {},
) {
  // Mirrors the real service's streak bookkeeping rather than stubbing it
  // flat: the component reads the multiplier *before* and *after* this call to
  // decide whether a tier moved, so a `registerAnswer` that changed nothing
  // would make every announcement test pass against a component that never
  // announces.
  const registerAnswer = vi.fn((answer: Answer | null) => {
    if (answer?.isCorrect === true) {
      currentStreak.update((value) => value + 1);
    } else {
      currentStreak.set(0);
    }
  });
  const advanceQuestion = vi.fn();
  const registerSkippedQuestion = vi.fn();
  // The real service's contract: spends the lifeline and reports whether there
  // was one. Faking it as a flat `true` would let a test pass against a
  // component that never checks.
  const consumeLifeline = vi.fn((id: keyof LifelineState) => {
    const state = gameController.lifelines();
    if (!state[id]) {
      return false;
    }
    gameController.lifelines.set({ ...state, [id]: false });
    return true;
  });
  const useFiftyFifty = vi.fn(() => {
    if (!consumeLifeline('fiftyFifty')) {
      return false;
    }
    const question = gameController.currentQuestion();
    const wrong = (question?.all_answers ?? []).filter((a) => !a.isCorrect);
    gameController.eliminatedAnswerIds.set(
      wrong.slice(0, Math.min(2, wrong.length - 1)).map((a) => a.id),
    );
    return true;
  });
  const currentStreak = signal(options.currentStreak ?? 0);
  const gameController = {
    config: signal<GameConfig | null>({
      amount: 1,
      category: '',
      difficulty: '',
      source: 'open_trivia',
      timeLimit: options.timeLimit ?? 15,
    }),
    currentQuestion: signal<TriviaQuestion | null>(options.question ?? makeQuestion()),
    currentIndex: signal(0),
    totalQuestions: signal(1),
    score: signal(0),
    currentStreak,
    scoreMultiplier: computed(() => multiplierForStreak(currentStreak())),
    progressPercentage: signal(100),
    isLastQuestion: signal(false),
    flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
    toggleQuestionFlag: vi.fn(),
    registerAnswer,
    advanceQuestion,
    lifelines: signal<LifelineState>(options.lifelines ?? ALL_LIFELINES_AVAILABLE),
    eliminatedAnswerIds: signal<readonly string[]>([]),
    registerSkippedQuestion,
    consumeLifeline,
    useFiftyFifty,
  };

  // Stubbed rather than real, because the assertion is *which cue fired on
  // which event* — the real service is a no-op in jsdom (no `AudioContext`),
  // so a spy on it would record nothing either way. `audio.service.spec.ts`
  // covers the service itself.
  const audio = {
    isMuted: signal(false),
    toggleMute: vi.fn(),
    playCorrect: vi.fn(),
    playIncorrect: vi.fn(),
    playTimerTick: vi.fn(),
    playLifeline: vi.fn(),
    playGameOver: vi.fn(),
  };

  TestBed.configureTestingModule({
    providers: [
      {
        provide: GameControllerService,
        useValue: gameController,
      },
      {
        provide: TriviaService,
        useValue: { playingOffline: signal(options.playingOffline ?? false) },
      },
      { provide: AudioService, useValue: audio },
      { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
    ],
  });

  const fixture = TestBed.createComponent(QuizLoopComponent);
  fixture.detectChanges();
  return {
    fixture,
    registerAnswer,
    advanceQuestion,
    gameController,
    registerSkippedQuestion,
    consumeLifeline,
    audio,
    host: fixture.nativeElement as HTMLElement,
    query: (selector: string) =>
      (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(selector),
    queryAll: (selector: string) =>
      Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(selector)),
  };
}

// The countdown reads the wall clock, so tests fake only the timer functions and
// leave `Date` alone — a spy on `Date.now` then drives real elapsed time
// independently of how often the (throttleable) interval actually fires.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * `FEAT-004`. The badge itself is the part the service cannot test: it has to
 * be in the DOM on every question so the wrapping badge row never re-wraps
 * (`CLAUDE.md` §4.4), and the tier change has to be announced, because
 * "answers are now worth more" is otherwise conveyed by a colour alone (§4.5).
 *
 * jsdom has no layout, so this cannot measure the row — what it *can* pin is
 * the mechanism that makes the measurement come out right: the element is
 * always mounted, only `invisible` moves, and the text inside it is the same
 * length in every tier. The pixels are `streak-multipliers.spec.ts`'s job.
 */
describe('QuizLoopComponent — the streak badge (FEAT-004)', () => {
  it('mounts the badge from the first question, hidden until a streak builds', () => {
    const { query, fixture } = setup();

    const badge = query('[data-cy="streak-indicator"]');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains('invisible')).toBe(true);
    fixture.destroy();
  });

  it('keeps the badge mounted and only drops `invisible` once the streak shows', () => {
    const { query, fixture, gameController } = setup({ currentStreak: 2 });

    expect(query('[data-cy="streak-indicator"]')?.classList.contains('invisible')).toBe(false);

    gameController.currentStreak.set(0);
    fixture.detectChanges();

    // Still there — removing it would re-wrap the badge row mid-round.
    expect(query('[data-cy="streak-indicator"]')).not.toBeNull();
    expect(query('[data-cy="streak-indicator"]')?.classList.contains('invisible')).toBe(true);
    fixture.destroy();
  });

  it('shows the run and the multiplier it earns', () => {
    const { query, fixture } = setup({ currentStreak: 5 });

    expect(query('[data-cy="streak-count"]')?.textContent?.trim()).toBe('5');
    expect(query('[data-cy="streak-multiplier"]')?.textContent?.trim()).toBe('×2.0');
    fixture.destroy();
  });

  /*
   * The badge reserves its width by being the same width in every state, not
   * by a measured minimum — so the multiplier is written to one decimal and the
   * run sits in a two-character slot. jsdom cannot measure either, but it can
   * check that the *text* stays one length, which is the property the layout
   * depends on.
   */
  it('writes the multiplier to a constant width at every tier', () => {
    const { query, fixture, gameController } = setup();
    const widths = new Set<number>();

    for (const streak of [0, 2, 3, 5, 8]) {
      gameController.currentStreak.set(streak);
      fixture.detectChanges();
      widths.add((query('[data-cy="streak-multiplier"]')?.textContent?.trim() ?? '').length);
    }

    expect(widths.size).toBe(1);
    fixture.destroy();
  });

  // The visual badge is decoration; the live region below it is the accessible
  // channel, and announcing both would say the same thing twice.
  it('hides the badge from assistive tech, which has the live region', () => {
    const { query, fixture } = setup({ currentStreak: 3 });

    expect(query('[data-cy="streak-indicator"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(query('[data-cy="streak-status"]')).not.toBeNull();
    fixture.destroy();
  });

  it('announces reaching a new multiplier tier', () => {
    const { query, fixture, gameController } = setup({ currentStreak: 2 });

    // The third correct answer in a row is the first to earn 1.5x.
    query('[data-cy="answer-option"]')?.click();
    fixture.detectChanges();

    expect(gameController.currentStreak()).toBe(3);
    expect(query('[data-cy="streak-status"]')?.textContent).toContain('streak of 3');
    expect(query('[data-cy="streak-status"]')?.textContent).toContain('1.5 times');
    fixture.destroy();
  });

  /*
   * Tier changes only. The result region beside this one already announces
   * "Correct." on every right answer, so a second region repeating the running
   * count on each one would bury the part that matters rather than add to it.
   */
  it('says nothing when a correct answer leaves the tier where it was', () => {
    const { query, fixture } = setup();

    query('[data-cy="answer-option"]')?.click();
    fixture.detectChanges();

    expect(query('[data-cy="streak-status"]')?.textContent?.trim()).toBe('');
    fixture.destroy();
  });

  it('announces losing a tier, not merely losing the run', () => {
    const { query, fixture, queryAll } = setup({ currentStreak: 5 });

    // The second option is the wrong one on the default fixture question.
    queryAll('[data-cy="answer-option"]')[1]?.click();
    fixture.detectChanges();

    expect(query('[data-cy="streak-status"]')?.textContent).toContain('streak lost');
    fixture.destroy();
  });

  /*
   * The house pattern for a live region (G3): identical text set twice is a
   * no-op for a signal, and a live region only announces on mutation — so the
   * position is part of the message, and reaching the same tier on a later
   * question has to read differently.
   */
  it('carries the question position, so the same tier announces twice', () => {
    // Two components rather than two clicks on one: a question locks once
    // answered, which is the behaviour under test everywhere else in this file.
    const first = setup({ currentStreak: 2 });
    first.query('[data-cy="answer-option"]')?.click();
    first.fixture.detectChanges();
    const firstText = first.query('[data-cy="streak-status"]')?.textContent ?? '';
    first.fixture.destroy();
    TestBed.resetTestingModule();

    const later = setup({ currentStreak: 2 });
    later.gameController.currentIndex.set(4);
    later.query('[data-cy="answer-option"]')?.click();
    later.fixture.detectChanges();

    expect(firstText).toContain('Question 1:');
    expect(later.query('[data-cy="streak-status"]')?.textContent).toContain('Question 5:');
    later.fixture.destroy();
  });
});

/**
 * Finding B5. `TriviaService.playingOffline` was set the moment a game fell
 * back to the cached offline pool, and read by nothing — so a player mid-way
 * through a game on stale cached questions was never told. These pin that the
 * `/play` screen renders a banner exactly when that signal is true, which the
 * old dead-code state would have failed.
 */
describe('QuizLoopComponent — offline banner (B5)', () => {
  it('shows the offline banner when playingOffline is true', () => {
    const { fixture } = setup({ playingOffline: true });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('these questions are from your saved offline pool');
    fixture.destroy();
  });

  it('hides the offline banner when playingOffline is false', () => {
    const { fixture } = setup({ playingOffline: false });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('saved offline pool');
    fixture.destroy();
  });
});

/**
 * Finding B10. The 15s countdown counted interval ticks down from 15. Browsers
 * throttle `setInterval` in a backgrounded tab to as little as once a minute,
 * so a counted-down timer stalls exactly when the deadline should be running —
 * the question never times out until the tab is refocused, and then resumes
 * from where it "paused". The fix derives the remaining time from the wall
 * clock, so a sparse tick still lands on the truth.
 */
describe('QuizLoopComponent — wall-clock countdown (B10)', () => {
  const START = 1_000_000_000;

  it('expires on real elapsed time even when the interval was throttled to a single late tick', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const { registerAnswer } = setup(); // deadline = START + 15000

    // The tab was backgrounded: real time jumped 30s ahead while the throttled
    // interval fired essentially not at all. Only now does one tick land.
    now = START + 30_000;
    vi.advanceTimersByTime(250);

    // A tick-counting timer would be at ~14s remaining and not have fired; the
    // wall-clock one sees the deadline long gone and auto-submits a no-answer.
    expect(registerAnswer).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('does not expire before the deadline, however many ticks fire', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const { fixture, registerAnswer } = setup(); // deadline = START + 15000

    // 10s of real time, and a full run of on-time ticks over that window.
    now = START + 10_000;
    vi.advanceTimersByTime(10_000);
    fixture.detectChanges();

    expect(registerAnswer).not.toHaveBeenCalled();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('5s'); // ceil((15000 - 10000) / 1000)
  });

  it('re-syncs on visibilitychange, expiring immediately without waiting for a throttled tick', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const { registerAnswer } = setup(); // deadline = START + 15000

    // Time passes the deadline while the tab is hidden and no tick has fired.
    now = START + 16_000;
    expect(registerAnswer).not.toHaveBeenCalled();

    // Returning to the tab fires visibilitychange (jsdom reports 'visible'),
    // which re-reads the clock and expires the question at once.
    document.dispatchEvent(new Event('visibilitychange'));

    expect(registerAnswer).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('detaches the visibilitychange listener on destroy', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const { fixture, registerAnswer } = setup();
    fixture.destroy();

    // After teardown the event must do nothing — a leaked listener would still
    // be holding the deadline and could commit against a destroyed component.
    now = START + 16_000;
    document.dispatchEvent(new Event('visibilitychange'));

    expect(registerAnswer).not.toHaveBeenCalled();
  });
});

/**
 * Finding G3. The coloured banner under the options is the only thing that says
 * whether an answer was right, and it was announced to nobody: it appears
 * without focus moving, and the quiz auto-advances two seconds later — so a
 * screen reader user was handed the next question having never learned the
 * result of the last one.
 */
describe('QuizLoopComponent — result announcement (G3)', () => {
  const liveRegion = (fixture: ReturnType<typeof setup>['fixture']) =>
    // Addressed by data-cy, not by being the only [role=status] on the
    // screen: flagging added a second one, and a positional selector would
    // silently start asserting against the wrong region.
    (fixture.nativeElement as HTMLElement).querySelector('[data-cy="result-status"]');

  it('keeps the live region in the DOM before there is anything to announce', () => {
    const { fixture } = setup();

    // A region inserted already carrying its message is routinely missed by
    // screen readers; it has to be present and then change.
    expect(liveRegion(fixture)).not.toBeNull();
    expect(liveRegion(fixture)?.textContent?.trim()).toBe('');
    expect(liveRegion(fixture)?.getAttribute('aria-live')).toBe('polite');

    fixture.destroy();
  });

  it('announces a correct answer', () => {
    const { fixture } = setup();
    const question = TestBed.inject(GameControllerService).currentQuestion()!;

    clickAnswer(fixture, question.all_answers.find((a) => a.isCorrect)!.text);

    expect(liveRegion(fixture)?.textContent?.trim()).toBe('Correct.');
    fixture.destroy();
  });

  // The wrong answer is the case where the banner's colour carries the meaning,
  // so the text has to say what the right answer was rather than just "wrong".
  it('announces an incorrect answer along with the correct one', () => {
    const { fixture } = setup();
    const question = TestBed.inject(GameControllerService).currentQuestion()!;

    clickAnswer(fixture, question.all_answers.find((a) => !a.isCorrect)!.text);

    expect(liveRegion(fixture)?.textContent?.trim()).toBe(
      `Incorrect. The correct answer is ${question.correct_answer}.`,
    );
    fixture.destroy();
  });

  it('announces a timeout, which no click ever reports', () => {
    let now = 1_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { fixture } = setup();
    const question = TestBed.inject(GameControllerService).currentQuestion()!;

    now += 16_000;
    vi.advanceTimersByTime(250);
    fixture.detectChanges();

    expect(liveRegion(fixture)?.textContent?.trim()).toBe(
      `Time's up. The correct answer was ${question.correct_answer}.`,
    );
    fixture.destroy();
  });
});

describe('QuizLoopComponent: the result banner', () => {
  const banner = (fixture: ReturnType<typeof setup>['fixture']) =>
    (fixture.nativeElement as HTMLElement).querySelector(
      '[data-cy="result-banner"]',
    ) as HTMLElement;

  /** The messages that are actually on screen — the rest are `invisible`. */
  const visibleMessages = (fixture: ReturnType<typeof setup>['fixture']) =>
    [...banner(fixture).children]
      .filter((child) => !child.className.includes('invisible'))
      .map((child) => (child.textContent ?? '').replace(/\s+/g, ' ').trim());

  /**
   * The banner has to occupy its space *before* there is a result, because the
   * card is vertically centred: a banner that appears on answering makes the
   * card taller and centring lifts the whole thing by half of that. Measured
   * before this changed, the card jumped 43px at 390x1000 and 37px at 1024x900
   * — right as the reader looked at the answer they had just picked.
   *
   * jsdom does no layout, so the height itself is asserted in
   * `game-flow.spec.ts`. What is pinned here is the structure it depends on: the
   * container exists from the first render, and it is never the thing that
   * gets added.
   */
  it('reserves the banner space before any answer is given', () => {
    const { fixture } = setup();

    expect(banner(fixture)).not.toBeNull();
    expect(visibleMessages(fixture)).toEqual([]);
    fixture.destroy();
  });

  it('shows exactly one message once an answer lands', () => {
    const { fixture } = setup();
    const question = TestBed.inject(GameControllerService).currentQuestion()!;

    clickAnswer(fixture, question.all_answers.find((a) => a.isCorrect)!.text);

    expect(visibleMessages(fixture)).toEqual(['🎉Correct! Well done.']);
    fixture.destroy();
  });

  /**
   * The reserved height is the tallest of the three, which only works because
   * all three are in the DOM at once, stacked in one grid cell. A single
   * hard-coded `min-h` would be a number to re-measure whenever the wording
   * changed — and too small a guess brings the shift back a line at a time.
   */
  it('keeps all three messages mounted so the tallest reserves the space', () => {
    const { fixture } = setup();

    expect(banner(fixture).children.length).toBe(3);
    fixture.destroy();
  });

  /**
   * The visible banner must not name the answer. That is what made its height
   * depend on the question — a long answer wrapped to a second line — and it
   * is redundant next to the emerald highlight on the correct option.
   */
  it('never names the correct answer on screen, only in the announcement', () => {
    const { fixture } = setup();
    const question = TestBed.inject(GameControllerService).currentQuestion()!;

    clickAnswer(fixture, question.all_answers.find((a) => !a.isCorrect)!.text);

    const announcement = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-cy="result-status"]',
    );
    expect(banner(fixture).textContent).not.toContain(question.correct_answer);
    expect(announcement?.textContent).toContain(question.correct_answer);
    fixture.destroy();
  });

  /**
   * `aria-hidden` because the `role="status"` region says the same thing and is
   * the accessible channel for it. Without it a screen reader would meet all
   * three stacked messages in the DOM — and even before they were stacked, it
   * heard the result twice.
   */
  it('hides the visual banner from assistive tech, which has the live region', () => {
    const { fixture } = setup();

    expect(banner(fixture).getAttribute('aria-hidden')).toBe('true');
    fixture.destroy();
  });

  /**
   * A timeout is not a wrong answer: different icon, different sentence, and
   * `selectedAnswer()` is `null` rather than a losing option. Collapsing the
   * two is the mistake `resultKind()` exists to make hard.
   */
  it('distinguishes a timeout from a wrong answer', () => {
    let now = 1_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { fixture } = setup();

    now += 16_000;
    vi.advanceTimersByTime(250);
    fixture.detectChanges();

    expect(visibleMessages(fixture)).toEqual(["⏰Time's up!"]);
    fixture.destroy();
  });
});

/** Clicks the option whose visible text matches, the way a player would. */
function clickAnswer(fixture: ReturnType<typeof setup>['fixture'], text: string): void {
  const buttons = Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
  ) as HTMLButtonElement[];
  const target = buttons.find((button) => button.textContent?.includes(text));
  if (!target) {
    throw new Error(`No answer button with text "${text}"`);
  }
  target.click();
  fixture.detectChanges();
}

/**
 * In-quiz flagging. The point of doing it here rather than only on
 * `/game-over` is that this is where the player is actually looking at the
 * question — so the interaction has to be cheap enough to survive a running
 * countdown: one click, no dialog, reversible.
 */
describe('QuizLoopComponent — flagging a question', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  const flagButton = (fixture: ReturnType<typeof setup>['fixture']) =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '[data-cy="flag-question"]',
    );

  it('offers the flag on a community question', () => {
    const { fixture } = setup({ question: makeQuestion({ source: 'custom' }) });
    fixture.detectChanges();

    expect(flagButton(fixture)).not.toBeNull();
    expect(flagButton(fixture)?.getAttribute('aria-pressed')).toBe('false');
  });

  // Open Trivia DB content is not ours to moderate and its ids are minted per
  // fetch, so a report about one could never be acted on.
  it('offers no flag on an Open Trivia DB question', () => {
    const { fixture } = setup({ question: makeQuestion({ source: 'open_trivia' }) });
    fixture.detectChanges();

    expect(flagButton(fixture)).toBeNull();
  });

  it('toggles the flag through the game controller, both ways', () => {
    const { fixture, gameController } = setup({ question: makeQuestion({ source: 'custom' }) });
    fixture.detectChanges();

    flagButton(fixture)?.click();
    expect(gameController.toggleQuestionFlag).toHaveBeenCalledWith('q1');
  });

  it('shows the flag as pressed, filled and explained once set', () => {
    const question = makeQuestion({ source: 'custom' });
    const { fixture, gameController } = setup({ question });
    gameController.flaggedQuestionIds.set(new Set([question.id]));
    fixture.detectChanges();

    const button = flagButton(fixture);
    // Not colour alone (WCAG 1.4.1): the pressed state, the accessible name
    // and the icon all change.
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.getAttribute('aria-label')).toMatch(/Flagged/i);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-cy="flag-notice"]'),
    ).not.toBeNull();
  });

  it('announces the flag, and says the details come later', () => {
    const question = makeQuestion({ source: 'custom' });
    const { fixture, gameController } = setup({ question });
    gameController.flaggedQuestionIds.set(new Set([question.id]));
    fixture.detectChanges();

    const status = (fixture.nativeElement as HTMLElement).querySelector('[data-cy="flag-status"]');
    expect(status?.textContent).toMatch(/flagged/i);
    expect(status?.textContent).toMatch(/end of the game/i);
  });

  // Identical announcement text set twice is a signal no-op, and a live
  // region only announces on mutation — so the position has to be in it, or
  // flagging a second question says nothing at all (the H4 review's finding,
  // in the same shape).
  it('announces a different question distinctly', () => {
    const question = makeQuestion({ source: 'custom' });
    const { fixture, gameController } = setup({ question });
    gameController.flaggedQuestionIds.set(new Set([question.id]));
    fixture.detectChanges();
    const first = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-cy="flag-status"]',
    )?.textContent;

    gameController.currentIndex.set(1);
    fixture.detectChanges();
    const second = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-cy="flag-status"]',
    )?.textContent;

    expect(first).not.toEqual(second);
  });
});

/**
 * Finding G7. A fixed 15-second limit that cannot be adjusted, extended or
 * turned off fails WCAG 2.2.1, and "turned off" is the part these cover: an
 * unlimited game must have no deadline at all, not a generous one.
 *
 * The clock is driven with `vi.spyOn(Date, 'now')`, matching the B10 tests
 * above, because the countdown reads the wall clock rather than counting
 * ticks. The global `useFakeTimers` here deliberately fakes only the
 * interval — advancing that alone leaves `Date.now()` real, the deadline
 * permanently in the future, and an "it never expired" assertion passing for
 * a reason that has nothing to do with the code under test. Confirmed by
 * mutation: written that way, these did not fail when `startTimer` was
 * changed to schedule a countdown for an unlimited game.
 */
describe('QuizLoopComponent — the adjustable timer (G7)', () => {
  const START = 1_000_000_000;

  afterEach(() => TestBed.resetTestingModule());

  const ring = (fixture: ReturnType<typeof setup>['fixture']) =>
    (fixture.nativeElement as HTMLElement).querySelector('[data-cy="question-timer"]');
  const noLimitBadge = (fixture: ReturnType<typeof setup>['fixture']) =>
    (fixture.nativeElement as HTMLElement).querySelector('[data-cy="no-time-limit"]');

  it('counts down from the chosen limit, not a hard-coded 15', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { fixture } = setup({ timeLimit: 30 });

    expect(ring(fixture)?.textContent).toContain('30s');

    now = START + 5000;
    vi.advanceTimersByTime(250);
    fixture.detectChanges();
    expect(ring(fixture)?.textContent).toContain('25s');
  });

  it('shows no countdown at all for an unlimited game', () => {
    const { fixture } = setup({ timeLimit: 'unlimited' });

    expect(ring(fixture)).toBeNull();
    expect(noLimitBadge(fixture)?.textContent).toContain('No time limit');
  });

  /*
   * The criterion itself. `unlimited` has to mean "no deadline", not "a very
   * large one" — a big number is still a deadline, just a less obvious one —
   * so the wall clock jumps an hour and the question must still be unanswered.
   */
  it('never auto-answers an unlimited game, however long the player takes', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { fixture, registerAnswer } = setup({ timeLimit: 'unlimited' });

    now = START + 60 * 60 * 1000;
    vi.advanceTimersByTime(250);
    fixture.detectChanges();

    expect(registerAnswer).not.toHaveBeenCalled();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-cy="result-status"]')
        ?.textContent,
    ).not.toContain("Time's up");
  });

  it('still expires a timed game on its own deadline', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { registerAnswer } = setup({ timeLimit: 30 });

    // One second short of the 30s deadline: a 15s limit would already have fired.
    now = START + 29_000;
    vi.advanceTimersByTime(250);
    expect(registerAnswer).not.toHaveBeenCalled();

    now = START + 30_500;
    vi.advanceTimersByTime(250);
    expect(registerAnswer).toHaveBeenCalledExactlyOnceWith(null);
  });

  // A save written before the picker existed carries no limit, and every one
  // of those games was played at 15 seconds.
  it('falls back to 15 seconds when the config predates the picker', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { fixture, gameController, registerAnswer } = setup();
    gameController.config.set(null);
    fixture.detectChanges();

    now = START + 15_500;
    vi.advanceTimersByTime(250);
    expect(registerAnswer).toHaveBeenCalledExactlyOnceWith(null);
  });
});

/**
 * `FEAT-002`, component half. The service owns which lifelines are left; this
 * owns the timer, so Extra Time's arithmetic is only testable here — and so is
 * every rule about what the toolbar renders.
 */
describe('QuizLoopComponent — lifelines (FEAT-002)', () => {
  const START = 1_000_000_000;

  function fourAnswers(): TriviaQuestion {
    return makeQuestion({
      all_answers: [
        { id: 'q1:correct', text: 'Paris', isCorrect: true },
        { id: 'q1:incorrect-0', text: 'London', isCorrect: false },
        { id: 'q1:incorrect-1', text: 'Berlin', isCorrect: false },
        { id: 'q1:incorrect-2', text: 'Madrid', isCorrect: false },
      ],
    });
  }

  it('offers all three on a timed game', () => {
    const { query } = setup({ question: fourAnswers() });

    expect(query('[data-cy="lifeline-fiftyFifty"]')).not.toBeNull();
    expect(query('[data-cy="lifeline-extraTime"]')).not.toBeNull();
    expect(query('[data-cy="lifeline-skip"]')).not.toBeNull();
  });

  /*
   * Hidden, not disabled — there is no countdown to extend, and the spec is
   * right that a control which visibly does nothing is worse than one that is
   * not there. Safe from the §4.4 sizing rule precisely because the limit is
   * fixed before question 1: the toolbar is two buttons for the whole game
   * rather than changing size during it.
   */
  it('renders no Extra Time button at all on an unlimited game', () => {
    const { query } = setup({ timeLimit: 'unlimited', question: fourAnswers() });

    expect(query('[data-cy="lifeline-extraTime"]')).toBeNull();
    expect(query('[data-cy="lifeline-fiftyFifty"]')).not.toBeNull();
    expect(query('[data-cy="lifeline-skip"]')).not.toBeNull();
  });

  /*
   * ...and 50/50 gets the opposite treatment on a question it cannot help
   * with, for the mirror-image reason: whether a question is true/false varies
   * question to question, so hiding it would resize the toolbar mid-round.
   */
  it('disables rather than hides 50/50 on a true/false question', () => {
    const { query } = setup(); // makeQuestion() is two options

    const button = query('[data-cy="lifeline-fiftyFifty"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-label')).toContain('unavailable');
  });

  it('greys out the options 50/50 removed, and makes them unclickable', () => {
    const { query, queryAll, fixture, registerAnswer, gameController } = setup({
      question: fourAnswers(),
    });

    query('[data-cy="lifeline-fiftyFifty"]')?.click();
    fixture.detectChanges();

    const eliminated = queryAll('[data-cy="answer-option"][data-eliminated]');
    expect(eliminated).toHaveLength(2);
    expect(eliminated.every((el) => (el as HTMLButtonElement).disabled)).toBe(true);

    // Clicking one anyway must not score it. Driven through `selectAnswer`
    // rather than `.click()`: the button is `disabled`, so a DOM click never
    // reaches the handler and the assertion passes with the guard removed —
    // which is exactly what mutation testing found. The guard is there for the
    // programmatic path, so that is the path the test takes.
    eliminated[0].click();
    expect(registerAnswer).not.toHaveBeenCalled();

    const component = fixture.componentInstance as unknown as {
      selectAnswer: (answer: Answer) => void;
    };
    const removedId = gameController.eliminatedAnswerIds()[0];
    const removed = gameController.currentQuestion()?.all_answers.find((a) => a.id === removedId);
    expect(removed).toBeDefined();
    component.selectAnswer(removed as Answer);
    expect(registerAnswer).not.toHaveBeenCalled();
  });

  // The options keep their cells. Collapsing a four-option grid to two would
  // move the surviving answers under the player's cursor mid-read (§4.4).
  it('keeps every option mounted after 50/50', () => {
    const { queryAll, query, fixture } = setup({ question: fourAnswers() });

    query('[data-cy="lifeline-fiftyFifty"]')?.click();
    fixture.detectChanges();

    expect(queryAll('[data-cy="answer-option"]')).toHaveLength(4);
  });

  it('spends a lifeline once — the button is disabled afterwards', () => {
    const { query, fixture } = setup({ question: fourAnswers() });

    query('[data-cy="lifeline-fiftyFifty"]')?.click();
    fixture.detectChanges();

    expect((query('[data-cy="lifeline-fiftyFifty"]') as HTMLButtonElement).disabled).toBe(true);
    expect(query('[data-cy="lifeline-fiftyFifty"]')?.getAttribute('aria-label')).toContain(
      'already used',
    );
  });

  it('keeps spent lifelines in the DOM, so the toolbar cannot change size', () => {
    const { queryAll, query, fixture } = setup({ question: fourAnswers() });
    // Scoped to the toolbar, not `[data-cy^="lifeline-"]` — that prefix also
    // matches the `lifeline-status` live region, and a `<p>` has no `disabled`
    // property, so the sibling assertion below silently passed on `undefined`
    // until it didn't. The §4.6 selector trap, in a new costume.
    const before = queryAll('[data-cy="lifelines"] button').length;

    query('[data-cy="lifeline-fiftyFifty"]')?.click();
    fixture.detectChanges();

    expect(queryAll('[data-cy="lifelines"] button')).toHaveLength(before);
  });

  it('moves the deadline forward by 15 seconds rather than adding ticks', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { query, fixture, registerAnswer } = setup({ question: fourAnswers() });

    query('[data-cy="lifeline-extraTime"]')?.click();
    fixture.detectChanges();

    // Past the original 15s deadline, inside the extended 30s one.
    now = START + 20_000;
    vi.advanceTimersByTime(250);
    expect(registerAnswer).not.toHaveBeenCalled();

    now = START + 30_500;
    vi.advanceTimersByTime(250);
    expect(registerAnswer).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('repaints the countdown immediately, not on the next tick', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { query, fixture, host } = setup({ question: fourAnswers() });

    now = START + 5_000; // 10s left
    vi.advanceTimersByTime(250);
    fixture.detectChanges();

    query('[data-cy="lifeline-extraTime"]')?.click();
    fixture.detectChanges();

    expect(host.querySelector('[data-cy="question-timer"]')?.textContent).toContain('25');
  });

  /*
   * Driven through the component method rather than a click, deliberately.
   * The button is not rendered on an unlimited game, so a click-based test
   * asserts only that nothing happened when nothing was pressed — it passed
   * with the `isTimed()` guard deleted, which mutation testing showed. The
   * guard exists for the programmatic path, so the test has to take it.
   */
  it('does not spend Extra Time on an unlimited game, where there is nothing to extend', () => {
    const { fixture, consumeLifeline } = setup({
      timeLimit: 'unlimited',
      question: fourAnswers(),
    });
    const component = fixture.componentInstance as unknown as { useExtraTime: () => void };

    component.useExtraTime();

    expect(consumeLifeline).not.toHaveBeenCalledWith('extraTime');
  });

  it('skips straight to the next question, with no result delay', () => {
    const { query, registerSkippedQuestion, advanceQuestion, registerAnswer } = setup({
      question: fourAnswers(),
    });

    query('[data-cy="lifeline-skip"]')?.click();

    expect(registerSkippedQuestion).toHaveBeenCalledOnce();
    // Immediately, without waiting out ANSWER_DELAY_MS — the point of Skip.
    expect(advanceQuestion).toHaveBeenCalledOnce();
    // And it is not an answer: nothing is scored and no banner is shown.
    expect(registerAnswer).not.toHaveBeenCalled();
  });

  /*
   * The skipped question's countdown must not carry over — the next question
   * starts on a full clock, not on whatever was left.
   *
   * Deliberately **not** "no answer is registered after the deadline": the next
   * question legitimately gets its own timer the moment we advance, so jumping
   * past the old deadline expires the *new* one and the test would fail against
   * correct code. That is what the first draft of this asserted.
   */
  it('restarts the countdown from full when a question is skipped', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { query, fixture, host, registerAnswer } = setup({ question: fourAnswers() });

    now = START + 10_000; // 5s left
    vi.advanceTimersByTime(250);
    fixture.detectChanges();
    expect(host.querySelector('[data-cy="question-timer"]')?.textContent).toContain('5');

    query('[data-cy="lifeline-skip"]')?.click();
    fixture.detectChanges();

    // A fresh 15s, and the skip itself scored nothing on the way past.
    expect(host.querySelector('[data-cy="question-timer"]')?.textContent).toContain('15');
    expect(registerAnswer).not.toHaveBeenCalled();
    // **And exactly one interval is running.** Without `stopTimer()` the old
    // one is never cleared — `startTimer()` just overwrites the handle — so a
    // skip leaks an interval per use and `clearTimers()` on destroy only ever
    // clears the last. Invisible to every assertion above, which is why this
    // counts them (`CLAUDE.md` §4.4: every timer has a teardown).
    expect(vi.getTimerCount()).toBe(1);
  });

  it('locks every lifeline once the question is answered', () => {
    const { queryAll, fixture, query } = setup({ question: fourAnswers() });

    query('[data-cy="answer-option"]')?.click();
    fixture.detectChanges();

    const buttons = queryAll('[data-cy="lifelines"] button') as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it('announces a spent lifeline, which is otherwise a silent visual change', () => {
    const { query, fixture } = setup({ question: fourAnswers() });
    expect(query('[data-cy="lifeline-status"]')?.textContent?.trim()).toBe('');

    query('[data-cy="lifeline-fiftyFifty"]')?.click();
    fixture.detectChanges();

    expect(query('[data-cy="lifeline-status"]')?.textContent).toContain('Fifty-fifty used');
  });

  it('labels the toolbar as a group, so its buttons are not three loose controls', () => {
    const { query } = setup({ question: fourAnswers() });

    expect(query('[data-cy="lifelines"]')?.getAttribute('role')).toBe('group');
    expect(query('[data-cy="lifelines"]')?.getAttribute('aria-label')).toBe('Lifelines');
  });

  // The label has to say so: a player choosing between Skip and a guess is
  // making a scoring decision, and "no penalty" would imply the opposite.
  it('says in the Skip label that the question still counts', () => {
    const { query } = setup({ question: fourAnswers() });

    expect(query('[data-cy="lifeline-skip"]')?.getAttribute('aria-label')).toContain(
      'still counts',
    );
  });

  it('records the skip as SKIPPED, not as a timeout', () => {
    const { query, gameController } = setup({ question: fourAnswers() });
    const history: unknown[] = [];
    gameController.registerSkippedQuestion.mockImplementation(() => history.push(SKIPPED));

    query('[data-cy="lifeline-skip"]')?.click();

    expect(history).toEqual([SKIPPED]);
  });
});

/**
 * The audio cues (`FEAT-003`).
 *
 * All of this is inaudible to every other layer of the suite: Playwright runs a
 * muted browser, Lighthouse never leaves `/`, and a cue fired on the wrong
 * event looks identical in a diff to one fired on the right event. So what is
 * pinned here is the *mapping* — which event plays what, and, at least as
 * importantly, which events play nothing.
 */
describe('QuizLoopComponent — audio cues (FEAT-003)', () => {
  const START = 1_000_000_000;

  /** 50/50 and Skip both need a question with more than one wrong option. */
  function fourAnswers(): TriviaQuestion {
    return makeQuestion({
      all_answers: [
        { id: 'q1:correct', text: 'Paris', isCorrect: true },
        { id: 'q1:incorrect-0', text: 'London', isCorrect: false },
        { id: 'q1:incorrect-1', text: 'Berlin', isCorrect: false },
        { id: 'q1:incorrect-2', text: 'Madrid', isCorrect: false },
      ],
    });
  }

  it('plays the success cue on a correct answer, and only that one', () => {
    const { query, audio } = setup();

    query('[data-cy="answer-option"]')?.click();

    expect(audio.playCorrect).toHaveBeenCalledOnce();
    expect(audio.playIncorrect).not.toHaveBeenCalled();
  });

  it('plays the failure cue on a wrong answer', () => {
    const { queryAll, audio } = setup();

    // The second option is the wrong one on the default fixture question.
    queryAll('[data-cy="answer-option"]')[1]?.click();

    expect(audio.playIncorrect).toHaveBeenCalledOnce();
    expect(audio.playCorrect).not.toHaveBeenCalled();
  });

  /**
   * A timeout and a wrong answer are the same event to a player — the question
   * is over and it scored nothing — so they share a cue. The recap is where the
   * two are told apart, which is the screen with no clock on it.
   */
  it('plays the failure cue when the clock runs out with nothing chosen', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { audio, registerAnswer } = setup();

    now = START + 16_000;
    vi.advanceTimersByTime(250);

    expect(registerAnswer).toHaveBeenCalledExactlyOnceWith(null);
    expect(audio.playIncorrect).toHaveBeenCalledOnce();
  });

  /**
   * **A skip gets the lifeline cue and neither answer cue**, which is the
   * distinction worth pinning: the question ends without producing an outcome
   * to react to, so "that worked" is the whole of what there is to report.
   */
  it('plays the lifeline cue on a skip, and neither answer cue', () => {
    const { query, audio } = setup({ question: fourAnswers() });

    query('[data-cy="lifeline-skip"]')?.click();

    expect(audio.playLifeline).toHaveBeenCalledOnce();
    expect(audio.playCorrect).not.toHaveBeenCalled();
    expect(audio.playIncorrect).not.toHaveBeenCalled();
  });

  it('plays the lifeline cue when 50/50 is spent', () => {
    const { query, audio } = setup({ question: fourAnswers() });

    query('[data-cy="lifeline-fiftyFifty"]')?.click();

    expect(audio.playLifeline).toHaveBeenCalledOnce();
  });

  it('plays the lifeline cue when Extra Time is spent', () => {
    const { query, audio } = setup({ question: fourAnswers() });

    query('[data-cy="lifeline-extraTime"]')?.click();

    expect(audio.playLifeline).toHaveBeenCalledOnce();
  });

  /**
   * **Silence is the other half of the contract.** The cue reports that a
   * lifeline was spent, so a press that spends nothing must make no sound —
   * otherwise it tells the player something happened when nothing did.
   *
   * Every case below is unreachable by pointer, because the button carries
   * `disabled` — which is exactly why the click is **dispatched** rather than
   * `click()`ed. `HTMLElement.click()` on a disabled control runs no activation
   * behaviour, so the handler is never entered and the test would be asserting
   * about the attribute rather than about the guard; hoisting the cue above the
   * guard, the mutation this is for, would not fail it. Dispatching invokes the
   * listener the way a stray programmatic click does — the same case
   * `selectAnswer()`'s own re-check calls the belt to its braces.
   */
  function press(button: HTMLElement | null): void {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  it('stays silent when 50/50 cannot be spent on a two-option question', () => {
    // The default fixture question is true/false-shaped: one wrong answer, so
    // removing it would hand over the correct one.
    const { query, audio } = setup();

    press(query('[data-cy="lifeline-fiftyFifty"]'));

    expect(audio.playLifeline).not.toHaveBeenCalled();
  });

  it('stays silent when Extra Time is not rendered on an unlimited game', () => {
    const { query, audio } = setup({ timeLimit: 'unlimited', question: fourAnswers() });

    expect(query('[data-cy="lifeline-extraTime"]')).toBeNull();
    expect(audio.playLifeline).not.toHaveBeenCalled();
  });

  it('stays silent on a second press of a lifeline already spent', () => {
    const { query, fixture, audio } = setup({ question: fourAnswers() });

    query('[data-cy="lifeline-skip"]')?.click();
    fixture.detectChanges();
    audio.playLifeline.mockClear();

    press(query('[data-cy="lifeline-skip"]'));

    expect(audio.playLifeline).not.toHaveBeenCalled();
  });

  it('stays silent once the question has been answered', () => {
    const { query, fixture, audio } = setup({ question: fourAnswers() });

    query('[data-cy="answer-option"]')?.click();
    fixture.detectChanges();

    press(query('[data-cy="lifeline-fiftyFifty"]'));
    press(query('[data-cy="lifeline-skip"]'));

    expect(audio.playLifeline).not.toHaveBeenCalled();
  });

  /**
   * One tick per remaining second inside the window the ring already turns red
   * for — not one per interval fire, which would be four — and none before it.
   */
  it('ticks once a second through the last five, and not before them', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { audio } = setup(); // 15s

    // Nine seconds gone: six left, which is outside the window.
    now = START + 9_000;
    vi.advanceTimersByTime(250);
    expect(audio.playTimerTick).not.toHaveBeenCalled();

    // Into the window, one whole second at a time, with the interval firing
    // four times for each of them.
    for (const elapsed of [10_000, 11_000, 12_000, 13_000, 14_000]) {
      now = START + elapsed;
      vi.advanceTimersByTime(1_000);
    }

    expect(audio.playTimerTick).toHaveBeenCalledTimes(5);
  });

  /**
   * A backgrounded tab throttles the interval to as little as one fire a
   * minute, so several seconds of the window can pass between two readings of
   * the clock. That is one tick, not one per second skipped — the cue is driven
   * by the second the clock reads, never by how often the timer fired.
   */
  it('ticks once for a whole window crossed in a single late reading', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { audio } = setup();

    now = START + 13_500; // 2s left, reached in one jump from 15
    vi.advanceTimersByTime(250);

    expect(audio.playTimerTick).toHaveBeenCalledOnce();
  });

  it('never ticks on an unlimited game, which has no deadline to warn about', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { audio } = setup({ timeLimit: 'unlimited' });

    now = START + 600_000;
    vi.advanceTimersByTime(600_000);

    expect(audio.playTimerTick).not.toHaveBeenCalled();
  });

  /**
   * The tick's teardown is the countdown's own (`CLAUDE.md` §4.4): answering
   * stops the interval, so there is nothing left to fire. Asserted rather than
   * assumed, because a cue that outlived its question would be audible on the
   * *next* one and attributed to it.
   */
  it('stops ticking the moment the question resolves', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { query, audio } = setup();

    now = START + 11_000; // 4s left — one tick
    vi.advanceTimersByTime(250);
    expect(audio.playTimerTick).toHaveBeenCalledOnce();

    query('[data-cy="answer-option"]')?.click();
    now = START + 14_000;
    vi.advanceTimersByTime(3_000);

    expect(audio.playTimerTick).toHaveBeenCalledOnce();
  });

  it('plays nothing once the component is destroyed', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { fixture, audio } = setup();

    fixture.destroy();
    now = START + 16_000;
    vi.advanceTimersByTime(5_000);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(audio.playTimerTick).not.toHaveBeenCalled();
    expect(audio.playIncorrect).not.toHaveBeenCalled();
  });

  /**
   * Extra Time pushes the deadline back out of the warning window, so the
   * ticking stops — the cue follows the question's own deadline rather than the
   * game's limit, exactly as the ring does.
   */
  it('stops ticking when Extra Time moves the deadline out of the window', () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { query, audio } = setup({ question: fourAnswers() });

    now = START + 11_000; // 4s left
    vi.advanceTimersByTime(250);
    expect(audio.playTimerTick).toHaveBeenCalledOnce();

    query('[data-cy="lifeline-extraTime"]')?.click();
    now = START + 12_000; // 18s left after the extension
    vi.advanceTimersByTime(1_000);

    expect(audio.playTimerTick).toHaveBeenCalledOnce();
  });
});
