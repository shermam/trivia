import { TestBed } from '@angular/core/testing';
import { GameConfig, TriviaQuestion } from '../models/question.model';
import { GamePersistenceService } from './game-persistence.service';

/**
 * Finding B8. An in-progress game lived only in signals, so a reload, a tab
 * crash or a PWA relaunch threw it away — worst for exactly the offline/mobile
 * players the offline pool exists to serve.
 *
 * These cover the storage layer on its own: what survives a round trip, and
 * what is refused. The refusals matter as much as the happy path — `localStorage`
 * outlives deploys, so this code is guaranteed to be handed shapes written by
 * an older build, and an exception here happens during bootstrap, which
 * white-screens the app rather than merely losing a game.
 */

const STORAGE_KEY = 'trivia-game-in-progress';
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

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

describe('GamePersistenceService (B8)', () => {
  let service: GamePersistenceService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    service = TestBed.inject(GamePersistenceService);
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips a saved game', () => {
    service.save(makeGame());

    const loaded = service.load();
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

  it('returns null when nothing is stored', () => {
    expect(service.load()).toBeNull();
  });

  it('clear() removes the saved game', () => {
    service.save(makeGame());
    service.clear();
    expect(service.load()).toBeNull();
  });

  it('discards a game older than the 6h TTL', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    service.save(makeGame());

    vi.spyOn(Date, 'now').mockReturnValue(now + SIX_HOURS_MS + 1);
    expect(service.load()).toBeNull();
    // ...and drops it, so it isn't re-parsed on every subsequent load.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('keeps a game inside the TTL', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    service.save(makeGame());

    vi.spyOn(Date, 'now').mockReturnValue(now + SIX_HOURS_MS - 1000);
    expect(service.load()).not.toBeNull();
  });

  it('keeps a game whose timestamp is in the future (clock moved backwards)', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    service.save(makeGame());

    vi.spyOn(Date, 'now').mockReturnValue(now - 60 * 60 * 1000);
    expect(service.load()).not.toBeNull();
  });

  it.each([
    ['unparseable JSON', 'not json at all'],
    ['a non-object', '42'],
    ['a future schema version', JSON.stringify({ version: 99, savedAt: Date.now() })],
    [
      'an empty question list',
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        config,
        questions: [],
        currentIndex: 0,
        score: 0,
      }),
    ],
    [
      'a currentIndex past the end',
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        config,
        questions: [makeQuestion('q0')],
        currentIndex: 5,
        score: 0,
      }),
    ],
    [
      'a score above the question count',
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        config,
        questions: [makeQuestion('q0')],
        currentIndex: 0,
        score: 99,
      }),
    ],
    [
      'a malformed question',
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        config,
        questions: [{ id: 'q0' }],
        currentIndex: 0,
        score: 0,
      }),
    ],
    [
      'an unknown source',
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        config: { ...config, source: 'wikipedia' },
        questions: [makeQuestion('q0')],
        currentIndex: 0,
        score: 0,
      }),
    ],
  ])('refuses %s', (_label, raw) => {
    localStorage.setItem(STORAGE_KEY, raw);
    expect(service.load()).toBeNull();
  });

  it('survives storage that throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    // Losing the ability to save must not take the game down with it.
    expect(() => service.save(makeGame())).not.toThrow();
  });

  it('survives storage that throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(service.load()).toBeNull();
  });
});
