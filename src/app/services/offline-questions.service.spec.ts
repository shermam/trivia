import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { TriviaQuestion } from '../models/question.model';
import { OfflineQuestionsService } from './offline-questions.service';

/** Opens its own short-lived connection so it can `close()` afterward instead of leaving one dangling. */
function clearOfflineDb(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const openRequest =
      indexedDB.open(
        'trivia-offline',
      ); /* no version: open whatever the service created, so a schema bump here doesn't VersionError the tests */
    openRequest.onsuccess = () => {
      const db = openRequest.result;
      if (!db.objectStoreNames.contains('questions')) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction('questions', 'readwrite');
      tx.objectStore('questions').clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error as Error);
      };
    };
    openRequest.onerror = () => reject(openRequest.error as Error);
  });
}

function makeQuestion(overrides: Partial<TriviaQuestion> = {}): TriviaQuestion {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question: overrides.question ?? `Question ${crypto.randomUUID()}`,
    correct_answer: 'A',
    incorrect_answers: ['B', 'C', 'D'],
    all_answers: [
      { id: 'a', text: 'A', isCorrect: true },
      { id: 'b', text: 'B', isCorrect: false },
      { id: 'c', text: 'C', isCorrect: false },
      { id: 'd', text: 'D', isCorrect: false },
    ],
    source: 'open_trivia',
    ...overrides,
  };
}

