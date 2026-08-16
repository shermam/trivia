import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Answer, TriviaQuestion } from '../models/question.model';
import { GameControllerService } from './game-controller.service';
import { GamePersistenceService } from './game-persistence.service';
import { OfflineDbService } from './offline-db.service';
import { TriviaService } from './trivia.service';

/** Wipes the persisted game between tests, via the service that owns the format. */
async function clearSavedGame(): Promise<void> {
  TestBed.configureTestingModule({});
  await TestBed.inject(GamePersistenceService).clear();
  // Hygiene, not load-bearing: the schema spec uses its own databases. Closing
  // just keeps this file from leaking a connection per test.
  await TestBed.inject(OfflineDbService).close();
  TestBed.resetTestingModule();
}

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
  // These build the service directly and never call `restoreSavedGame()`, so a
  // stray persisted game can't leak in — but the store is cleared anyway so
  // ordering against the persistence suite below can never matter.
  beforeEach(async () => {
    await clearSavedGame();
  });
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
 * back on a fresh service (which is what a reload amounts to), and cleared when
 * the player is done with it.
 *
 * `TestBed.resetTestingModule()` between tests builds a fresh service against
 * the same IndexedDB database, which is exactly the reload being modelled — and
 * the restore is awaited explicitly here, standing in for the app initializer
 * that awaits it during real bootstrap.
 */
