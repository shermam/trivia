import 'fake-indexeddb/auto';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { TriviaQuestion } from '../models/question.model';
import { seenKeyFor } from '../utils/seen-key.util';
import { FirebaseService } from './firebase.service';
import { OfflineQuestionsService } from './offline-questions.service';
import { SeenQuestionsService } from './seen-questions.service';
import { TriviaService } from './trivia.service';

/**
 * A device that has answered nothing, so every draw takes the plain path
 * (`FEAT-034`).
 *
 * Stubbed rather than left to the real service for the reason
 * `game-controller.service.spec.ts` stubs the daily allowance: `ng test` runs
 * with `--isolate` false, so spec files share one `fake-indexeddb`, and the
 * seen-set is written by another file in this run. A real read here would make
 * the question counts these tests assert depend on whether
 * `game-controller.service.spec.ts` happened to go first.
 *
 * It is also just correct on its own terms — nothing in these describes is
 * about deduplication. The ones that are provide their own set below.
 */
function nothingSeenYet() {
  return {
    provide: SeenQuestionsService,
    useValue: { readSeenSet: () => Promise.resolve(null), markSeen: () => Promise.resolve() },
  };
}

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

function makeOfflineQuestion(question: string): TriviaQuestion {
  return {
    id: question,
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question,
    correct_answer: 'A',
    incorrect_answers: ['B', 'C', 'D'],
    all_answers: [
      { id: `${question}:correct`, text: 'A', isCorrect: true },
      { id: `${question}:incorrect-0`, text: 'B', isCorrect: false },
      { id: `${question}:incorrect-1`, text: 'C', isCorrect: false },
      { id: `${question}:incorrect-2`, text: 'D', isCorrect: false },
    ],
    source: 'open_trivia',
  };
}

