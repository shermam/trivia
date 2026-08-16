import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { GameConfig, TriviaQuestion } from '../models/question.model';
import { GamePersistenceService } from './game-persistence.service';
import { CURRENT_GAME_KEY, GAME_STATE_STORE, OfflineDbService } from './offline-db.service';

/**
 * Finding B8. An in-progress game lived only in signals, so a reload, a tab
 * crash or a PWA relaunch threw it away — worst for exactly the offline/mobile
 * players the offline pool exists to serve.
 *
 * These cover the storage layer on its own: what survives a round trip, and
 * what is refused. The refusals matter as much as the happy path — the database
 * outlives deploys, so this code is guaranteed to be handed shapes written by
 * an older build, and an exception here happens during bootstrap, which
 * white-screens the app rather than merely losing a game.
 */

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Writes straight to the store, bypassing the service, to plant a hostile or legacy record. */
function putRaw(record: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('trivia-offline'); // no version: whatever the service created
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(GAME_STATE_STORE, 'readwrite');
      tx.objectStore(GAME_STATE_STORE).put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error as Error);
      };
    };
    open.onerror = () => reject(open.error as Error);
  });
}

function makeQuestion(id: string): TriviaQuestion {
  return {
    id,
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question: `Question ${id}?`,
    correct_answer: 'A',
    incorrect_answers: ['B'],
    all_answers: [
      { id: `${id}:correct`, text: 'A', isCorrect: true },
      { id: `${id}:incorrect-0`, text: 'B', isCorrect: false },
    ],
    source: 'open_trivia',
  };
}

const config: GameConfig = {
  amount: 2,
  category: '',
  difficulty: '',
  source: 'open_trivia',
  timeLimit: 15,
};

function makeGame(overrides: Partial<Parameters<GamePersistenceService['save']>[0]> = {}) {
  return {
    config,
    questions: [makeQuestion('q0'), makeQuestion('q1')],
    currentIndex: 1,
    score: 1,
    isComplete: false,
    flaggedQuestionIds: [],
    ...overrides,
  };
}

/** A complete, valid stored record — the base for the rejection cases below. */
function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: CURRENT_GAME_KEY,
    version: 1,
    savedAt: Date.now(),
    config,
    questions: [makeQuestion('q0')],
    currentIndex: 0,
    score: 0,
    isComplete: false,
    ...overrides,
  };
}

