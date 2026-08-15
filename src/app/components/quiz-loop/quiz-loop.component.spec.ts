import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { Answer, TriviaQuestion } from '../../models/question.model';
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

function setup(options: { playingOffline?: boolean; question?: TriviaQuestion } = {}) {
  const registerAnswer = vi.fn();
  const advanceQuestion = vi.fn();
  const gameController = {
    currentQuestion: signal<TriviaQuestion | null>(options.question ?? makeQuestion()),
    currentIndex: signal(0),
    totalQuestions: signal(1),
    score: signal(0),
    progressPercentage: signal(100),
    isLastQuestion: signal(false),
    flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
    toggleQuestionFlag: vi.fn(),
    registerAnswer,
    advanceQuestion,
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
      { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
    ],
  });

  const fixture = TestBed.createComponent(QuizLoopComponent);
  fixture.detectChanges();
  return { fixture, registerAnswer, advanceQuestion, gameController };
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
    expect(registerAnswer).toHaveBeenCalledExactlyOnceWith(false);
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

    expect(registerAnswer).toHaveBeenCalledExactlyOnceWith(false);
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
