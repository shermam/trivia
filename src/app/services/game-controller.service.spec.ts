import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  ALL_LIFELINES_AVAILABLE,
  Answer,
  GameConfig,
  SKIPPED,
  TIMED_OUT,
  TriviaQuestion,
  answeredWith,
} from '../models/question.model';
import { maxScoreFor } from '../models/scoring';
import { seenKeyFor } from '../utils/seen-key.util';
import { DailyGameLimitService } from './daily-game-limit.service';
import { GameControllerService } from './game-controller.service';
import { GamePersistenceService } from './game-persistence.service';
import { OfflineDbService, SEEN_QUESTIONS_STORE } from './offline-db.service';
import { SeenQuestionsService } from './seen-questions.service';
import { TriviaService } from './trivia.service';

/**
 * A daily allowance that always says yes and never writes.
 *
 * `startGame()` spends one game against `DailyGameLimitService`, and the real
 * service persists that count to IndexedDB — so without this stub these tests
 * were writing five real records into the shared `trivia-offline` database,
 * under today's date, on every run.
 *
 * That mattered because `ng test` runs with **`--isolate` defaulting to
 * false** (see `ng test --help`): spec files share a worker's module registry,
 * so they share one `fake-indexeddb` instance. Whenever this file happened to
 * run before `daily-game-limit.service.spec.ts` in the same worker, that
 * suite's first test opened on a counter already at the limit and failed with
 * `expected +0 to be 5` — a ~40% flake whose cause was in a different file
 * that never mentions the service under test. The general point: with shared
 * isolation, a unit test that touches real storage is not local to its file.
 *
 * Stubbing is also just correct on its own terms. The quota is an unrelated
 * collaborator here; nothing in this file asserts anything about it, and
 * leaving the real one in place means a sixth `startGame()` added to this
 * suite would silently start being refused.
 */
function noDailyLimit() {
  return {
    provide: DailyGameLimitService,
    useValue: {
      isUnlimited: () => true,
      remaining: () => Number.POSITIVE_INFINITY,
      hasGamesLeft: () => true,
      refresh: () => Promise.resolve(),
      consumeGame: () => Promise.resolve(true),
    },
  };
}

/**
 * Wipes the persisted game between tests, via the service that owns the format
 * — and the seen-set with it, which is not hygiene but isolation.
 *
 * Answering a question marks it seen (`FEAT-034`), and `ng test` runs with
 * `--isolate` false, so these writes land in the same `fake-indexeddb`
 * `trivia.service.spec.ts` draws against. Leaving them behind would make that
 * file's question counts depend on which spec ran first, which is the class of
 * cross-file flake the daily-allowance stub above exists to prevent.
 */
async function clearSavedGame(): Promise<void> {
  TestBed.configureTestingModule({});
  await TestBed.inject(GamePersistenceService).clear();
  await clearSeenQuestions();
  // Hygiene, not load-bearing: the schema spec uses its own databases. Closing
  // just keeps this file from leaking a connection per test.
  await TestBed.inject(OfflineDbService).close();
  TestBed.resetTestingModule();
}

async function clearSeenQuestions(): Promise<void> {
  const db = await TestBed.inject(OfflineDbService).open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SEEN_QUESTIONS_STORE, 'readwrite');
    tx.objectStore(SEEN_QUESTIONS_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error as Error);
  });
}

/**
 * Every key the seen-set holds right now, sorted so an assertion is about the
 * set rather than about `getAll()`'s ordering — several marks inside one
 * millisecond carry the same `seenAt`, and the order they come back in is not
 * something this feature promises.
 */
async function readSeenKeys(): Promise<string[]> {
  const seen = await TestBed.inject(SeenQuestionsService).readSeenSet();
  return [...(seen ?? new Map<string, number>()).keys()].sort();
}

/**
 * The seen-set as it settles.
 *
 * `record()` marks fire-and-forget — a quiz must not wait on IndexedDB to
 * register an answer — so a single read taken straight after answering is a
 * race, not an assertion (`CLAUDE.md` §4.6). Retried through `vi.waitFor`,
 * which is the retrying form, and which also fails on the *unexpected extra*
 * mark rather than only on the missing one.
 */