describe('GamePersistenceService (B8)', () => {
  let service: GamePersistenceService;

  beforeEach(async () => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(GamePersistenceService);
    await service.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.clear();
    // Hygiene, not load-bearing: the schema spec works on databases of its
    // own, so nothing here can block it. Closing still keeps this file from
    // leaking a connection per test.
    await TestBed.inject(OfflineDbService).close();
    TestBed.resetTestingModule();
  });

  it('round-trips a saved game', async () => {
    await service.save(makeGame());

    const loaded = await service.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.currentIndex).toBe(1);
    expect(loaded?.score).toBe(1);
    expect(loaded?.isComplete).toBe(false);
    expect(loaded?.questions).toHaveLength(2);
    // The shuffled option order is part of the game, not re-derived on resume.
    expect(loaded?.questions[0].all_answers.map((a) => a.id)).toEqual([
      'q0:correct',
      'q0:incorrect-0',
    ]);
    expect(loaded?.config).toEqual(config);
  });

  it('returns null when nothing is stored', async () => {
    expect(await service.load()).toBeNull();
  });

  // The flag is a promise — "you'll be asked for details at the end of the
  // game" — so a reload that dropped it would break that promise with nothing
  // on screen to say so. It rides the same record as the score.
  it('round-trips which questions were flagged for reporting', async () => {
    await service.save(makeGame({ flaggedQuestionIds: ['q1'] }));

    expect((await service.load())?.flaggedQuestionIds).toEqual(['q1']);
  });

  // `flaggedQuestionIds` was added *without* bumping SCHEMA_VERSION, on the
  // grounds that the addition is purely additive — so a record written by the
  // previous build has to keep restoring, or that reasoning was wrong and
  // every in-progress game is discarded on deploy instead.
  it('restores a record written before the field existed', async () => {
    await putRaw(validRecord()); // validRecord() deliberately omits the field

    const loaded = await service.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.flaggedQuestionIds).toEqual([]);
  });

  /*
   * The chosen time limit rides the same record (G7). It has to: it decides
   * which leaderboard the finished game ranks on, so a reload that silently
   * reset it to 15 would publish the score to the wrong board.
   */
  it('round-trips the chosen time limit', async () => {
    await service.save(makeGame({ config: { ...config, timeLimit: 'unlimited' } }));

    expect((await service.load())?.config.timeLimit).toBe('unlimited');
  });

  // Same call as flaggedQuestionIds: additive, unambiguous default, so no
  // SCHEMA_VERSION bump and no in-progress game thrown away on deploy.
  it('defaults a pre-G7 save to 15 seconds, the only limit it could have been', async () => {
    // A genuine pre-G7 record: the field simply is not there. Reusing the
    // shared `config` fixture would pass for the wrong reason, since that one
    // now carries timeLimit: 15 of its own.
    const { timeLimit: _absent, ...preG7Config } = config;
    await putRaw(validRecord({ config: preG7Config }));

    const loaded = await service.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.config.timeLimit).toBe(15);
  });

  it('refuses a config naming a time limit that is not an option', async () => {
    await putRaw(validRecord({ config: { ...config, timeLimit: 99 } }));

    expect(await service.load()).toBeNull();
  });

  // Dropped, not fatal: a flag is a hint about a question, and losing one is
  // not worth losing the game it belongs to.
  it.each([
    ['ids with no matching question', ['q0', 'nope'], ['q0']],
    ['non-string entries', ['q0', 42, null], ['q0']],
    ['a non-array value', 'q0', []],
  ])('discards %s without rejecting the save', async (_label, stored, expected) => {
    await putRaw(validRecord({ flaggedQuestionIds: stored }));

    const loaded = await service.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.flaggedQuestionIds).toEqual(expected);
  });

  it('overwrites rather than accumulating — there is only ever one game', async () => {
    await service.save(makeGame({ currentIndex: 0, score: 0 }));
    await service.save(makeGame({ currentIndex: 1, score: 1 }));

    expect((await service.load())?.currentIndex).toBe(1);
  });

  it('clear() removes the saved game', async () => {
    await service.save(makeGame());
    await service.clear();
    expect(await service.load()).toBeNull();
  });

  it('discards a game older than the 6h TTL', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await service.save(makeGame());

    vi.spyOn(Date, 'now').mockReturnValue(now + SIX_HOURS_MS + 1);
    expect(await service.load()).toBeNull();
    // ...and drops it, so it isn't re-examined on every subsequent load.
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(await service.load()).toBeNull();
  });

  it('keeps a game inside the TTL', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await service.save(makeGame());

    vi.spyOn(Date, 'now').mockReturnValue(now + SIX_HOURS_MS - 1000);
    expect(await service.load()).not.toBeNull();
  });

  it('keeps a game whose timestamp is in the future (clock moved backwards)', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await service.save(makeGame());

    vi.spyOn(Date, 'now').mockReturnValue(now - 60 * 60 * 1000);
    expect(await service.load()).not.toBeNull();
  });

  it.each([
    ['a future schema version', validRecord({ version: 99 })],
    ['an empty question list', validRecord({ questions: [] })],
    ['a currentIndex past the end', validRecord({ currentIndex: 5 })],
    ['a negative currentIndex', validRecord({ currentIndex: -1 })],
    ['a score above the question count', validRecord({ score: 99 })],
    ['a malformed question', validRecord({ questions: [{ id: 'q0' }] })],
    ['an unknown source', validRecord({ config: { ...config, source: 'wikipedia' } })],
    ['an unknown difficulty', validRecord({ config: { ...config, difficulty: 'trivial' } })],
    ['a non-numeric savedAt', validRecord({ savedAt: 'yesterday' })],
  ])('refuses %s', async (_label, record) => {
    await putRaw(record);
    expect(await service.load()).toBeNull();
  });

  it('survives a store that cannot be opened at all', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    // Losing the ability to persist must not take the game down with it.
    expect(await service.load()).toBeNull();
    await expect(service.save(makeGame())).resolves.toBeUndefined();
    await expect(service.clear()).resolves.toBeUndefined();
  });
});
