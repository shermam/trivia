import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { Answer, TriviaQuestion } from '../../models/question.model';
import { GameControllerService } from '../../services/game-controller.service';
import { TriviaService } from '../../services/trivia.service';
import { QuizLoopComponent } from './quiz-loop.component';

function makeQuestion(): TriviaQuestion {
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
  };
}

function setup(options: { playingOffline?: boolean } = {}) {
  const registerAnswer = vi.fn();
  const advanceQuestion = vi.fn();

  TestBed.configureTestingModule({
    providers: [
      {
        provide: GameControllerService,
        useValue: {
          currentQuestion: signal<TriviaQuestion | null>(makeQuestion()),
          currentIndex: signal(0),
          totalQuestions: signal(1),
          score: signal(0),
          progressPercentage: signal(100),
          isLastQuestion: signal(false),
          registerAnswer,
          advanceQuestion,
        },
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
  return { fixture, registerAnswer, advanceQuestion };
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
