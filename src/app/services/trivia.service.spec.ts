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
    // The seed tag is looked up by the *decoded* name, which is why the two
    // transformations sit together in the adapter (`FEAT-052`).
    expect(question.tags).toEqual(['science-nature']);
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

  /**
   * The difficulty counters (`FEAT-023`) ride the question the draw already
   * read, so the recap can derive a calibrated difficulty with no second read
   * per question — and they are re-checked on the way in, the way the tags are,
   * so a pair the rules would refuse never reaches a reader.
   */
  it('carries the difficulty counters a bank question holds', async () => {
    configure([{ ...base, answered: 40, correct: 12 }]);

    const [question] = await play();

    expect(question.answered).toBe(40);
    expect(question.correct).toBe(12);
  });

  it('leaves the counters absent on a question nobody has played', async () => {
    configure([base]);

    const [question] = await play();

    expect('answered' in question).toBe(false);
    expect('correct' in question).toBe(false);
  });

  it('drops a broken pair whole rather than carrying half of it', async () => {
    configure([{ ...base, answered: 3, correct: 9 }]);

    const [question] = await play();

    expect('answered' in question).toBe(false);
    expect('correct' in question).toBe(false);
  });

  /**
   * `FEAT-020`. A question the generation pipeline wrote carries a
   * `provenance` map, and the one reader of it in a game — the recap's
   * "Machine-generated from" line — needs one fact out of it. That fact is
   * carried and nothing else: the model and the run would otherwise ride
   * into the saved game and the offline pool for nobody to read.
   */
  it('carries the one fact the label needs from a generated question’s provenance', async () => {
    configure([
      {
        ...base,
        createdBy: '[generated]',
        provenance: {
          source: 'ai',
          provider: 'example-provider',
          model: 'example-model',
          modelVersion: 'example-model-2026-10-01',
          generatedAt: 1_760_000_000_000,
          runId: '20261009T120000Z-water',
        },
      },
    ]);

    const [question] = await play();

    expect(question.provenance).toEqual({ source: 'ai' });
  });

  it('carries no provenance for a question a person wrote', async () => {
    configure([base]);

    const [question] = await play();

    expect('provenance' in question).toBe(false);
  });

  // Re-checked like the tags and the counters: the console can write any
  // shape, and anything but a map saying `ai` reads as a person's question.
  it.each([
    ['a different source', { source: 'human', runId: 'r' }],
    ['a bare string', 'ai'],
    ['null', null],
  ])('carries none for %s', async (_label, provenance) => {
    configure([{ ...base, provenance }]);

    const [question] = await play();

    expect('provenance' in question).toBe(false);
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
 * Finding C1. The topic/difficulty filter and the amount ceiling used to be
 * applied here, in the browser, over every document in the collection. They are
 * the query's job now — so what this layer must get right is *forwarding* them.
 * Dropping that would be silent: the game would still run, still show custom
 * questions, and simply ignore the topics and difficulty the player picked.
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

  it('passes the chosen topics, difficulty and amount to the query', async () => {
    const { service, getCustomQuestions } = setupWithSpy();

    await service.getQuestions({
      amount: 7,
      difficulty: 'hard',
      source: 'custom',
      timeLimit: 15,
      tags: ['history'],
    });

    expect(getCustomQuestions).toHaveBeenCalledWith({
      difficulty: 'hard',
      limit: 7,
      tags: ['history'],
    });
  });

  it('asks for only its half of a mixed game, not the whole amount', async () => {
    const { service, getCustomQuestions } = setupWithSpy();
    const httpMock = TestBed.inject(HttpTestingController);

    const promise = service.getQuestions({
      amount: 10,
      difficulty: '',
      source: 'mixed',
      timeLimit: 15,
    });
    httpMock.expectOne((r) => r.url.includes('api.php')).flush({ response_code: 0, results: [] });
    await promise;

    // Mixed splits 10 into 5 from each source; asking for 10 here would double
    // the read this finding exists to bound.
    expect(getCustomQuestions).toHaveBeenCalledWith({
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
    return { amount, difficulty: '', source: 'custom', timeLimit: 15 } as const;
  }

  function openTriviaGame(amount: number) {
    return { amount, difficulty: '', source: 'open_trivia', timeLimit: 15 } as const;
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

    expect(getCustomQuestions).toHaveBeenCalledWith({ difficulty: '', limit: 10 });
  });

  it('reads exactly the game when the device has answered nothing', async () => {
    const { service, getCustomQuestions } = configure({ seen: null });

    await service.getQuestions(customGame(5));

    expect(getCustomQuestions).toHaveBeenCalledWith({ difficulty: '', limit: 5 });
  });

  it('caps the widened read, so the longest game does not read fifty documents twice', async () => {
    const { service, getCustomQuestions } = configure({ seen: { 'custom:c1': 1 } });

    await service.getQuestions(customGame(25));

    expect(getCustomQuestions).toHaveBeenCalledWith({ difficulty: '', limit: 50 });
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
   * rather than a ceiling, so asking for more than a narrow topic holds
   * returns `response_code: 1` and no questions at all, and its rate limit
   * refuses a second call in the same draw. Its substitutions come from the
   * offline pool instead.
   */
  it('asks Open Trivia DB for exactly the game, seen-set or not', async () => {
    const { service, httpMock } = configure({ seen: { 'otdb:whatever': 1 } });

    const promise = service.getQuestions({
      amount: 5,
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
    // Source-scoped, and filtered by the topic this draw follows and the
    // game's difficulty — a substitution that ignored either would drop an
    // off-topic question into a game the player filtered.
    expect(getMatchingQuestions).toHaveBeenCalledWith('open_trivia', [], '');
    httpMock.verify();
  });
});

/**
 * `FEAT-021`, `FEAT-052`. Where the player's topic selection goes — and, more
 * importantly, where it does not.
 */
describe('TriviaService topic tags (FEAT-021)', () => {
  function taggedDoc(id: string, tags?: unknown) {
    return {
      id,
      category: 'Science',
      type: 'multiple',
      difficulty: 'easy',
      question: `Question ${id}?`,
      correct_answer: 'A',
      incorrect_answers: ['B', 'C', 'D'],
      ...(tags === undefined ? {} : { tags }),
    };
  }

  function configure(bank: unknown[] = []) {
    const getCustomQuestions = vi.fn(() => of(bank));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FirebaseService, useValue: { getCustomQuestions } },
        {
          provide: OfflineQuestionsService,
          useValue: {
            getMatchingQuestions: () => Promise.resolve([]),
            getOfflineQuestions: () => Promise.resolve([]),
          },
        },
        {
          provide: SeenQuestionsService,
          useValue: { readSeenSet: () => Promise.resolve(null), markSeen: () => Promise.resolve() },
        },
      ],
    });
    return {
      service: TestBed.inject(TriviaService),
      httpMock: TestBed.inject(HttpTestingController),
      getCustomQuestions,
    };
  }

  afterEach(() => TestBed.resetTestingModule());

  it('passes the selection to the bank query', async () => {
    const { service, getCustomQuestions } = configure();

    await service.getQuestions({
      amount: 5,
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
      tags: ['world-war-2'],
    });

    expect(getCustomQuestions).toHaveBeenCalledWith({
      difficulty: '',
      limit: 5,
      tags: ['world-war-2'],
    });
  });

  /**
   * The any-topic promise, asserted on the **shape of the options object**: no
   * selection means no `tags` key at all, not an empty one — and no `category`
   * key either, since topics replaced categories (`FEAT-052`). This is exactly
   * the query an "Any Category" game always sent; a clause that leaked into it
   * would narrow every game to whatever happens to be tagged.
   */
  it('sends no tags key at all when nothing is selected', async () => {
    const { service, getCustomQuestions } = configure();

    await service.getQuestions({
      amount: 5,
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });
    await service.getQuestions({
      amount: 5,
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
      tags: [],
    });

    expect(getCustomQuestions).toHaveBeenNthCalledWith(1, {
      difficulty: '',
      limit: 5,
    });
    expect(getCustomQuestions).toHaveBeenNthCalledWith(2, {
      difficulty: '',
      limit: 5,
    });
  });

  /**
   * A Mixed selection with no seed tag in it narrows the community half and
   * draws the Open Trivia half unfiltered — `calculus` is not one of Open
   * Trivia's former categories, so there is no `category` it could be sent as.
   * The setup screen's hint says so before Start.
   */
  it('narrows only the community half of a mixed game with no seed tag', async () => {
    const { service, getCustomQuestions, httpMock } = configure();

    const promise = service.getQuestions({
      amount: 10,
      difficulty: '',
      source: 'mixed',
      timeLimit: 15,
      tags: ['calculus'],
    });

    const request = httpMock.expectOne((r) => r.url === 'https://opentdb.com/api.php');
    // No category reaches Open Trivia DB — the selection holds no seed tag.
    expect(request.request.params.keys()).toEqual(['amount']);
    request.flush({ response_code: 0, results: [] });
    await promise;

    expect(getCustomQuestions).toHaveBeenCalledWith({
      difficulty: '',
      limit: 5,
      tags: ['calculus'],
    });
    httpMock.verify();
  });

  /**
   * The request runs the seed-tag table backwards (`FEAT-052`): an Open Trivia
   * game's one seed tag becomes the API's numeric `category`, straight from the
   * table — no fetched category list, and no `api_category.php` request, which
   * `httpMock.verify()` would report.
   */
  it('sends an Open Trivia game’s seed tag as the table’s category id', async () => {
    const { service, httpMock, getCustomQuestions } = configure();

    const promise = service.getQuestions({
      amount: 5,
      difficulty: 'hard',
      source: 'open_trivia',
      timeLimit: 15,
      tags: ['history'],
    });

    const request = httpMock.expectOne((r) => r.url === 'https://opentdb.com/api.php');
    expect(request.request.params.get('category')).toBe('23');
    expect(request.request.params.get('difficulty')).toBe('hard');
    request.flush({ response_code: 0, results: [] });
    await promise;

    expect(getCustomQuestions).not.toHaveBeenCalled();
    httpMock.verify();
  });

  /**
   * A Mixed game's Open Trivia half follows the **first seed tag** in the
   * selection — the API takes one `category` per request — while the community
   * half filters on every tag, seed or not.
   */
  it('sends a mixed game’s first seed tag to Open Trivia and every tag to the bank', async () => {
    const { service, httpMock, getCustomQuestions } = configure();

    const promise = service.getQuestions({
      amount: 10,
      difficulty: '',
      source: 'mixed',
      timeLimit: 15,
      tags: ['calculus', 'sports', 'history'],
    });

    const request = httpMock.expectOne((r) => r.url === 'https://opentdb.com/api.php');
    expect(request.request.params.get('category')).toBe('21');
    expect(request.request.params.get('amount')).toBe('5');
    request.flush({ response_code: 0, results: [] });
    await promise;

    expect(getCustomQuestions).toHaveBeenCalledWith({
      difficulty: '',
      limit: 5,
      tags: ['calculus', 'sports', 'history'],
    });
    httpMock.verify();
  });

  it('sends no category to Open Trivia when no topic is chosen', async () => {
    const { service, httpMock } = configure();

    const promise = service.getQuestions({
      amount: 5,
      difficulty: '',
      source: 'open_trivia',
      timeLimit: 15,
    });

    const request = httpMock.expectOne((r) => r.url === 'https://opentdb.com/api.php');
    expect(request.request.params.keys()).toEqual(['amount']);
    request.flush({ response_code: 0, results: [] });
    await promise;
    httpMock.verify();
  });

  /**
   * The response runs the table forwards: every fetched question carries its
   * category's seed tag in memory, so the quiz card, the offline pool and the
   * setup screen read an Open Trivia question's topic exactly as they read a
   * contribution's. A name the table does not know yields no tag — and the
   * question is still served.
   */
  it('stamps each fetched Open Trivia question with its seed tag, and serves an unknown one bare', async () => {
    const { service, httpMock } = configure();

    const promise = service.getQuestions({
      amount: 2,
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
            category: 'Entertainment: Video Games',
            type: 'multiple',
            difficulty: 'easy',
            question: 'Who is the plumber?',
            correct_answer: 'Mario',
            incorrect_answers: ['Link', 'Kirby', 'Sonic'],
          },
          {
            category: 'Entertainment: Podcasts',
            type: 'boolean',
            difficulty: 'easy',
            question: 'Podcasts exist.',
            correct_answer: 'True',
            incorrect_answers: ['False'],
          },
        ],
      });

    const questions = await promise;
    const byText = (text: string) => questions.find((question) => question.question === text)!;
    expect(byText('Who is the plumber?').tags).toEqual(['video-games']);
    expect('tags' in byText('Podcasts exist.')).toBe(false);
    expect(questions).toHaveLength(2);
    httpMock.verify();
  });

  /**
   * The deduplicating Open Trivia draw substitutes from the offline pool
   * narrowed to the topic it was drawn under — the seed tag it followed, not
   * the whole selection, since that is all the request asked the API for.
   */
  it('narrows the Open Trivia reserve to the seed tag the draw followed', async () => {
    const getMatchingQuestions = vi.fn(() => Promise.resolve([]));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FirebaseService, useValue: { getCustomQuestions: () => of([]) } },
        {
          provide: OfflineQuestionsService,
          useValue: { getMatchingQuestions, getOfflineQuestions: () => Promise.resolve([]) },
        },
        {
          provide: SeenQuestionsService,
          useValue: {
            readSeenSet: () => Promise.resolve(new Map([['otdb:whatever', 1]])),
            markSeen: () => Promise.resolve(),
          },
        },
      ],
    });
    const service = TestBed.inject(TriviaService);
    const httpMock = TestBed.inject(HttpTestingController);

    const promise = service.getQuestions({
      amount: 1,
      difficulty: '',
      source: 'mixed',
      timeLimit: 15,
      tags: ['cold-war', 'history'],
    });
    httpMock
      .expectOne((r) => r.url === 'https://opentdb.com/api.php')
      .flush({
        response_code: 0,
        results: [
          {
            category: 'History',
            type: 'boolean',
            difficulty: 'easy',
            question: 'The Berlin Wall fell in 1989.',
            correct_answer: 'True',
            incorrect_answers: ['False'],
          },
        ],
      });
    await promise;

    expect(getMatchingQuestions).toHaveBeenCalledWith('open_trivia', ['history'], '');
    httpMock.verify();
  });

  it('reads the stored tags onto the question it maps', async () => {
    const { service } = configure([taggedDoc('c1', ['world-war-2', 'treaties'])]);

    const [question] = await service.getQuestions({
      amount: 1,
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });

    expect(question.tags).toEqual(['world-war-2', 'treaties']);
  });

  /**
   * `custom_questions` is a public API a console can write to directly, so the
   * mapper checks what it was handed rather than trusting it (`CLAUDE.md`
   * §4.4). The `tags` key is left **off** entirely when nothing survives, so an
   * untagged question does not serialise an empty array into the saved-game
   * snapshot and the offline pool.
   */
  it('drops a stored value that is not a usable tag list, key and all', async () => {
    const { service } = configure([
      taggedDoc('c1', ['Shouty', 42, 'a']),
      taggedDoc('c2', 'not-a-list'),
      taggedDoc('c3'),
    ]);

    const questions = await service.getQuestions({
      amount: 3,
      difficulty: '',
      source: 'custom',
      timeLimit: 15,
    });

    for (const question of questions) {
      expect('tags' in question).toBe(false);
    }
  });
});

