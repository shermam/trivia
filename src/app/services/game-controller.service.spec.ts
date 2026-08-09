import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Answer, TriviaQuestion } from '../models/question.model';
import { GameControllerService } from './game-controller.service';
import { TriviaService } from './trivia.service';

/**
 * Finding B7. The quiz progress bar divided the zero-based `currentIndex` by
 * the question count, so it was a full question out at every step: 0% while
 * the player looked at question 1, and 90% on the last of ten. It could never
 * reach 100%, because `advanceQuestion()` navigates to the game-over screen
 * instead of incrementing past the end — so the bar's final state was simply
 * never rendered.
 *
 * It also disagreed with the "Question N / M" label sitting directly beside
 * it, which counts from one.
 */

function makeQuestion(id: string): TriviaQuestion {
  const answers: Answer[] = [
    { id: `${id}:correct`, text: 'A', isCorrect: true },
    { id: `${id}:incorrect-0`, text: 'B', isCorrect: false },
  ];
  return {
    id,
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question: `Question ${id}?`,
    correct_answer: 'A',
    incorrect_answers: ['B'],
    all_answers: answers,
    source: 'open_trivia',
  };
}

function setup(questionCount: number) {
  TestBed.configureTestingModule({
    providers: [
      { provide: TriviaService, useValue: { getQuestions: () => Promise.resolve([]) } },
      { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
    ],
  });
  const service = TestBed.inject(GameControllerService);
  service.questions.set(Array.from({ length: questionCount }, (_, i) => makeQuestion(`q${i}`)));
  return service;
}

describe('GameControllerService progress', () => {
  // The service rehydrates a saved game in its constructor (B8), so each test
  // has to start from empty storage or it inherits the previous one's game.
  beforeEach(() => localStorage.clear());
  afterEach(() => TestBed.resetTestingModule());

  it('shows one question of ten as 10%, not 0%', () => {
    const service = setup(10);

    expect(service.currentIndex()).toBe(0);
    expect(service.progressPercentage()).toBe(10);
  });

  // The bar has to agree with the "Question N / M" label beside it, which
  // counts from one — otherwise one of the two is lying at every step.
  it('agrees with the question counter at every step', () => {
    const service = setup(5);

    for (let index = 0; index < 5; index++) {
      service.currentIndex.set(index);
      const label = index + 1;
      expect(service.progressPercentage()).toBe((label / 5) * 100);
    }
  });

  it('is full on the last question, which is as far as the bar ever gets', () => {
    const service = setup(10);
    service.currentIndex.set(9);

    expect(service.isLastQuestion()).toBe(true);
    expect(service.progressPercentage()).toBe(100);
  });

  it('is full immediately for a single-question game', () => {
    const service = setup(1);

    expect(service.progressPercentage()).toBe(100);
  });

  // `/play` redirects when there is no active question, but a computed signal
  // shouldn't produce NaN on the way there — `[style.width.%]="NaN"` is an
  // invalid declaration the browser drops silently.
  it('reports 0 rather than NaN when there are no questions', () => {
    const service = setup(0);

    expect(service.progressPercentage()).toBe(0);
    expect(Number.isNaN(service.progressPercentage())).toBe(false);
  });

  // Guards the neighbouring signal, whose name is one word away: `percentage`
  // is accuracy, `progressPercentage` is position, and they answer different
  // questions.
  it('tracks position, not score', () => {
    const service = setup(10);
    service.currentIndex.set(4);
    service.score.set(1);

    expect(service.progressPercentage()).toBe(50);
    expect(service.percentage()).toBe(10);
  });
});

/**
 * Finding B8. In-flight game state was memory-only, so a refresh lost it. These
 * exercise the controller half: that a game is written as it is played, read
 * back on construction (which is what a reload amounts to), and cleared when
 * the player is done with it.
 *
 * `TestBed.resetTestingModule()` between tests builds a fresh service against
 * the same `localStorage`, which is exactly the reload being modelled.
 */
describe('GameControllerService persistence (B8)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  /** Plays a game far enough to have something worth saving, then flushes the persisting effect. */
  function playAndPersist(questionCount: number, index: number, score: number) {
    const service = setup(questionCount);
    service.config.set({ amount: questionCount, category: '', difficulty: '', source: 'custom' });
    service.currentIndex.set(index);
    service.score.set(score);
    TestBed.tick(); // effects are flushed by change detection, not synchronously
    return service;
  }

  it('restores an in-progress game into a freshly constructed service', () => {
    playAndPersist(10, 3, 2);

    TestBed.resetTestingModule();
    const reloaded = setupWithoutQuestions();

    expect(reloaded.totalQuestions()).toBe(10);
    expect(reloaded.currentIndex()).toBe(3);
    expect(reloaded.score()).toBe(2);
    expect(reloaded.currentQuestion()?.id).toBe('q3');
    expect(reloaded.config()?.source).toBe('custom');
  });

  it('offers a resumable game only while it is unfinished', () => {
    const service = playAndPersist(10, 3, 2);
    expect(service.hasResumableGame()).toBe(true);

    service.isComplete.set(true);
    expect(service.hasResumableGame()).toBe(false);
  });

  // A completed game is still persisted — refreshing /game-over must not lose
  // the score about to be submitted — but it is not offered as "resume", which
  // would replay and re-score the final question.
  it('still restores a completed game, without offering to resume it', () => {
    const service = playAndPersist(5, 4, 3);
    service.isComplete.set(true);
    TestBed.tick();

    TestBed.resetTestingModule();
    const reloaded = setupWithoutQuestions();

    expect(reloaded.totalQuestions()).toBe(5);
    expect(reloaded.isComplete()).toBe(true);
    expect(reloaded.hasResumableGame()).toBe(false);
  });

  it('marks the game complete when advancing past the last question', () => {
    const service = playAndPersist(3, 2, 3);
    expect(service.isComplete()).toBe(false);

    service.advanceQuestion();

    expect(service.isComplete()).toBe(true);
    expect(service.currentIndex()).toBe(2); // did not run past the end
  });

  it('discarding clears both the state and the saved game', () => {
    const service = playAndPersist(10, 3, 2);

    service.discardSavedGame();
    TestBed.tick();

    expect(service.totalQuestions()).toBe(0);
    expect(service.hasResumableGame()).toBe(false);

    TestBed.resetTestingModule();
    expect(setupWithoutQuestions().totalQuestions()).toBe(0);
  });

  it('resetGame clears the saved game, so Play Again does not resurrect it', () => {
    const service = playAndPersist(10, 3, 2);

    service.resetGame();
    TestBed.tick();

    TestBed.resetTestingModule();
    expect(setupWithoutQuestions().totalQuestions()).toBe(0);
  });

  it('saves nothing for a game that was never started', () => {
    setupWithoutQuestions();
    TestBed.tick();

    TestBed.resetTestingModule();
    expect(setupWithoutQuestions().totalQuestions()).toBe(0);
  });
});

/** Builds the service without seeding questions — i.e. exactly what a page load does. */
function setupWithoutQuestions() {
  TestBed.configureTestingModule({
    providers: [
      { provide: TriviaService, useValue: { getQuestions: () => Promise.resolve([]) } },
      { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
    ],
  });
  return TestBed.inject(GameControllerService);
}