function expectSeenKeys(expected: string[]): Promise<void> {
  return vi.waitFor(async () => expect(await readSeenKeys()).toEqual([...expected].sort()), {
    timeout: 5_000,
    interval: 10,
  });
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
      noDailyLimit(),
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
    service.correctAnswers.set(1);

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
    service.points.set(score);
    service.correctAnswers.set(score);
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

  /*
   * `FEAT-004`. A streak is part of the game a player would be annoyed to lose
   * (`CLAUDE.md` §4.4): eight correct in a row is most of the value of the
   * round, and a reload that reset it to zero would take the multiplier with
   * it. The half point is the part a naive round-trip gets wrong — restoring a
   * rounded 4 as the exact total hands back half a point on every reload — so
   * the game here is played to one on purpose.
   */
  it('carries the streak, the exact total and the correct count through a reload', async () => {
    const service = setup(5);
    service.config.set({
      amount: 5,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });
    for (let index = 0; index < 3; index++) {
      service.registerAnswer(service.questions()[index].all_answers[0]);
    }
    service.currentIndex.set(3);
    TestBed.tick();
    await service.flushPendingWrites();

    expect(service.points()).toBe(3.5);

    const reloaded = await reload();

    expect(reloaded.points()).toBe(3.5);
    expect(reloaded.score()).toBe(4);
    expect(reloaded.correctAnswers()).toBe(3);
    expect(reloaded.currentStreak()).toBe(3);
    expect(reloaded.maxStreak()).toBe(3);
    expect(reloaded.scoreMultiplier()).toBe(1.5);
  });

  // The run continues across the reload rather than restarting: the next
  // correct answer is the fourth in a row and still earns 1.5x.
  it('goes on scoring the restored run at the tier it was on', async () => {
    const service = setup(5);
    service.config.set({
      amount: 5,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });
    for (let index = 0; index < 3; index++) {
      service.registerAnswer(service.questions()[index].all_answers[0]);
    }
    service.currentIndex.set(3);
    TestBed.tick();
    await service.flushPendingWrites();

    const reloaded = await reload();
    reloaded.registerAnswer(reloaded.questions()[3].all_answers[0]);

    expect(reloaded.currentStreak()).toBe(4);
    expect(reloaded.points()).toBe(5);
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

  // The recap's half of the same reload problem the flags above have. A
  // completed game is deliberately kept so the score survives a refresh of
  // `/game-over`; a recap that emptied while the score stayed would be the
  // same defect one screen along.
  it('carries the answer history through a reload', async () => {
    const service = await playAndPersist(3, 2, 2);
    service.registerAnswer(service.questions()[0].all_answers[0]); // correct
    service.registerAnswer(null); // timed out
    service.registerAnswer(service.questions()[2].all_answers[1]); // wrong
    TestBed.tick();
    await service.flushPendingWrites();

    expect((await reload()).answerHistory()).toEqual([
      answeredWith('q0:correct'),
      TIMED_OUT,
      answeredWith('q2:incorrect-0'),
    ]);
  });

  it('clears the answer history when the game is reset', async () => {
    const service = await playAndPersist(10, 3, 2);
    service.registerAnswer(service.questions()[0].all_answers[0]);

    service.resetGame();

    expect(service.answerHistory()).toEqual([]);
  });

  // Same leak as the flags, and worse: `routerLink="/"` starts a new game
  // without passing through `resetGame()`, and `restoreSavedGame()` puts the
  // old history back into the signal on the way. Left there, the recap would
  // render the abandoned game's answers underneath the new game's score.
  it('clears the answer history when a new game starts, not only on Play Again', async () => {
    const abandoned = await playAndPersist(10, 3, 2);
    abandoned.registerAnswer(abandoned.questions()[0].all_answers[0]);
    TestBed.tick();
    await abandoned.flushPendingWrites();

    TestBed.resetTestingModule();
    const fresh = setupWithQuestionSource(3);
    await fresh.restoreSavedGame();
    expect(fresh.answerHistory().length).toBeGreaterThan(0); // the leak this guards

    await fresh.startGame({
      amount: 3,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });

    expect(fresh.answerHistory()).toEqual([]);
  });

  /*
   * `gameId` — the idempotency key behind `users/{uid}`. It has to survive a
   * reload, because the reload is exactly the case it exists for: `/game-over`
   * is deliberately kept restorable so the score about to be submitted is not
   * lost, and a fresh id on each refresh would bank the same game again every
   * time.
   */
  it('carries the game id through a reload', async () => {
    const service = await playAndPersist(10, 3, 2);
    service.gameId.set('game-xyz');
    TestBed.tick();
    await service.flushPendingWrites();

    expect((await reload()).gameId()).toBe('game-xyz');
  });

  it('clears the game id when the game is reset', async () => {
    const service = await playAndPersist(10, 3, 2);
    service.gameId.set('game-xyz');

    service.resetGame();

    expect(service.gameId()).toBeNull();
  });

  // Minted at start, not at game-over — and a *new* one each time, or two
  // games in a session would collide and the second would never be banked.
  it('mints a fresh game id for each new game', async () => {
    TestBed.resetTestingModule();
    const service = setupWithQuestionSource(3);
    const config: GameConfig = {
      amount: 3,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    };

    await service.startGame(config);
    const first = service.gameId();
    await service.startGame(config);
    const second = service.gameId();

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  // Reproduces the e2e failure: choosing "no limit" and reloading must not
  // silently move the player onto a different board.
  it('carries an unlimited time limit through a reload', async () => {
    const service = await playAndPersist(10, 3, 2);
    service.config.set({
      amount: 10,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 'unlimited',
    });
    TestBed.tick();
    await service.flushPendingWrites();

    expect((await reload()).config()?.timeLimit).toBe('unlimited');
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
      noDailyLimit(),
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
      noDailyLimit(),
    ],
  });
  return TestBed.inject(GameControllerService);
}

/**
 * `FEAT-001`. The recap is built entirely from this array, so what matters is
 * that it stays *positional* — entry `i` is the answer to question `i` — and
 * that a timeout is stored as something other than a wrong answer. Before this
 * feature `registerAnswer` took a `boolean`, which made those two cases
 * identical the moment they left the quiz component.
 */
describe('GameControllerService answer history (FEAT-001)', () => {
  beforeEach(async () => {
    await clearSavedGame();
  });
  afterEach(() => TestBed.resetTestingModule());

  it('accumulates one entry per answer, in order', () => {
    const service = setup(3);
    const [q0, q1, q2] = service.questions();

    service.registerAnswer(q0.all_answers[0]); // correct
    service.registerAnswer(q1.all_answers[1]); // wrong
    service.registerAnswer(q2.all_answers[0]); // correct

    expect(service.answerHistory()).toEqual([
      answeredWith('q0:correct'),
      answeredWith('q1:incorrect-0'),
      answeredWith('q2:correct'),
    ]);
    expect(service.score()).toBe(2);
  });

  // The distinction the old `boolean` signature could not carry: both of these
  // score zero, and the recap has to show one as "No answer / Time expired"
  // and the other as the option the player actually picked.
  it('distinguishes a timeout from a wrong answer', () => {
    const service = setup(2);

    service.registerAnswer(null);
    service.registerAnswer(service.questions()[1].all_answers[1]);

    expect(service.answerHistory()).toEqual([TIMED_OUT, answeredWith('q1:incorrect-0')]);
    expect(service.score()).toBe(0);
  });

  // Two options carrying the same *text* must still be told apart — storing
  // the display string instead of the id is the shape of the bug in
  // `CLAUDE.md` §4.4, and it would land here first.
  it('records the picked option by id, not by its text', () => {
    const service = setup(1);
    const question = service.questions()[0];
    question.all_answers[1].text = question.all_answers[0].text;

    service.registerAnswer(question.all_answers[1]);

    expect(service.answerHistory()).toEqual([answeredWith('q0:incorrect-0')]);
    expect(service.score()).toBe(0);
  });

  it('starts empty, so a game with no answers yet has no recap to render', () => {
    expect(setup(5).answerHistory()).toEqual([]);
  });

  // A replaced array rather than a mutated one, or `computed`s downstream of
  // it never re-run and the recap renders the state before the last answer.
  it('replaces the array rather than mutating it', () => {
    const service = setup(2);
    const before = service.answerHistory();

    service.registerAnswer(service.questions()[0].all_answers[0]);

    expect(service.answerHistory()).not.toBe(before);
    expect(before).toEqual([]);
  });
});

/**
 * `FEAT-004`. The streak and the multiplier live here rather than in the quiz
 * component for the same reason the answer history does — they have to survive
 * a reload — and the arithmetic lives in `models/scoring.ts`, which is tested
 * on its own. What is worth pinning *here* is the bookkeeping: which outcomes
 * move the run, which reset it, and the fact that `score`, `correctAnswers` and
 * `percentage` are now three different answers to three different questions.
 */
describe('GameControllerService streaks and multipliers (FEAT-004)', () => {
  beforeEach(async () => {
    await clearSavedGame();
  });
  afterEach(() => TestBed.resetTestingModule());

  /** Answers question `index` right or wrong, as the quiz component would. */
  function answer(service: GameControllerService, index: number, correct: boolean): void {
    const question = service.questions()[index];
    service.registerAnswer(question.all_answers[correct ? 0 : 1]);
  }

  it('starts at no streak and no multiplier bonus', () => {
    const service = setup(5);

    expect(service.currentStreak()).toBe(0);
    expect(service.maxStreak()).toBe(0);
    expect(service.scoreMultiplier()).toBe(1);
  });

  it('extends the run on each correct answer', () => {
    const service = setup(5);

    answer(service, 0, true);
    answer(service, 1, true);

    expect(service.currentStreak()).toBe(2);
    expect(service.maxStreak()).toBe(2);
  });

  it('resets the run on a wrong answer, keeping the best', () => {
    const service = setup(5);

    answer(service, 0, true);
    answer(service, 1, true);
    answer(service, 2, false);

    expect(service.currentStreak()).toBe(0);
    expect(service.maxStreak()).toBe(2);
  });

  // A timeout is a different outcome for the recap and the same one for the
  // streak — `registerAnswer(null)` is how the quiz reports the clock running
  // out, and it must not be mistaken for "no answer, no harm done".
  it('resets the run on a timeout too', () => {
    const service = setup(5);

    answer(service, 0, true);
    service.registerAnswer(null);

    expect(service.currentStreak()).toBe(0);
    expect(service.maxStreak()).toBe(1);
  });

  /*
   * **A skip neither breaks nor extends the run**, which is the one rule here
   * that cannot be recovered from the answer history afterwards: a skip shows
   * up there as a question nobody got right. Pinned in both directions — the
   * run survives it, and the skip does not itself count towards it.
   */
  it('leaves the run untouched when a question is skipped', () => {
    const service = setup(5);

    answer(service, 0, true);
    answer(service, 1, true);
    service.registerSkippedQuestion();
    answer(service, 3, true);

    expect(service.currentStreak()).toBe(3);
    expect(service.maxStreak()).toBe(3);
    expect(service.correctAnswers()).toBe(3);
  });

  it('scores a plain run at one point per answer', () => {
    const service = setup(5);

    answer(service, 0, true);
    answer(service, 1, true);

    expect(service.points()).toBe(2);
    expect(service.score()).toBe(2);
  });

  /*
   * The third consecutive correct answer is the first to earn 1.5×, and the
   * half point it produces is exactly why `points` is kept apart from `score`.
   * Both are asserted: the exact total, and the integer the board would get.
   */
  it('applies the 1.5x tier from the third answer in a row', () => {
    const service = setup(5);

    answer(service, 0, true);
    answer(service, 1, true);
    answer(service, 2, true);

    expect(service.scoreMultiplier()).toBe(1.5);
    expect(service.points()).toBe(3.5);
    expect(service.score()).toBe(4);
  });

  it('scores a perfect five-question run above its question count', () => {
    const service = setup(5);

    for (let index = 0; index < 5; index++) {
      answer(service, index, true);
    }

    // 1 + 1 + 1.5 + 1.5 + 2
    expect(service.points()).toBe(7);
    expect(service.score()).toBe(7);
    expect(service.correctAnswers()).toBe(5);
  });

  /*
   * **Accuracy is never multiplied.** This is the assertion that stops a
   * leaderboard entry claiming 140%: `percentage` is built from the correct
   * answers, and the rules refuse anything above 100 regardless.
   */
  it('reports accuracy from the correct answers, not from the score', () => {
    const service = setup(5);

    for (let index = 0; index < 5; index++) {
      answer(service, index, true);
    }

    expect(service.score()).toBe(7);
    expect(service.percentage()).toBe(100);
  });

  it('reports partial accuracy from the correct answers alone', () => {
    const service = setup(10);

    answer(service, 0, true);
    answer(service, 1, true);
    answer(service, 2, true);
    answer(service, 3, true);

    expect(service.correctAnswers()).toBe(4);
    expect(service.percentage()).toBe(40);
    expect(service.score()).toBeGreaterThan(4);
  });

  /*
   * **The two-ends rule** (`CLAUDE.md` §4.1, and `FEAT-004` §0). The client
   * must never produce a score `firestore.rules` will refuse, because the
   * refusal arrives as a bare `permission-denied` that nothing can honestly
   * explain to the player. Walked over every game length the setup screen
   * offers, playing the best round each one allows.
   */
  it('cannot produce a score above the ceiling the rules enforce', () => {
    for (const questions of [5, 10, 15, 20, 25]) {
      const service = setup(questions);
      for (let index = 0; index < questions; index++) {
        answer(service, index, true);
      }

      expect(service.score()).toBeLessThanOrEqual(maxScoreFor(questions));
      expect(service.percentage()).toBeLessThanOrEqual(100);
      TestBed.resetTestingModule();
    }
  });

  // Starting a fresh game must not inherit the previous one's run — a player
  // who abandoned a game eight correct answers in would otherwise open the
  // next one already at 3x.
  it('starts a new game with no streak carried over', async () => {
    const service = setupWithQuestionSource(3);
    service.questions.set([makeQuestion('old')]);
    service.registerAnswer(service.questions()[0].all_answers[0]);

    await service.startGame({
      amount: 3,
      category: '',
      difficulty: '',
      source: 'open_trivia',
      timeLimit: 15,
    });

    expect(service.currentStreak()).toBe(0);
    expect(service.maxStreak()).toBe(0);
    expect(service.points()).toBe(0);
    expect(service.correctAnswers()).toBe(0);
  });

  it('clears the streak when a saved game is discarded', () => {
    const service = setup(5);
    answer(service, 0, true);

    service.discardSavedGame();

    expect(service.currentStreak()).toBe(0);
    expect(service.maxStreak()).toBe(0);
    expect(service.points()).toBe(0);
    expect(service.correctAnswers()).toBe(0);
  });
});

/**
 * `FEAT-002`. The service owns *availability* — which lifelines are left, and
 * which options 50/50 removed — because both have to survive a reload. The
 * timer itself stays in `QuizLoopComponent`, so Extra Time is only a
 * `consumeLifeline` call here; the deadline arithmetic is tested there.
 */
describe('GameControllerService lifelines (FEAT-002)', () => {
  beforeEach(async () => {
    await clearSavedGame();
  });
  afterEach(() => TestBed.resetTestingModule());

  it('starts a game with all three available', () => {
    expect(setup(3).lifelines()).toEqual(ALL_LIFELINES_AVAILABLE);
  });

  it('spends a lifeline once and refuses the second attempt', () => {
    const service = setup(3);

    expect(service.consumeLifeline('skip')).toBe(true);
    expect(service.lifelines().skip).toBe(false);
    expect(service.consumeLifeline('skip')).toBe(false);
  });

  it('spends only the lifeline named', () => {
    const service = setup(3);

    service.consumeLifeline('extraTime');

    expect(service.lifelines()).toEqual({ fiftyFifty: true, extraTime: false, skip: true });
  });

  // Two removals on a four-option question, leaving the correct answer and one
  // wrong one — the classic 50/50.
  it('removes two wrong options from a four-option question', () => {
    const service = setup(1);
    const question = service.questions()[0];
    question.all_answers = [
      { id: 'a', text: 'A', isCorrect: true },
      { id: 'b', text: 'B', isCorrect: false },
      { id: 'c', text: 'C', isCorrect: false },
      { id: 'd', text: 'D', isCorrect: false },
    ];

    expect(service.useFiftyFifty()).toBe(true);

    const eliminated = service.eliminatedAnswerIds();
    expect(eliminated).toHaveLength(2);
    expect(eliminated).not.toContain('a'); // never the correct one
  });

  it('removes one from a three-option question, still leaving a choice', () => {
    const service = setup(1);
    const question = service.questions()[0];
    question.all_answers = [
      { id: 'a', text: 'A', isCorrect: true },
      { id: 'b', text: 'B', isCorrect: false },
      { id: 'c', text: 'C', isCorrect: false },
    ];

    expect(service.useFiftyFifty()).toBe(true);
    expect(service.eliminatedAnswerIds()).toHaveLength(1);
  });

  /*
   * **Deliberately not what the spec says.** "Fewer than 4 choices → remove 1"
   * applied to true/false removes the only wrong answer and hands over the
   * correct one — a free point, not a 50/50. The rule is
   * `min(2, wrongAnswers - 1)`, so a two-option question yields nothing and the
   * lifeline is not spent.
   */
  it('does nothing on a true/false question, and does not spend the lifeline', () => {
    const service = setup(1);
    const question = service.questions()[0];
    question.all_answers = [
      { id: 'a', text: 'True', isCorrect: true },
      { id: 'b', text: 'False', isCorrect: false },
    ];

    expect(service.useFiftyFifty()).toBe(false);
    expect(service.eliminatedAnswerIds()).toEqual([]);
    expect(service.lifelines().fiftyFifty).toBe(true); // still spendable elsewhere
  });

  it('refuses a second 50/50 on the same question', () => {
    const service = setup(2);
    service.questions()[0].all_answers = [
      { id: 'a', text: 'A', isCorrect: true },
      { id: 'b', text: 'B', isCorrect: false },
      { id: 'c', text: 'C', isCorrect: false },
    ];

    expect(service.useFiftyFifty()).toBe(true);
    expect(service.useFiftyFifty()).toBe(false);
  });

  // The eliminated ids belong to one question. Carried forward they would grey
  // out options on a question 50/50 was never used on.
  it('clears the eliminated options when the question advances', () => {
    const service = setup(3);
    service.questions()[0].all_answers = [
      { id: 'a', text: 'A', isCorrect: true },
      { id: 'b', text: 'B', isCorrect: false },
      { id: 'c', text: 'C', isCorrect: false },
    ];
    service.useFiftyFifty();
    expect(service.eliminatedAnswerIds()).not.toEqual([]);

    service.advanceQuestion();

    expect(service.eliminatedAnswerIds()).toEqual([]);
    expect(service.lifelines().fiftyFifty).toBe(false); // spent for the round, though
  });

  /*
   * The security-relevant one, decided explicitly with the owner on 28 August
   * 2026. Every bound `firestore.rules` puts on an entry scales with
   * `totalQuestions` — the score ceiling and the accuracy it will accept alike
   * — so if a skip shrank the denominator, skipping nine of ten and answering
   * one would post a well-formed 100%.
   */
  it('counts a skipped question toward the total, so skipping cannot inflate accuracy', () => {
    const service = setup(10);
    service.registerAnswer(service.questions()[0].all_answers[0]); // 1 correct
    for (let i = 0; i < 9; i++) {
      service.registerSkippedQuestion();
    }

    expect(service.score()).toBe(1);
    expect(service.totalQuestions()).toBe(10);
    expect(service.percentage()).toBe(10); // not 100
  });

  it('records a skip as its own outcome, distinct from a timeout', () => {
    const service = setup(2);

    service.registerSkippedQuestion();
    service.registerAnswer(null);

    expect(service.answerHistory()).toEqual([SKIPPED, TIMED_OUT]);
    expect(service.score()).toBe(0);
  });

  it('carries spent lifelines through a reload, so refreshing does not refund one', async () => {
    const service = setup(3);
    service.config.set({
      amount: 3,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });
    service.consumeLifeline('skip');
    service.consumeLifeline('extraTime');
    TestBed.tick();
    await service.flushPendingWrites();

    TestBed.resetTestingModule();
    const reloaded = setupWithoutQuestions();
    await reloaded.restoreSavedGame();

    expect(reloaded.lifelines()).toEqual({ fiftyFifty: true, extraTime: false, skip: false });
  });

  it('restores all three when a new game starts', async () => {
    const abandoned = setup(3);
    abandoned.config.set({
      amount: 3,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });
    abandoned.consumeLifeline('skip');
    TestBed.tick();
    await abandoned.flushPendingWrites();

    TestBed.resetTestingModule();
    const fresh = setupWithQuestionSource(3);
    await fresh.restoreSavedGame();
    expect(fresh.lifelines().skip).toBe(false); // the leak this guards

    await fresh.startGame({
      amount: 3,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });

    expect(fresh.lifelines()).toEqual(ALL_LIFELINES_AVAILABLE);
  });

  it('clears lifelines on resetGame, so Play Again starts fresh', () => {
    const service = setup(3);
    service.consumeLifeline('skip');

    service.resetGame();

    expect(service.lifelines()).toEqual(ALL_LIFELINES_AVAILABLE);
  });
});

/**
 * `FEAT-034`. A question counts as *seen* the moment it resolves — and only
 * then.
 *
 * The four outcomes are the whole contract: a correct answer, a wrong one, a
 * timeout and a skip all mean the player read the question, so all four mark
 * it. Drawing a question and never reaching it does not, which is what keeps a
 * closed tab from silently burning questions nobody was shown.
 *
 * Driven through the controller rather than through `SeenQuestionsService`
 * directly, because the thing that can regress is the wiring: the mark lives
 * at `record()`, the one funnel all four outcomes pass through, and a fifth
 * outcome added past it would be silently unmarked.
 */
describe('GameControllerService seen-set (FEAT-034)', () => {
  beforeEach(async () => {
    await clearSavedGame();
  });
  afterEach(async () => {
    // Reset first: `clearSavedGame` configures a module of its own, which the
    // TestBed refuses while this test's is still instantiated.
    TestBed.resetTestingModule();
    await clearSavedGame();
  });

  it('marks a question answered correctly', async () => {
    const service = setup(2);
    const question = service.questions()[0];

    service.registerAnswer(question.all_answers[0]);

    await expectSeenKeys([seenKeyFor(question)]);
  });

  it('marks a question answered wrongly', async () => {
    const service = setup(2);
    const question = service.questions()[0];

    service.registerAnswer(question.all_answers[1]);

    await expectSeenKeys([seenKeyFor(question)]);
  });

  it('marks a question the clock ran out on', async () => {
    const service = setup(2);
    const question = service.questions()[0];

    service.registerAnswer(null);

    await expectSeenKeys([seenKeyFor(question)]);
  });

  it('marks a question the player skipped', async () => {
    const service = setup(2);
    const question = service.questions()[0];

    service.registerSkippedQuestion();

    await expectSeenKeys([seenKeyFor(question)]);
  });

  it('marks each question of a round exactly once, as it resolves', async () => {
    const service = setup(3);
    const [first, second, third] = service.questions();

    service.registerAnswer(first.all_answers[0]);
    service.advanceQuestion();
    service.registerSkippedQuestion();
    service.advanceQuestion();
    service.registerAnswer(null);

    await expectSeenKeys([seenKeyFor(first), seenKeyFor(second), seenKeyFor(third)]);
  });

  /**
   * The case the "mark at answer" decision exists for: a player who opens a
   * game and walks away has not been shown anything, and a seen-set that
   * counted the draw would spend the bank on questions nobody read.
   */
  it('marks nothing when a game is drawn and abandoned unanswered', async () => {
    const service = setup(3);

    service.advanceQuestion();
    service.advanceQuestion();
    service.resetGame();

    // Given a moment to be wrong in: the mark is fire-and-forget, so asserting
    // an absence immediately would pass against a mark that simply had not
    // landed yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readSeenKeys()).toEqual([]);
  });
});

/**
 * `FEAT-021`. A topic-filtered draw that comes back with fewer questions than
 * were asked for says so and waits, rather than starting a shorter round
 * without mentioning it.
 *
 * **The scoping is what these rows are really about.** A short draw has always
 * been possible — a rare category, a narrow difficulty, a small bank — and
 * interrupting those would change behaviour this feature has no business
 * changing. The bank being mostly untagged is what makes a tag filter
 * different in kind: coming back short is the *expected* result there rather
 * than an unlucky one, and a player has no way to know that unless told.
 */
describe('GameControllerService — a short tag-filtered draw (FEAT-021)', () => {
  function config(overrides: Partial<GameConfig> = {}): GameConfig {
    return {
      amount: 10,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
      ...overrides,
    };
  }

  function setupDraw(found: number) {
    const questions = Array.from({ length: found }, (_, i) => makeQuestion(`t${i}`));
    const getQuestions = vi.fn(() => Promise.resolve(questions));
    const navigateByUrl = vi.fn(() => Promise.resolve(true));
    const consumeGame = vi.fn(() => Promise.resolve(true));

    TestBed.configureTestingModule({
      providers: [
        { provide: TriviaService, useValue: { getQuestions } },
        { provide: Router, useValue: { navigateByUrl } },
        {
          provide: DailyGameLimitService,
          useValue: {
            isUnlimited: () => true,
            remaining: () => Number.POSITIVE_INFINITY,
            hasGamesLeft: () => true,
            refresh: () => Promise.resolve(),
            consumeGame,
          },
        },
      ],
    });

    return {
      service: TestBed.inject(GameControllerService),
      getQuestions,
      navigateByUrl,
      consumeGame,
    };
  }

  beforeEach(async () => {
    await clearSavedGame();
  });
  afterEach(async () => {
    TestBed.resetTestingModule();
    await clearSavedGame();
  });

  it('reports how many were found and does not start the game', async () => {
    const { service, navigateByUrl, consumeGame } = setupDraw(3);

    await service.startGame(config({ tags: ['world-war-2'] }));

    expect(service.shortDraw()).toEqual({ found: 3, asked: 10 });
    expect(navigateByUrl).not.toHaveBeenCalled();
    // ...and the day's allowance is untouched, so being told costs nothing.
    expect(consumeGame).not.toHaveBeenCalled();
  });

  it('plays the questions it already found when Start is pressed again', async () => {
    const { service, getQuestions, navigateByUrl } = setupDraw(3);
    const selection = config({ tags: ['world-war-2'] });

    await service.startGame(selection);
    await service.startGame(selection);

    expect(service.shortDraw()).toBeNull();
    expect(service.questions()).toHaveLength(3);
    expect(navigateByUrl).toHaveBeenCalledWith('/play');
    // Nothing was drawn twice: saying how many were found costs no extra read,
    // and a second draw could come back a different size and make the message
    // that prompted the confirmation false.
    expect(getQuestions).toHaveBeenCalledTimes(1);
  });

  it('draws again when the player changes the selection instead of confirming', async () => {
    const { service, getQuestions } = setupDraw(3);

    await service.startGame(config({ tags: ['world-war-2'] }));
    await service.startGame(config({ tags: ['world-war-2', 'treaties'] }));

    expect(getQuestions).toHaveBeenCalledTimes(2);
    // Short again, so it asks again rather than applying a confirmation the
    // player gave about a different selection.
    expect(service.shortDraw()).toEqual({ found: 3, asked: 10 });
  });

  it('says nothing when the filtered draw is full', async () => {
    const { service, navigateByUrl } = setupDraw(10);

    await service.startGame(config({ tags: ['world-war-2'] }));

    expect(service.shortDraw()).toBeNull();
    expect(navigateByUrl).toHaveBeenCalledWith('/play');
  });

  /**
   * The additive half. A short draw with no filter is behaviour the app has
   * always had — a rare category simply plays short — and this feature must not
   * have put a confirmation in front of it.
   */
  it('never interrupts an unfiltered draw, however short it comes back', async () => {
    const { service, navigateByUrl } = setupDraw(2);

    await service.startGame(config());

    expect(service.shortDraw()).toBeNull();
    expect(service.questions()).toHaveLength(2);
    expect(navigateByUrl).toHaveBeenCalledWith('/play');
  });

  it('reports an empty filtered draw as no questions rather than as a short one', async () => {
    const { service } = setupDraw(0);

    await service.startGame(config({ tags: ['world-war-2'] }));

    expect(service.shortDraw()).toBeNull();
    expect(service.loadError()).toContain('No questions were found');
  });

  it('clears a stale notice when the next draw is fine', async () => {
    const { service } = setupDraw(3);
    await service.startGame(config({ tags: ['world-war-2'] }));
    expect(service.shortDraw()).not.toBeNull();

    await service.startGame(config({ amount: 3, tags: ['world-war-2'] }));

    expect(service.shortDraw()).toBeNull();
  });

  /**
   * Withdrawing the notice does not throw the draw away. The setup screen calls
   * this on every edit, and reverting an edit is a thing readers do — so the
   * held questions have to survive it, or a reader who added a topic and
   * removed it again would pay for a second draw of the same selection.
   */
  it('withdraws the notice without discarding the draw it described', async () => {
    const { service, getQuestions, navigateByUrl } = setupDraw(3);
    await service.startGame(config({ tags: ['world-war-2'] }));

    service.clearShortDrawNotice();
    expect(service.shortDraw()).toBeNull();

    await service.startGame(config({ tags: ['world-war-2'] }));

    expect(getQuestions).toHaveBeenCalledTimes(1);
    expect(service.questions()).toHaveLength(3);
    expect(navigateByUrl).toHaveBeenCalledWith('/play');
  });
});
