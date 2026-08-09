import 'fake-indexeddb/auto';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { TriviaQuestion } from '../models/question.model';
import { FirebaseService } from './firebase.service';
import { OfflineQuestionsService } from './offline-questions.service';
import { TriviaService } from './trivia.service';

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
      triviaService.getQuestions({ amount: 5, category: '', difficulty: '', source: 'custom' }),
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
    });

    httpMock
      .expectOne((req) => req.url === 'https://opentdb.com/api.php')
      .error(new ProgressEvent('error'));

    await expect(promise).rejects.toBeTruthy();
  });

  it('initOfflinePrefetch() does not schedule anything when navigator.webdriver is true', () => {
    // navigator.webdriver is set by every browser-automation framework (Cypress, Selenium,
    // Playwright) — a real preview-e2e CI run confirmed this task's own background requests
    // can compete with the same Cypress-driven tests for a real, shared, rate-limited backend
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