describe('GameControllerService persistence (B8)', () => {
  beforeEach(async () => {
    await clearSavedGame();
  });
  afterEach(async () => {
    TestBed.resetTestingModule();
    await clearSavedGame();
  });

  /** Plays a game far enough to have something worth saving, then flushes the persisting effect. */
  async function playAndPersist(questionCount: number, index: number, score: number) {
    const service = setup(questionCount);
    service.config.set({
      amount: questionCount,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });
    service.currentIndex.set(index);
    service.score.set(score);
    TestBed.tick(); // effects are flushed by change detection, not synchronously
    await service.flushPendingWrites();
    return service;
  }

  /** A fresh service that has completed its restore — i.e. the app after a reload. */
  async function reload() {
    TestBed.resetTestingModule();
    const service = setupWithoutQuestions();
    await service.restoreSavedGame();
    return service;
  }

  it('restores an in-progress game into a freshly constructed service', async () => {
    await playAndPersist(10, 3, 2);

    const reloaded = await reload();

    expect(reloaded.totalQuestions()).toBe(10);
    expect(reloaded.currentIndex()).toBe(3);
    expect(reloaded.score()).toBe(2);
    expect(reloaded.currentQuestion()?.id).toBe('q3');
    expect(reloaded.config()?.source).toBe('custom');
  });

  it('offers a resumable game only while it is unfinished', async () => {
    const service = await playAndPersist(10, 3, 2);
    expect(service.hasResumableGame()).toBe(true);

    service.isComplete.set(true);
    expect(service.hasResumableGame()).toBe(false);
  });

  // A completed game is still persisted — refreshing /game-over must not lose
  // the score about to be submitted — but it is not offered as "resume", which
  // would replay and re-score the final question.
  it('still restores a completed game, without offering to resume it', async () => {
    const service = await playAndPersist(5, 4, 3);
    service.isComplete.set(true);
    TestBed.tick();
    await service.flushPendingWrites();

    const reloaded = await reload();

    expect(reloaded.totalQuestions()).toBe(5);
    expect(reloaded.isComplete()).toBe(true);
    expect(reloaded.hasResumableGame()).toBe(false);
  });

  // Flags ride the same record as the score (H4 follow-up). The controller
  // half of that: toggling mutates the signal, the persisting effect picks it
  // up, and a reload gets it back — otherwise game-over would ask for detail
  // about nothing after a refresh, having promised to ask.
  it('carries flagged questions through a reload', async () => {
    const service = await playAndPersist(10, 3, 2);

    service.toggleQuestionFlag('q1');
    service.toggleQuestionFlag('q3');
    TestBed.tick();
    await service.flushPendingWrites();

    expect([...(await reload()).flaggedQuestionIds()]).toEqual(['q1', 'q3']);
  });

  it('toggles a flag off again, and forgets it on reload', async () => {
    const service = await playAndPersist(10, 3, 2);

    service.toggleQuestionFlag('q1');
    expect(service.flaggedQuestionIds().has('q1')).toBe(true);
    service.toggleQuestionFlag('q1');
    expect(service.flaggedQuestionIds().has('q1')).toBe(false);

    TestBed.tick();
    await service.flushPendingWrites();

    expect([...(await reload()).flaggedQuestionIds()]).toEqual([]);
  });

  // Play Again must not carry a previous game's flags into the next one — the
  // ids would be stale, and on a repeat of the same question bank they would
  // not even be obviously stale.
  it('clears flags when the game is reset', async () => {
    const service = await playAndPersist(10, 3, 2);
    service.toggleQuestionFlag('q1');

    service.resetGame();

    expect([...service.flaggedQuestionIds()]).toEqual([]);
  });

  /**
   * ...and `startGame()` has to clear them too, because not every route into a
   * new game passes through `resetGame()`. The top bar's logo is a plain
   * `routerLink="/"`, so a player can abandon a flagged game and start another
   * without "Play Again" or the resume banner's Discard ever running — and a
   * restore on the way (`restoreSavedGame`) puts the old flags back in the
   * signal first. Custom question ids are stable Firestore document ids, so
   * drawing the same question again would render it pre-flagged.
   */
  it('clears flags when a new game starts, not only on Play Again', async () => {
    const abandoned = await playAndPersist(10, 3, 2);
    abandoned.toggleQuestionFlag('q1');
    TestBed.tick();
    await abandoned.flushPendingWrites();

    TestBed.resetTestingModule();
    const fresh = setupWithQuestionSource(3);
    await fresh.restoreSavedGame();
    expect(fresh.flaggedQuestionIds().size).toBeGreaterThan(0); // the leak this guards

    await fresh.startGame({
      amount: 3,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });

    expect([...fresh.flaggedQuestionIds()]).toEqual([]);
    expect(fresh.totalQuestions()).toBe(3);
  });

  it('marks the game complete when advancing past the last question', async () => {
    const service = await playAndPersist(3, 2, 3);
    expect(service.isComplete()).toBe(false);

    service.advanceQuestion();

    expect(service.isComplete()).toBe(true);
    expect(service.currentIndex()).toBe(2); // did not run past the end
  });

  // Writes are queued, so a save already in flight must not land after the
  // delete and resurrect the game the player just threw away.
  it('discarding clears both the state and the saved game', async () => {
    const service = await playAndPersist(10, 3, 2);

    service.discardSavedGame();
    TestBed.tick();
    await service.flushPendingWrites();

    expect(service.totalQuestions()).toBe(0);
    expect(service.hasResumableGame()).toBe(false);

    expect((await reload()).totalQuestions()).toBe(0);
  });

  it('resetGame clears the saved game, so Play Again does not resurrect it', async () => {
    const service = await playAndPersist(10, 3, 2);

    service.resetGame();
    TestBed.tick();
    await service.flushPendingWrites();

    expect((await reload()).totalQuestions()).toBe(0);
  });

  it('saves nothing for a game that was never started', async () => {
    const service = setupWithoutQuestions();
    TestBed.tick();
    await service.flushPendingWrites();

    expect((await reload()).totalQuestions()).toBe(0);
  });

  // The restore is what bootstrap blocks on, so it must resolve even when the
  // store cannot be opened at all — otherwise an unusable IndexedDB (Safari
  // private mode) would hang the whole app rather than one feature.
  it('restores to an empty game, without throwing, when storage is unavailable', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    const service = setupWithoutQuestions();
    await expect(service.restoreSavedGame()).resolves.toBeUndefined();
    expect(service.totalQuestions()).toBe(0);

    vi.restoreAllMocks();
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

/** As above, but `startGame()` actually finds questions, so it runs to completion. */
function setupWithQuestionSource(questionCount: number) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: TriviaService,
        useValue: {
          getQuestions: () =>
            Promise.resolve(Array.from({ length: questionCount }, (_, i) => makeQuestion(`n${i}`))),
        },
      },
      { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
    ],
  });
  return TestBed.inject(GameControllerService);
}