describe('OfflineQuestionsService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  afterEach(async () => {
    // fake-indexeddb persists across tests in the same module registry — start every test clean.
    // Clearing (not deleteDatabase) avoids hanging forever on the still-open connection each
    // OfflineQuestionsService instance never closes.
    await clearOfflineDb();
  });

  it('starts with a count of 0', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    expect(await service.getCount()).toBe(0);
  });

  it('saveQuestions() persists questions retrievable via getOfflineQuestions()', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    const questions = [makeQuestion(), makeQuestion(), makeQuestion()];

    await service.saveQuestions(questions);

    expect(await service.getCount()).toBe(3);
    const result = await service.getOfflineQuestions({
      amount: 3,
      difficulty: '',
      source: 'mixed',
      timeLimit: 15,
    });
    expect(result).toHaveLength(3);
  });

  it('dedupes a re-fetched question instead of accumulating duplicates', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    const question = makeQuestion({ question: 'Same question text' });

    await service.saveQuestions([question]);
    await service.saveQuestions([{ ...question, correct_answer: 'Updated answer' }]);

    expect(await service.getCount()).toBe(1);
  });

  /**
   * Finding C4. The store was keyed on the question *text* alone, so anything
   * sharing wording collided and one row silently replaced the other.
   *
   * Across sources that was worse than losing a row. `getOfflineQuestions()`
   * never crosses `source`, so a custom question overwriting an Open Trivia one
   * didn't merely evict it — it moved the surviving copy into the other
   * source's pool, shrinking what an `open_trivia` request could draw from
   * while `cachedCount` still reported a full pool.
   */
  it('keeps identically-worded questions from different sources apart', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    const text = 'Which came first?';

    await service.saveQuestions([
      makeQuestion({ question: text, source: 'open_trivia' }),
      makeQuestion({ question: text, source: 'custom', id: 'custom-doc-1' }),
    ]);

    expect(await service.getCount()).toBe(2);

    // Both pools still hold their own copy — the eviction used to empty one.
    const fromOpenTrivia = await service.getOfflineQuestions({
      amount: 5,
      difficulty: '',
      source: 'open_trivia',
      timeLimit: 15,
    });
    const fromCustom = await service.getOfflineQuestions({
      amount: 5,
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });
    expect(fromOpenTrivia.map((q) => q.source)).toEqual(['open_trivia']);
    expect(fromCustom.map((q) => q.source)).toEqual(['custom']);
  });

  // Two contributors can submit the same wording; they are still two documents,
  // and the bank draws them independently.
  it('keeps two distinct custom questions that share wording', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    const text = 'What is the capital?';

    await service.saveQuestions([
      makeQuestion({ question: text, source: 'custom', id: 'doc-a' }),
      makeQuestion({ question: text, source: 'custom', id: 'doc-b' }),
    ]);

    expect(await service.getCount()).toBe(2);
  });

  // An Open Trivia question's id is minted at fetch time
  // (`open-${Date.now()}-${index}`), so keying on it would fill the pool with
  // copies of the same question on every prefetch.
  it('still dedupes an Open Trivia question whose id changed between fetches', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    const text = 'How many moons?';

    await service.saveQuestions([
      makeQuestion({ question: text, source: 'open_trivia', id: 'open-1000-0' }),
    ]);
    await service.saveQuestions([
      makeQuestion({ question: text, source: 'open_trivia', id: 'open-2000-3' }),
    ]);

    expect(await service.getCount()).toBe(1);
  });

  // The storage key is an implementation detail of the store, not part of a
  // question — leaking it would put it into the quiz's `TriviaQuestion` objects.
  it('does not leak its storage-only fields to callers', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    await service.saveQuestions([makeQuestion()]);

    const [question] = await service.getOfflineQuestions({
      amount: 1,
      difficulty: '',
      source: 'mixed',
      timeLimit: 15,
    });

    expect(question).not.toHaveProperty('dedupeKey');
    expect(question).not.toHaveProperty('cachedAt');
  });

  /**
   * `FEAT-052`. The topic picker narrows the saved pool the way the category
   * picker did — as a preference — and a question is read through the one
   * derivation every reader shares: its tags, or for a question cached before
   * topics replaced categories, the tag its category derives. Both kinds are
   * in this pool on purpose; nothing in the store was migrated.
   */
  it('getOfflineQuestions() prefers questions about any of the chosen topics', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    await service.saveQuestions([
      makeQuestion({ question: 'q1', tags: ['history'], difficulty: 'hard' }),
      makeQuestion({ question: 'q2', category: 'History', difficulty: 'hard' }),
      makeQuestion({ question: 'q3', tags: ['cold-war'], difficulty: 'hard' }),
      makeQuestion({ question: 'q4', category: 'Science', difficulty: 'hard' }),
      makeQuestion({ question: 'q5', tags: ['history'], difficulty: 'easy' }),
    ]);

    const result = await service.getOfflineQuestions({
      amount: 3,
      difficulty: 'hard',
      source: 'mixed',
      timeLimit: 15,
      tags: ['history', 'cold-war'],
    });

    expect(result.map((q) => q.question).sort()).toEqual(['q1', 'q2', 'q3']);
  });

  it('getOfflineQuestions() falls back to the whole pool when too few questions match the filter', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    await service.saveQuestions([
      makeQuestion({ question: 'q1', category: 'History', difficulty: 'hard' }),
      makeQuestion({ question: 'q2', category: 'Science', difficulty: 'easy' }),
      makeQuestion({ question: 'q3', tags: ['geography'], difficulty: 'medium' }),
    ]);

    const result = await service.getOfflineQuestions({
      amount: 3,
      difficulty: 'hard',
      source: 'mixed',
      timeLimit: 15,
      tags: ['history'],
    });

    // Only 1 question is about history at hard — a mismatched-topic offline
    // game beats no offline game, so the whole 3-question pool plays.
    expect(result).toHaveLength(3);
  });

  /**
   * The reservoir the deduplicating draw substitutes from applies the topics as
   * a **filter**, not a preference: substituting an off-topic question into a
   * game the player narrowed would be worse than serving a repeat.
   */
  it('getMatchingQuestions() keeps only questions about one of the topics', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    await service.saveQuestions([
      makeQuestion({ question: 'q1', tags: ['sports'] }),
      makeQuestion({ question: 'q2', category: 'Sports' }),
      makeQuestion({ question: 'q3', tags: ['history'] }),
      makeQuestion({ question: 'q4', source: 'custom', tags: ['sports'] }),
    ]);

    const matching = await service.getMatchingQuestions('open_trivia', ['sports'], '');

    expect(matching.map((q) => q.question).sort()).toEqual(['q1', 'q2']);
    expect(await service.getMatchingQuestions('open_trivia', [], '')).toHaveLength(3);
  });

  it('getOfflineQuestions() never crosses source — a "custom" request only draws custom questions', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    await service.saveQuestions([
      makeQuestion({ question: 'q1', source: 'custom' }),
      makeQuestion({ question: 'q2', source: 'open_trivia' }),
      makeQuestion({ question: 'q3', source: 'open_trivia' }),
      makeQuestion({ question: 'q4', source: 'open_trivia' }),
    ]);

    const result = await service.getOfflineQuestions({
      amount: 5,
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });

    // Only 1 custom-sourced question is cached — must not pad with open_trivia ones.
    expect(result).toEqual([expect.objectContaining({ question: 'q1', source: 'custom' })]);
  });

  it('getOfflineQuestions() returns nothing for a source with no cached questions of that kind', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    await service.saveQuestions([makeQuestion({ question: 'q1', source: 'open_trivia' })]);

    const result = await service.getOfflineQuestions({
      amount: 5,
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });

    expect(result).toEqual([]);
  });

  it('getOfflineQuestions() draws from every source when "mixed" is requested', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    await service.saveQuestions([
      makeQuestion({ question: 'q1', source: 'custom' }),
      makeQuestion({ question: 'q2', source: 'open_trivia' }),
    ]);

    const result = await service.getOfflineQuestions({
      amount: 5,
      difficulty: '',
      source: 'mixed',
      timeLimit: 15,
    });

    expect(result).toHaveLength(2);
  });

  it('getOfflineQuestions() slices down to the requested amount', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    await service.saveQuestions([makeQuestion(), makeQuestion(), makeQuestion()]);

    const result = await service.getOfflineQuestions({
      amount: 1,
      difficulty: '',
      source: 'mixed',
      timeLimit: 15,
    });

    expect(result).toHaveLength(1);
  });

  it('returns an empty array when the pool is empty', async () => {
    const service = TestBed.inject(OfflineQuestionsService);
    const result = await service.getOfflineQuestions({
      amount: 5,
      difficulty: '',
      source: 'mixed',
      timeLimit: 15,
    });
    expect(result).toEqual([]);
  });
});