describe('TriviaService offline fallback', () => {
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FirebaseService, useValue: { getCustomQuestions: () => of([]) } },
        nothingSeenYet(),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(async () => {
    httpMock.verify();
    await clearOfflineDb();
  });

  it('still attempts the real network request even when navigator.onLine reports false', async () => {
    // navigator.onLine is well-known to misreport `false` in some headless/CI browser
    // environments even when the network is fine — getQuestions() must not trust it as a
    // hard gate (see the comment on the method) or it silently serves stale/wrong-source
    // offline content instead of a perfectly working live fetch.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    const triviaService = TestBed.inject(TriviaService);
    const promise = triviaService.getQuestions({
      amount: 1,
      category: '',
      difficulty: '',
      source: 'open_trivia',
      timeLimit: 15,
    });

    httpMock
      .expectOne((req) => req.url === 'https://opentdb.com/api.php')
      .flush({
        response_code: 0,
        results: [
          {
            category: 'Science',
            type: 'multiple',
            difficulty: 'easy',
            question: 'Live question',
            correct_answer: 'A',
            incorrect_answers: ['B', 'C', 'D'],
          },
        ],
      });

    const result = await promise;

    expect(result).toHaveLength(1);
    expect(triviaService.playingOffline()).toBe(false);
  });

  it('falls back to the offline pool when the network request itself fails', async () => {
    const offlineQuestionsService = TestBed.inject(OfflineQuestionsService);
    await offlineQuestionsService.saveQuestions([makeOfflineQuestion('cached question')]);

    const triviaService = TestBed.inject(TriviaService);
    const promise = triviaService.getQuestions({
      amount: 5,
      category: '',
      difficulty: '',
      source: 'open_trivia',
      timeLimit: 15,
    });

    httpMock
      .expectOne((req) => req.url === 'https://opentdb.com/api.php')
      .error(new ProgressEvent('error'));

    const result = await promise;

    expect(result).toEqual([makeOfflineQuestion('cached question')]);
    expect(triviaService.playingOffline()).toBe(true);
  });

  it('falling back for a "custom" request never substitutes cached open_trivia questions', async () => {
    const offlineQuestionsService = TestBed.inject(OfflineQuestionsService);
    await offlineQuestionsService.saveQuestions([
      makeOfflineQuestion('cached open trivia question'),
    ]);

    const firebaseService = TestBed.inject(FirebaseService) as unknown as {
      getCustomQuestions: () => ReturnType<FirebaseService['getCustomQuestions']>;
    };
    firebaseService.getCustomQuestions = () => throwError(() => new Error('Firestore unavailable'));

    const triviaService = TestBed.inject(TriviaService);

    // No opentdb.com request expected — "custom" source never calls it.
    await expect(
      triviaService.getQuestions({
        amount: 5,
        category: '',
        difficulty: '',
        source: 'custom',
        timeLimit: 15,
      }),
    ).rejects.toBeTruthy();
    httpMock.expectNone(() => true);
  });

  it('re-throws when the network fails and the offline pool is empty', async () => {
    const triviaService = TestBed.inject(TriviaService);
    const promise = triviaService.getQuestions({
      amount: 5,
      category: '',
      difficulty: '',
      source: 'open_trivia',
      timeLimit: 15,
    });

    httpMock
      .expectOne((req) => req.url === 'https://opentdb.com/api.php')
      .error(new ProgressEvent('error'));

    await expect(promise).rejects.toBeTruthy();
  });

  it('initOfflinePrefetch() does not schedule anything when navigator.webdriver is true', () => {
    // navigator.webdriver is set by every browser-automation framework (Playwright,
    // Selenium) — a real preview-e2e CI run confirmed this task's own background requests
    // can compete with the tests driving them for a real, shared, rate-limited backend
    // closely enough to cause unrelated specs to time out.
    // jsdom's Navigator has no `webdriver` property at all — vi.spyOn requires the property to
    // already exist to spy on its getter, so it's defined directly instead.
    Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    try {
      TestBed.inject(TriviaService).initOfflinePrefetch();

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(addEventListenerSpy).not.toHaveBeenCalledWith('online', expect.anything());
    } finally {
      delete (navigator as { webdriver?: boolean }).webdriver;
    }
  });

  it('initOfflinePrefetch() schedules a refill when navigator.webdriver is not set', () => {
    // Fake timers so the scheduled setTimeout(run, 2000) never actually fires and fires off a
    // real (unawaited, unverifiable) fetch attempt after this test has already finished.
    vi.useFakeTimers();
    try {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

      TestBed.inject(TriviaService).initOfflinePrefetch();

      expect(addEventListenerSpy).toHaveBeenCalledWith('online', expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fall back to the offline pool on a successful network response', async () => {
    const triviaService = TestBed.inject(TriviaService);
    const promise = triviaService.getQuestions({
      amount: 1,
      category: '',
      difficulty: '',
      source: 'open_trivia',
      timeLimit: 15,
    });

    httpMock
      .expectOne((req) => req.url === 'https://opentdb.com/api.php')
      .flush({
        response_code: 0,
        results: [
          {
            category: 'Science',
            type: 'multiple',
            difficulty: 'easy',
            question: 'Live question',
            correct_answer: 'A',
            incorrect_answers: ['B', 'C', 'D'],
          },
        ],
      });

    const result = await promise;

    expect(result).toHaveLength(1);
    expect(result[0].question).toBe('Live question');
    expect(triviaService.playingOffline()).toBe(false);
  });
});

/**
 * Finding B1. A question whose `correct_answer` also appears in
 * `incorrect_answers` used to be scored by comparing the clicked *string*
 * against `correct_answer`, so clicking the duplicated wrong option scored as
 * correct — and `@for`'s `track answer` saw two identical keys for it.
 *
 * `firestore.rules` now rejects such a question at write time, but questions
 * also arrive from Open Trivia DB, which this app does not control, and the
 * bank already holds documents written before that rule existed. So the reader
 * has to be right regardless of whether the writer was.
 */
describe('TriviaService answer identity', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FirebaseService, useValue: { getCustomQuestions: () => of([]) } },
        nothingSeenYet(),
      ],
    });
  });

  function fetchOne(raw: Partial<{ correct_answer: string; incorrect_answers: string[] }>) {
    const service = TestBed.inject(TriviaService);
    const httpMock = TestBed.inject(HttpTestingController);
    const promise = service.getQuestions({
      amount: 1,
      category: '',
      difficulty: '',
      source: 'open_trivia',
      timeLimit: 15,
    });
    httpMock
      .expectOne((r) => r.url.includes('opentdb.com'))
      .flush({
        response_code: 0,
        results: [
          {
            category: 'Science',
            type: 'multiple',
            difficulty: 'easy',
            question: 'Capital of France?',
            correct_answer: raw.correct_answer ?? 'Paris',
            incorrect_answers: raw.incorrect_answers ?? ['Lyon', 'Nice', 'Rome'],
          },
        ],
      });
    return promise;
  }

  it('gives every answer an id that is unique even when the text is not', async () => {
    const [question] = await fetchOne({
      correct_answer: 'Paris',
      incorrect_answers: ['Paris', 'Lyon', 'Nice'],
    });
    const ids = question.all_answers.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The bug itself: exactly one option may score, and it must be the one that
  // was actually the correct answer — not merely one whose text matches it.
  it('marks exactly one answer correct when the correct text is duplicated', async () => {
    const [question] = await fetchOne({
      correct_answer: 'Paris',
      incorrect_answers: ['Paris', 'Lyon', 'Nice'],
    });
    const correct = question.all_answers.filter((a) => a.isCorrect);
    expect(correct).toHaveLength(1);
    expect(correct[0].text).toBe('Paris');

    // …and the duplicate that is *not* the correct answer stays wrong, which
    // is what string comparison got wrong.
    const duplicates = question.all_answers.filter((a) => a.text === 'Paris');
    expect(duplicates).toHaveLength(2);
    expect(duplicates.filter((a) => a.isCorrect)).toHaveLength(1);
  });

  it('keeps every answer text, including duplicates, so the options still render', async () => {
    const [question] = await fetchOne({
      correct_answer: 'Paris',
      incorrect_answers: ['Paris', 'Lyon', 'Nice'],
    });
    expect(question.all_answers).toHaveLength(4);
    expect([...question.all_answers].map((a) => a.text).sort()).toEqual([
      'Lyon',
      'Nice',
      'Paris',
      'Paris',
    ]);
  });
});

