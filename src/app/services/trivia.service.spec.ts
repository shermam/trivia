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
    const openRequest = indexedDB.open('trivia-offline', 1);
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
    all_answers: ['A', 'B', 'C', 'D'],
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
