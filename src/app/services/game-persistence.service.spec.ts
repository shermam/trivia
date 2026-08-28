import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import {
  ALL_LIFELINES_AVAILABLE,
  GameConfig,
  SKIPPED,
  TIMED_OUT,
  TriviaQuestion,
  answeredWith,
} from '../models/question.model';
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
    answerHistory: [],
    lifelines: ALL_LIFELINES_AVAILABLE,
    eliminatedAnswerIds: [],
    gameId: 'game-fixture',
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

  /*
   * `answerHistory` (FEAT-001) — the recap's data, and additive for the same
   * reason as `flaggedQuestionIds` and `timeLimit` before it: a version
   * mismatch discards rather than migrates, so bumping would throw away every
   * in-flight game on deploy to protect the *least* important field in the
   * snapshot.
   */
  it('round-trips the answer history, timeouts included', async () => {
    await service.save(makeGame({ answerHistory: [answeredWith('q0:correct'), TIMED_OUT] }));

    expect((await service.load())?.answerHistory).toEqual([answeredWith('q0:correct'), TIMED_OUT]);
  });

  it('restores a record written before the answer history existed', async () => {
    await putRaw(validRecord()); // validRecord() deliberately omits the field

    const loaded = await service.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.answerHistory).toEqual([]);
  });

  /*
   * Unlike the flags above, an unusable history is dropped **whole** rather
   * than filtered, and that difference is the point: this array is positional,
   * so removing one bad entry shifts every later answer onto the wrong
   * question. The recap would then render the player picking things they never
   * picked — confidently wrong, which is worse than absent.
   *
   * `validRecord()` holds a single question (`q0`), so index 1 is past the end
   * and `q1:correct` names an option on a question this save doesn't contain.
   */
  it.each([
    ['a non-array value', 'q0:correct'],
    ['more answers than questions', [answeredWith('q0:correct'), TIMED_OUT]],
    ['an id belonging to no question in the save', [answeredWith('q1:correct')]],
    ['an unrecognised entry', [42]],
  ])('discards %s rather than filtering it', async (_label, stored) => {
    await putRaw(validRecord({ answerHistory: stored }));

    const loaded = await service.load();
    expect(loaded).not.toBeNull(); // the game itself survives
    expect(loaded?.answerHistory).toEqual([]);
  });

  /*
   * The clause that actually earns its keep. An id that exists in the game but
   * on a *different* question passes any "is this a known answer id" check and
   * produces a plausible, wrong recap rather than an obviously broken one — so
   * the check is per-position, against that question's own options.
   */
  it("discards a history whose entry names another question's option", async () => {
    await putRaw(
      validRecord({
        questions: [makeQuestion('q0'), makeQuestion('q1')],
        answerHistory: [answeredWith('q1:correct'), answeredWith('q0:correct')], // real ids, wrong questions
      }),
    );

    expect((await service.load())?.answerHistory).toEqual([]);
  });

  // Shorter than the game is legitimate — it is a game still being played —
  // and must survive, or every reload mid-round loses its history.
  it('keeps a history shorter than the game, which is just an unfinished round', async () => {
    await putRaw(
      validRecord({
        questions: [makeQuestion('q0'), makeQuestion('q1')],
        answerHistory: [answeredWith('q0:incorrect-0')],
      }),
    );

    expect((await service.load())?.answerHistory).toEqual([answeredWith('q0:incorrect-0')]);
  });

  it('round-trips a skipped question as its own outcome', async () => {
    await service.save(makeGame({ answerHistory: [SKIPPED, TIMED_OUT] }));

    expect((await service.load())?.answerHistory).toEqual([SKIPPED, TIMED_OUT]);
  });

  /*
   * The shape `FEAT-001` shipped, one day before `FEAT-002` replaced it. A save
   * in flight across that deploy must lose its **recap** and keep its **game**,
   * which is the whole reason the history is validated separately from the rest
   * of the record rather than rejecting it.
   */
  it('drops a history written in the previous scalar shape, and keeps the game', async () => {
    // **One entry, because `validRecord()` holds one question.** The first
    // draft used two and passed against the *length* check without the shape
    // check ever running — mutation testing caught it: loosening
    // `isUsableAnswerHistory` to accept `string | null` changed nothing.
    await putRaw(validRecord({ answerHistory: ['q0:correct'] }));

    const loaded = await service.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.questions).toHaveLength(1);
    expect(loaded?.answerHistory).toEqual([]);
  });

  /*
   * Lifelines (`FEAT-002`). The pair has to move together — see the field
   * comment — so these cover the round trip and then every way the pair can be
   * unusable, all of which reset **both** halves.
   */
  it('round-trips spent lifelines and the options 50/50 removed', async () => {
    await service.save(
      makeGame({
        lifelines: { fiftyFifty: false, extraTime: true, skip: false },
        eliminatedAnswerIds: ['q1:incorrect-0'],
        currentIndex: 1,
      }),
    );

    const loaded = await service.load();
    expect(loaded?.lifelines).toEqual({ fiftyFifty: false, extraTime: true, skip: false });
    expect(loaded?.eliminatedAnswerIds).toEqual(['q1:incorrect-0']);
  });

  it('restores a record written before lifelines existed with all three available', async () => {
    await putRaw(validRecord()); // validRecord() omits both fields

    const loaded = await service.load();
    expect(loaded?.lifelines).toEqual(ALL_LIFELINES_AVAILABLE);
    expect(loaded?.eliminatedAnswerIds).toEqual([]);
  });

  /*
   * **The direction of the default is the point.** Filling a partial record's
   * missing keys with `true` refunds whatever was left out, which makes a
   * truncated save worth manufacturing. Resetting the whole set is the same
   * answer a fresh game gives, so the edit buys nothing.
   */
  it.each([
    ['a partial set', { fiftyFifty: false }],
    ['a non-boolean value', { fiftyFifty: false, extraTime: 'yes', skip: true }],
    ['an unrecognised shape', 'all of them'],
    ['nothing at all', null],
  ])('resets lifelines rather than refunding when the stored value is %s', async (_l, stored) => {
    await putRaw(validRecord({ lifelines: stored, eliminatedAnswerIds: [] }));

    const loaded = await service.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.lifelines).toEqual(ALL_LIFELINES_AVAILABLE);
  });

  // Restoring "50/50 spent" while showing four options takes the lifeline and
  // hands nothing back, so an unusable id resets the availability flags too.
  it('resets both halves when the eliminated ids do not match the current question', async () => {
    await putRaw(
      validRecord({
        lifelines: { fiftyFifty: false, extraTime: false, skip: false },
        eliminatedAnswerIds: ['not-an-answer-on-this-question'],
      }),
    );

    const loaded = await service.load();
    expect(loaded?.lifelines).toEqual(ALL_LIFELINES_AVAILABLE);
    expect(loaded?.eliminatedAnswerIds).toEqual([]);
  });

  /*
   * `gameId` — the idempotency key that stops a reload of `/game-over` banking
   * the same game twice into `users/{uid}`. Additive, no `SCHEMA_VERSION`
   * bump, same call as the three fields before it.
   */
  it('round-trips the game id', async () => {
    await service.save(makeGame({ gameId: 'game-xyz' }));

    expect((await service.load())?.gameId).toBe('game-xyz');
  });

  /*
   * A save written before this field existed. It restores with `null`, and the
   * caller treats that as "do not bank this game" — one lost total, against
   * the alternative of minting an id on the results screen, which would be
   * fresh on every refresh and inflate the totals on each one.
   */
  it('restores a record written before the game id existed, as null', async () => {
    await putRaw(validRecord()); // validRecord() deliberately omits the field

    const loaded = await service.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.gameId).toBeNull();
  });

  // Dropped to null rather than rejecting the save: an unusable id costs the
  // game's totals, and losing the game itself to protect them would be
  // exactly backwards — the same call `flaggedQuestionIds` makes.
  it.each([
    ['a non-string', 42],
    ['an empty string', ''],
    ['an over-long id', 'x'.repeat(129)],
  ])('discards %s without rejecting the save', async (_label, stored) => {
    await putRaw(validRecord({ gameId: stored }));

    const loaded = await service.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.gameId).toBeNull();
  });

  it('keeps an id at exactly the length limit', async () => {
    const id = 'x'.repeat(128);
    await putRaw(validRecord({ gameId: id }));

    expect((await service.load())?.gameId).toBe(id);
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