/**
 * Finding B3. `getCategories()` memoizes its promise, and used to keep that
 * memo even when the fetch rejected — so a single flaky moment left the
 * category picker stuck on "Any Category" for the rest of the session, long
 * after the network came back, with a full page reload the only way out.
 */
describe('TriviaService category caching', () => {
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FirebaseService, useValue: { getCustomQuestions: () => of([]) } },
        nothingSeenYet(),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
  });

  const flushCategories = () =>
    httpMock
      .expectOne((r) => r.url.includes('api_category.php'))
      .flush({ trivia_categories: [{ id: 9, name: 'General Knowledge' }] });

  it('fetches once and reuses the result', async () => {
    const service = TestBed.inject(TriviaService);
    const first = service.getCategories();
    flushCategories();
    await first;

    const second = await service.getCategories();
    expect(second).toHaveLength(1);
    // No second request to flush — a pending one would fail verify().
    httpMock.verify();
  });

  it('retries after a failure instead of replaying the rejection forever', async () => {
    const service = TestBed.inject(TriviaService);

    const failing = service.getCategories();
    httpMock
      .expectOne((r) => r.url.includes('api_category.php'))
      .error(new ProgressEvent('network error'));
    await expect(failing).rejects.toBeTruthy();

    // The retry has to reach the network again. Before the fix this threw
    // "expected one matching request, found none" — the service handed back
    // the cached rejection without asking.
    const retried = service.getCategories();
    flushCategories();
    await expect(retried).resolves.toHaveLength(1);
  });
});

/**
 * Finding B9. `decodeHtmlEntities` exists because Open Trivia DB returns its
 * text entity-encoded. It used to run in the shared mapper, so it also
 * rewrote Firestore-authored questions — which are stored exactly as a
 * contributor typed them. A question about HTML deliberately reading
 * `&lt;div&gt;`, or an answer written out as `Tom &amp; Jerry`, silently
 * became something else, with no way to express the original.
 */
