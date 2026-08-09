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

const config: GameConfig = { amount: 2, category: '', difficulty: '', source: 'open_trivia' };

function makeGame(overrides: Partial<Parameters<GamePersistenceService['save']>[0]> = {}) {
  return {
    config,
    questions: [makeQuestion('q0'), makeQuestion('q1')],
    currentIndex: 1,
    score: 1,
    isComplete: false,
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
    // Leaving the connection open would block another spec file's schema
    // migration test from ever reaching a clean database.
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
