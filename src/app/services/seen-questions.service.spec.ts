import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { TriviaQuestion } from '../models/question.model';
import { seenKeyFor } from '../utils/seen-key.util';
import { OfflineDbService, SEEN_QUESTIONS_STORE } from './offline-db.service';
import { MAX_SEEN_QUESTIONS, SeenQuestionsService } from './seen-questions.service';

/**
 * Opens its own short-lived connection so it can `close()` afterward instead of
 * leaving one dangling — `ng test` shares one `fake-indexeddb` across spec
 * files, so a leaked connection is another file's problem (`ci-cd.md` §4.5).
 */
function clearSeenStore(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // No version: open whatever the service created, so a schema bump here
    // doesn't `VersionError` the tests.
    const openRequest = indexedDB.open('trivia-offline');
    openRequest.onsuccess = () => {
      const db = openRequest.result;
      if (!db.objectStoreNames.contains(SEEN_QUESTIONS_STORE)) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction(SEEN_QUESTIONS_STORE, 'readwrite');
      tx.objectStore(SEEN_QUESTIONS_STORE).clear();
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

/**
 * Puts `count` already-answered entries in the store, oldest first, in one
 * transaction — reaching the cap without spending two thousand round trips
 * through the service to get there.
 */
async function fillSeenStore(count: number): Promise<void> {
  const db = await TestBed.inject(OfflineDbService).open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SEEN_QUESTIONS_STORE, 'readwrite');
    const store = tx.objectStore(SEEN_QUESTIONS_STORE);
    for (let index = 0; index < count; index++) {
      store.put({ key: `custom:old-${index}`, source: 'custom', seenAt: index + 1 });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error as Error);
  });
}

function makeQuestion(overrides: Partial<TriviaQuestion> = {}): TriviaQuestion {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question: overrides.question ?? `Question ${crypto.randomUUID()}?`,
    correct_answer: 'A',
    incorrect_answers: ['B'],
    all_answers: [
      { id: 'a', text: 'A', isCorrect: true },
      { id: 'b', text: 'B', isCorrect: false },
    ],
    source: 'open_trivia',
    ...overrides,
  };
}

describe('SeenQuestionsService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  afterEach(async () => {
    await TestBed.inject(OfflineDbService).close();
    await clearSeenStore();
    TestBed.resetTestingModule();
  });

  it('remembers a question by its seen key, with the time it was answered', async () => {
    const service = TestBed.inject(SeenQuestionsService);
    const question = makeQuestion({ source: 'custom', id: 'doc-1' });

    await service.markSeen(question);

    const seen = await service.readSeenSet();
    expect(seen?.get('custom:doc-1')).toBeTypeOf('number');
    expect(seen?.size).toBe(1);
  });

  /**
   * The signal every caller branches on. An empty set and an unreadable store
   * have the same right answer — behave as the app did before this feature —
   * and collapsing them into `null` is what keeps that from being three
   * separate code paths at the draw.
   */
  it('reports nothing to deduplicate against when the store is empty', async () => {
    expect(await TestBed.inject(SeenQuestionsService).readSeenSet()).toBeNull();
  });

  it('re-answering a question moves its timestamp rather than adding a row', async () => {
    const service = TestBed.inject(SeenQuestionsService);
    const question = makeQuestion({ source: 'custom', id: 'doc-1' });
    // `Date.now`, not fake timers: `fake-indexeddb` schedules its own work on
    // the event loop, and faking that out to move a clock deadlocks the very
    // transactions under test.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    await service.markSeen(question);
    now.mockReturnValue(61_000);
    await service.markSeen(question);
    now.mockRestore();

    const seen = await service.readSeenSet();
    expect(seen?.size).toBe(1);
    expect(seen?.get('custom:doc-1')).toBe(61_000);
  });

  /**
   * The cap, and which end of it goes. An unbounded set on a heavy player is a
   * slow leak, and it is read in full on every draw — so the bound is about
   * the read as much as the storage. The oldest entry is the one dropped,
   * which is also the least useful: a question answered two thousand questions
   * ago is one the player would not mind meeting again.
   *
   * The store is filled to the cap in one transaction and then pushed past it
   * through the service, three entries rather than one: an off-by-one in
   * `overflow` is invisible from a single insert, and driving two thousand
   * inserts through the service to reach the same state would spend seconds
   * proving nothing extra.
   */
  it('evicts the oldest entries once the cap is passed', async () => {
    const service = TestBed.inject(SeenQuestionsService);
    await fillSeenStore(MAX_SEEN_QUESTIONS);
    const overshoot = 3;
    const now = vi.spyOn(Date, 'now').mockReturnValue(9_000_000);

    for (let index = 0; index < overshoot; index++) {
      await service.markSeen(makeQuestion({ source: 'custom', id: `fresh-${index}` }));
    }
    now.mockRestore();

    const seen = await service.readSeenSet();
    expect(seen?.size).toBe(MAX_SEEN_QUESTIONS);
    // The three oldest went, and only those three.
    for (let index = 0; index < overshoot; index++) {
      expect(seen?.has(`custom:old-${index}`)).toBe(false);
      expect(seen?.has(`custom:fresh-${index}`)).toBe(true);
    }
    expect(seen?.has(`custom:old-${overshoot}`)).toBe(true);
  });

  it('keeps an Open Trivia question under the hash of its wording', async () => {
    const service = TestBed.inject(SeenQuestionsService);
    const monday = makeQuestion({ id: 'open-1-0', question: 'Who wrote Hamlet?' });
    const tuesday = makeQuestion({ id: 'open-2-9', question: 'who   wrote hamlet? ' });

    await service.markSeen(monday);

    const seen = await service.readSeenSet();
    expect(seen?.size).toBe(1);
    expect(seen?.has(seenKeyFor(tuesday))).toBe(true);
  });

  /**
   * IndexedDB is unavailable outright in some private-browsing modes and can
   * refuse a write on quota. Losing the seen-set has to cost deduplication and
   * nothing else — a rejection here would surface inside `record()`, on the
   * critical path of answering a question.
   */
  describe('when storage will not open', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          {
            provide: OfflineDbService,
            useValue: {
              open: () => Promise.reject(new Error('IndexedDB is disabled')),
              close: () => Promise.resolve(),
            },
          },
        ],
      });
    });

    it('marking a question resolves rather than throwing', async () => {
      await expect(
        TestBed.inject(SeenQuestionsService).markSeen(makeQuestion()),
      ).resolves.toBeUndefined();
    });

    it('reads as nothing to deduplicate against, which is a plain draw', async () => {
      expect(await TestBed.inject(SeenQuestionsService).readSeenSet()).toBeNull();
    });
  });
});