describe('TriviaService entity decoding is per source', () => {
  let httpMock: HttpTestingController;

  const customDoc = {
    id: 'q1',
    category: 'Web &amp; HTML',
    type: 'multiple' as const,
    difficulty: 'easy' as const,
    question: 'Which tag is written &lt;div&gt;?',
    correct_answer: 'Tom &amp; Jerry',
    incorrect_answers: ['A &quot;quoted&quot; answer', 'Plain', 'Other'],
  };

  function configure(customQuestions: unknown[]) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FirebaseService, useValue: { getCustomQuestions: () => of(customQuestions) } },
        nothingSeenYet(),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
  }

  it('leaves Firestore-authored text exactly as the contributor wrote it', async () => {
    configure([customDoc]);
    const [question] = await TestBed.inject(TriviaService).getQuestions({
      amount: 1,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });

    expect(question.question).toBe('Which tag is written &lt;div&gt;?');
    expect(question.category).toBe('Web &amp; HTML');
    expect(question.correct_answer).toBe('Tom &amp; Jerry');
    expect(question.incorrect_answers).toContain('A &quot;quoted&quot; answer');
    expect(question.all_answers.map((a) => a.text)).toContain('Tom &amp; Jerry');
  });

  it('still decodes Open Trivia DB text, which is genuinely encoded', async () => {
    configure([]);
    const service = TestBed.inject(TriviaService);
    const promise = service.getQuestions({
      amount: 1,
      category: '',
      difficulty: '',
      source: 'open_trivia',
      timeLimit: 15,
    });
    httpMock
      .expectOne((r) => r.url.includes('api.php'))
      .flush({
        response_code: 0,
        results: [
          {
            category: 'Science &amp; Nature',
            type: 'multiple',
            difficulty: 'easy',
            question: 'What does &quot;HTTP&quot; stand for?',
            correct_answer: 'Tom &amp; Jerry',
            incorrect_answers: ['It&#039;s a protocol', 'B', 'C'],
          },
        ],
      });

    const [question] = await promise;
    expect(question.question).toBe('What does "HTTP" stand for?');
    expect(question.category).toBe('Science & Nature');
    expect(question.correct_answer).toBe('Tom & Jerry');
    expect(question.incorrect_answers).toContain("It's a protocol");
  });
});

/**
 * `FEAT-022`. The mapper is where an optional field is easiest to lose: it
 * builds a `TriviaQuestion` key by key, so a field nobody copies across simply
 * does not exist downstream, and the recap renders exactly as it would for a
 * question that never had one. The absence half matters just as much — the
 * key has to stay *absent*, not become `undefined`, because `undefined` is
 * what a `hasOnly()`-shaped write would later reject.
 */
describe('TriviaService contributor attribution passes through the mapper', () => {
  function configure(customQuestions: unknown[]) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FirebaseService, useValue: { getCustomQuestions: () => of(customQuestions) } },
        nothingSeenYet(),
      ],
    });
  }

  const base = {
    id: 'q1',
    category: 'Science',
    type: 'multiple' as const,
    difficulty: 'easy' as const,
    question: 'What is the chemical symbol for water?',
    correct_answer: 'H2O',
    incorrect_answers: ['CO2', 'O2', 'NaCl'],
  };

  function play(): Promise<TriviaQuestion[]> {
    return TestBed.inject(TriviaService).getQuestions({
      amount: 1,
      category: '',
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });
  }

  it('carries both fields through to the question the recap renders', async () => {
    configure([{ ...base, sourceUrl: 'https://example.org/h2o', sourceTitle: 'Example Journal' }]);

    const [question] = await play();

    expect(question.sourceUrl).toBe('https://example.org/h2o');
    expect(question.sourceTitle).toBe('Example Journal');
  });

  it('leaves every key absent when the document has none of them', async () => {
    configure([base]);

    const [question] = await play();

    expect('sourceUrl' in question).toBe(false);
    expect('sourceTitle' in question).toBe(false);
    expect('explanation' in question).toBe(false);
  });

  it('carries the justification through to the question the recap renders', async () => {
    configure([{ ...base, explanation: 'Each molecule bonds two hydrogens to one oxygen.' }]);

    const [question] = await play();

    expect(question.explanation).toBe('Each molecule bonds two hydrogens to one oxygen.');
  });

  it('does not decode entities in a source title, the way it leaves every other Firestore field alone', async () => {
    configure([{ ...base, sourceTitle: 'Tom &amp; Jerry Quarterly' }]);

    const [question] = await play();

    // `CLAUDE.md` §4.4: `decodeHtmlEntities` is an Open Trivia DB adapter
    // concern, and running it over text a contributor typed rewrites what they
    // wrote.
    expect(question.sourceTitle).toBe('Tom &amp; Jerry Quarterly');
  });
});