describe('TriviaService.getQuizQuestions (FEAT-024)', () => {
  /** A bank document as `getApprovedQuestionsByIds` hands it back. */
  function bankDoc(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      type: 'multiple' as const,
      difficulty: 'easy' as const,
      question: `Question ${id}?`,
      correct_answer: 'Right',
      incorrect_answers: ['Wrong 1', 'Wrong 2', 'Wrong 3'],
      status: 'approved' as const,
      tags: ['football'],
      ...overrides,
    };
  }

  function setup(docs: ReturnType<typeof bankDoc>[]) {
    const getApprovedQuestionsByIds = vi.fn((ids: readonly string[]) => {
      void ids;
      return Promise.resolve(docs);
    });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: FirebaseService, useValue: { getApprovedQuestionsByIds } },
        nothingSeenYet(),
      ],
    });
    return { service: TestBed.inject(TriviaService), getApprovedQuestionsByIds };
  }

  // The one promise a curated quiz makes is that somebody chose these questions
  // in this order, so the order is the quiz's whatever order the query answers
  // in — a query by document id comes back sorted by id.
  it('plays the questions in the quiz’s own order, not the order the read returned', async () => {
    const { service } = setup([bankDoc('a-first'), bankDoc('b-second'), bankDoc('c-third')]);

    const questions = await service.getQuizQuestions(['c-third', 'a-first', 'b-second']);

    expect(questions.map((question) => question.id)).toEqual(['c-third', 'a-first', 'b-second']);
  });

  it('shuffles each question’s answers but keeps them all, as every bank question does', async () => {
    const { service } = setup([bankDoc('q-1')]);

    const [question] = await service.getQuizQuestions(['q-1']);

    expect(question.source).toBe('custom');
    expect(question.tags).toEqual(['football']);
    expect(question.all_answers.map((answer) => answer.text).sort()).toEqual([
      'Right',
      'Wrong 1',
      'Wrong 2',
      'Wrong 3',
    ]);
    expect(question.all_answers.filter((answer) => answer.isCorrect)).toEqual([
      { id: 'q-1:correct', text: 'Right', isCorrect: true },
    ]);
  });

  it('skips an id the read did not return, and plays what remains', async () => {
    const { service } = setup([bankDoc('q-1'), bankDoc('q-3')]);

    const questions = await service.getQuizQuestions(['q-1', 'q-2-withdrawn', 'q-3']);

    expect(questions.map((question) => question.id)).toEqual(['q-1', 'q-3']);
  });

  // A console-broken document is one more question the quiz skips, rather than
  // a throw from the mapper that takes every question down with it.
  it('skips a document too broken to play', async () => {
    const { service } = setup([
      bankDoc('good'),
      bankDoc('no-wrong-answers', { incorrect_answers: [] }),
      bankDoc('not-a-list', { incorrect_answers: 'Wrong' }),
      bankDoc('odd-difficulty', { difficulty: 'expert' }),
      bankDoc('no-text', { question: '' }),
    ]);

    const questions = await service.getQuizQuestions([
      'no-wrong-answers',
      'good',
      'not-a-list',
      'odd-difficulty',
      'no-text',
    ]);

    expect(questions.map((question) => question.id)).toEqual(['good']);
  });

  it('plays a question the list names twice only once', async () => {
    const { service } = setup([bankDoc('q-1'), bankDoc('q-2')]);

    const questions = await service.getQuizQuestions(['q-1', 'q-2', 'q-1']);

    expect(questions.map((question) => question.id)).toEqual(['q-1', 'q-2']);
  });

  // The loop's offline banner reads this, and a quiz is never served from the
  // pool — so one played after an offline round must not inherit the banner.
  it('clears the offline flag a previous offline round left behind', async () => {
    const { service } = setup([bankDoc('q-1')]);
    service.playingOffline.set(true);

    await service.getQuizQuestions(['q-1']);

    expect(service.playingOffline()).toBe(false);
  });

  it('lets a failed read throw rather than falling back to the offline pool', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: FirebaseService,
          useValue: { getApprovedQuestionsByIds: () => Promise.reject(new Error('offline')) },
        },
        nothingSeenYet(),
      ],
    });

    await expect(TestBed.inject(TriviaService).getQuizQuestions(['q-1'])).rejects.toThrow(
      'offline',
    );
  });
});