/**
 * Finding C1. The category/difficulty filter and the amount ceiling used to be
 * applied here, in the browser, over every document in the collection. They are
 * the query's job now — so what this layer must get right is *forwarding* them.
 * Dropping that would be silent: the game would still run, still show custom
 * questions, and simply ignore the category and difficulty the player picked.
 */
describe('TriviaService custom-question queries (C1)', () => {
  function setupWithSpy() {
    const getCustomQuestions = vi.fn(() => of([]));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FirebaseService, useValue: { getCustomQuestions } },
        nothingSeenYet(),
      ],
    });
    return { service: TestBed.inject(TriviaService), getCustomQuestions };
  }

  afterEach(() => TestBed.resetTestingModule());

  it('passes the chosen category, difficulty and amount to the query', async () => {
    const { service, getCustomQuestions } = setupWithSpy();

    await service.getQuestions({
      amount: 7,
      category: 'History',
      difficulty: 'hard',
      source: 'custom',
      timeLimit: 15,
    });

    expect(getCustomQuestions).toHaveBeenCalledWith({
      category: 'History',
      difficulty: 'hard',
      limit: 7,
    });
  });

  it('asks for only its half of a mixed game, not the whole amount', async () => {
    const { service, getCustomQuestions } = setupWithSpy();
    const httpMock = TestBed.inject(HttpTestingController);

    const promise = service.getQuestions({
      amount: 10,
      category: '',
      difficulty: '',
      source: 'mixed',
      timeLimit: 15,
    });
    httpMock.expectOne((r) => r.url.includes('api.php')).flush({ response_code: 0, results: [] });
    await promise;

    // Mixed splits 10 into 5 from each source; asking for 10 here would double
    // the read this finding exists to bound.
    expect(getCustomQuestions).toHaveBeenCalledWith({
      category: '',
      difficulty: '',
      limit: 5,
    });
  });
});

/**
 * `FEAT-034` — the draw stops serving questions this device has already
 * answered, and the two halves that make that possible.
 *
 * Everything the draw reads is stubbed here: the seen-set, the shared bank and
 * the offline pool. That is deliberate — this is about the *selection*, and
 * the storage each of those three sits on has its own spec. The wiring that
 * fills the seen-set lives in `game-controller.service.spec.ts`.
 */
describe('TriviaService deduplication (FEAT-034)', () => {
  interface DrawStubs {
    seen: Record<string, number> | null;
    bank?: unknown[];
    pool?: TriviaQuestion[];
  }

  function customDoc(id: string) {
    return {
      id,
      category: 'Science',
      type: 'multiple',
      difficulty: 'easy',
      question: `Question ${id}?`,
      correct_answer: 'A',
      incorrect_answers: ['B', 'C', 'D'],
    };
  }

  function poolQuestion(id: string, question: string): TriviaQuestion {
    return { ...makeOfflineQuestion(question), id };
  }

  function configure({ seen, bank = [], pool = [] }: DrawStubs) {
    const getCustomQuestions = vi.fn(() => of(bank));
    const getMatchingQuestions = vi.fn(() => Promise.resolve(pool));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FirebaseService, useValue: { getCustomQuestions } },
        {
          provide: OfflineQuestionsService,
          useValue: { getMatchingQuestions, getOfflineQuestions: () => Promise.resolve([]) },
        },
        {
          provide: SeenQuestionsService,
          useValue: {
            readSeenSet: () =>
              Promise.resolve(seen === null ? null : new Map(Object.entries(seen))),
            markSeen: () => Promise.resolve(),
          },
        },
      ],
    });
    return {
      service: TestBed.inject(TriviaService),
      httpMock: TestBed.inject(HttpTestingController),
      getCustomQuestions,
      getMatchingQuestions,
    };
  }

  function customGame(amount: number) {
    return { amount, category: '', difficulty: '', source: 'custom', timeLimit: 15 } as const;
  }

  function openTriviaGame(amount: number) {
    return { amount, category: '', difficulty: '', source: 'open_trivia', timeLimit: 15 } as const;
  }

  /** One Open Trivia DB result, as the API shapes it. */
  function openTriviaResult(question: string) {
    return {
      category: 'Science',
      type: 'multiple',
      difficulty: 'easy',
      question,
      correct_answer: 'A',
      incorrect_answers: ['B', 'C', 'D'],
    };
  }

  /** Ids, sorted — `preferUnseen` shuffles, so the order is not something to assert on. */
  function ids(questions: TriviaQuestion[]): string[] {
    return questions.map((question) => question.id).sort();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('serves the questions this device has not answered', async () => {
    const { service } = configure({
      seen: { 'custom:c1': 100, 'custom:c2': 200 },
      bank: ['c1', 'c2', 'c3', 'c4'].map(customDoc),
    });

    expect(ids(await service.getQuestions(customGame(2)))).toEqual(['c3', 'c4']);
  });

  /**
   * With a small bank everything is eventually seen, and the draw has to keep
   * working. Failing, or quietly serving a four-question game, would make the
   * feature worse than not having it — so the remainder comes from the ones
   * the player is least likely to remember.
   */
  it('tops up with the least-recently-seen rather than shortening the game', async () => {
    const { service } = configure({
      seen: { 'custom:c1': 300, 'custom:c2': 100, 'custom:c3': 200 },
      bank: ['c1', 'c2', 'c3'].map(customDoc),
    });

    expect(ids(await service.getQuestions(customGame(2)))).toEqual(['c2', 'c3']);
  });

  /**
   * The order is load-bearing rather than incidental, in two directions. New
   * material first is the right way round for a player who abandons a round
   * halfway; and the top-up arriving in a *stable* least-recently-seen order
   * is what keeps a second game reproducible — `sign-in-save-score.spec.ts`
   * plays two rounds in one browser and answers by position, and a draw that
   * reshuffled the second one would break it for a reason that has nothing to
   * do with what it is testing.
   */
  it('serves the unseen first and appends the top-up oldest-first', async () => {
    const { service } = configure({
      seen: { 'custom:c1': 300, 'custom:c2': 100, 'custom:c3': 200 },
      bank: ['c1', 'c2', 'c3', 'c4'].map(customDoc),
    });

    const drawn = await service.getQuestions(customGame(3));

    expect(drawn.map((question) => question.id)).toEqual(['c4', 'c2', 'c3']);
  });

  it('still fills the game when every question in the bank has been answered', async () => {
    const bankIds = ['c1', 'c2', 'c3', 'c4', 'c5'];
    const { service } = configure({
      seen: Object.fromEntries(bankIds.map((id, index) => [`custom:${id}`, index + 1])),
      bank: bankIds.map(customDoc),
    });

    expect(ids(await service.getQuestions(customGame(5)))).toEqual(bankIds);
  });

  it('never serves the same question twice in one round, whichever side it came from', async () => {
    const { service, httpMock } = configure({
      seen: { 'otdb:whatever': 100 },
      // The pool holds the same question the API just returned. One candidate,
      // not two — otherwise the reserve could put a copy of the fetched
      // question back into the round it was already in.
      pool: [poolQuestion('cached', 'Who wrote Hamlet?')],
    });

    const promise = service.getQuestions(openTriviaGame(2));
    httpMock
      .expectOne((r) => r.url === 'https://opentdb.com/api.php')
      .flush({
        response_code: 0,
        results: [openTriviaResult('Who wrote Hamlet?'), openTriviaResult('Who wrote Macbeth?')],
      });

    // Sorted: both are unseen, and the unseen are shuffled among themselves.
    const drawn = await promise;
    expect(drawn.map((question) => question.question).sort()).toEqual([
      'Who wrote Hamlet?',
      'Who wrote Macbeth?',
    ]);
    httpMock.verify();
  });

  /**
   * The one path in the draw that can hand back a shorter game than the bank
   * could have filled, and it is the right trade rather than an oversight.
   * Two questions in one Open Trivia DB page whose wording normalises alike
   * are one candidate — collapsing them is the whole point of a content hash —
   * and inside a page of exactly `amount` there is nothing behind them to
   * promote. A repeat inside a single round is more noticeable than a
   * four-question five.
   */
  it('collapses two identically-worded questions in one page, one question short', async () => {
    const { service, httpMock } = configure({ seen: { 'otdb:whatever': 100 } });

    const promise = service.getQuestions(openTriviaGame(2));
    httpMock
      .expectOne((r) => r.url === 'https://opentdb.com/api.php')
      .flush({
        response_code: 0,
        // Same question, different spacing and case — which is exactly what
        // `normaliseQuestionText` exists to see through.
        results: [openTriviaResult('Who wrote Hamlet?'), openTriviaResult('who  wrote hamlet? ')],
      });

    expect(await promise).toHaveLength(1);
    httpMock.verify();
  });

  /**
   * The read-width rule. A page of exactly the game's question count has
   * nothing to substitute *with*, so the deduplicating draw reads a bounded
   * multiple — and a device that has answered nothing reads exactly what it
   * always did, which is what keeps finding C1's bound where it was for
   * everyone who cannot benefit from widening it.
   */
  it('reads twice the game from the bank when there is a seen-set to filter against', async () => {
    const { service, getCustomQuestions } = configure({ seen: { 'custom:c1': 1 } });

    await service.getQuestions(customGame(5));

    expect(getCustomQuestions).toHaveBeenCalledWith({ category: '', difficulty: '', limit: 10 });
  });

  it('reads exactly the game when the device has answered nothing', async () => {
    const { service, getCustomQuestions } = configure({ seen: null });

    await service.getQuestions(customGame(5));

    expect(getCustomQuestions).toHaveBeenCalledWith({ category: '', difficulty: '', limit: 5 });
  });

  it('caps the widened read, so the longest game does not read fifty documents twice', async () => {
    const { service, getCustomQuestions } = configure({ seen: { 'custom:c1': 1 } });

    await service.getQuestions(customGame(25));

    expect(getCustomQuestions).toHaveBeenCalledWith({ category: '', difficulty: '', limit: 50 });
  });

  it('does not consult the offline pool at all on a plain draw', async () => {
    const { service, getMatchingQuestions } = configure({ seen: null });

    await service.getQuestions(customGame(5));

    expect(getMatchingQuestions).not.toHaveBeenCalled();
  });

  /**
   * **A community question is never substituted from the pool, and this is a
   * moderation rule rather than a cost one.** A pooled question was approved
   * when it was fetched and may have been rejected since; the pool stores no
   * `status` and no client may re-check one, so a draw that reached for it
   * would put a withdrawn question back into an online game — the outcome
   * review-before-publish exists to prevent. The widened bank read is this
   * source's substitute supply, and every candidate it yields came from a
   * query filtered on `status == 'approved'` moments earlier.
   *
   * Asserted as "the pool is not even read", not as "the result happens to
   * hold no pooled question": the second passes whenever the pool is empty,
   * which is most of the time.
   */
  it('never draws on the offline pool for a community question, seen-set or not', async () => {
    const { service, getMatchingQuestions } = configure({
      seen: { 'custom:c1': 100, 'custom:c2': 200 },
      bank: ['c1', 'c2'].map(customDoc),
      pool: [{ ...poolQuestion('cached-1', 'Cached one?'), source: 'custom' as const }],
    });

    const drawn = await service.getQuestions(customGame(5));

    expect(getMatchingQuestions).not.toHaveBeenCalled();
    // Both were answered and there is nothing else approved to swap in, so the
    // round repeats them — which is the honest outcome when the bank is
    // exhausted, and better than serving something nobody has vouched for.
    expect(ids(drawn)).toEqual(['c1', 'c2']);
  });

  /**
   * **The pool substitutes; it never supplies** — live for Open Trivia DB,
   * which is the one source that has a reserve. Letting it lengthen a draw
   * would turn "no questions match this filter", a real result `getQuestions`
   * deliberately leaves alone, into a game served silently from cache with no
   * offline banner to say so; the fallback is for a *failed* fetch.
   */
  it('an empty Open Trivia response stays empty, whatever the pool holds', async () => {
    const { service, httpMock } = configure({
      seen: { 'otdb:whatever': 100 },
      pool: [poolQuestion('cached', 'Cached question?')],
    });

    const promise = service.getQuestions(openTriviaGame(5));
    httpMock
      .expectOne((r) => r.url === 'https://opentdb.com/api.php')
      .flush({ response_code: 1, results: [] });

    expect(await promise).toEqual([]);
    httpMock.verify();
  });

  it('a short Open Trivia page stays short', async () => {
    const seenText = 'Served before?';
    const { service, httpMock } = configure({
      seen: { [seenKeyFor(makeOfflineQuestion(seenText))]: 100 },
      pool: [poolQuestion('cached-1', 'Cached one?'), poolQuestion('cached-2', 'Cached two?')],
    });

    const promise = service.getQuestions(openTriviaGame(5));
    httpMock
      .expectOne((r) => r.url === 'https://opentdb.com/api.php')
      .flush({ response_code: 0, results: [openTriviaResult(seenText)] });

    // The one question the API returned has been answered and the pool holds
    // two that have not, so its slot is substituted — but there is still only
    // one slot, because one is what the network supplied. *Which* of the two
    // unseen fills it is a shuffle, so the assertion is that the repeat did
    // not survive rather than which replacement won.
    const drawn = await promise;
    expect(drawn).toHaveLength(1);
    expect(drawn[0].id.startsWith('cached-')).toBe(true);
    httpMock.verify();
  });

  /**
   * Open Trivia DB gets no widened request — its `amount` is a requirement
   * rather than a ceiling, so asking for more than a narrow category holds
   * returns `response_code: 1` and no questions at all, and its rate limit
   * refuses a second call in the same draw. Its substitutions come from the
   * offline pool instead.
   */
  it('asks Open Trivia DB for exactly the game, seen-set or not', async () => {
    const { service, httpMock } = configure({ seen: { 'otdb:whatever': 1 } });

    const promise = service.getQuestions({
      amount: 5,
      category: '',
      difficulty: '',
      source: 'open_trivia',
      timeLimit: 15,
    });
    const request = httpMock.expectOne((r) => r.url === 'https://opentdb.com/api.php');
    expect(request.request.params.get('amount')).toBe('5');
    request.flush({ response_code: 0, results: [] });
    await promise;
    httpMock.verify();
  });

  it('substitutes an Open Trivia repeat with an unseen question from the offline pool', async () => {
    const cached = poolQuestion('cached-1', 'A question from the pool?');
    const { service, httpMock, getMatchingQuestions } = configure({
      seen: { [seenKeyFor(makeOfflineQuestion('Served before?'))]: 100 },
      pool: [cached],
    });

    const promise = service.getQuestions({
      amount: 1,
      category: '',
      difficulty: '',
      source: 'open_trivia',
      timeLimit: 15,
    });
    httpMock
      .expectOne((r) => r.url === 'https://opentdb.com/api.php')
      .flush({
        response_code: 0,
        results: [
          {
            category: 'Science',
            type: 'multiple',
            difficulty: 'easy',
            question: 'Served before?',
            correct_answer: 'A',
            incorrect_answers: ['B', 'C', 'D'],
          },
        ],
      });

    const drawn = await promise;
    expect(drawn.map((question) => question.question)).toEqual(['A question from the pool?']);
    // Source-scoped, and filtered by the game's own category/difficulty — a
    // substitution that ignored either would drop an off-topic question into a
    // game the player filtered.
    expect(getMatchingQuestions).toHaveBeenCalledWith('open_trivia', '', '');
    httpMock.verify();
  });
});
