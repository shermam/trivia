import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Answer, TriviaQuestion } from '../models/question.model';
import { GameControllerService } from './game-controller.service';
import { TriviaService } from './trivia.service';

/**
 * Finding B7. The quiz progress bar divided the zero-based `currentIndex` by
 * the question count, so it was a full question out at every step: 0% while
 * the player looked at question 1, and 90% on the last of ten. It could never
 * reach 100%, because `advanceQuestion()` navigates to the game-over screen
 * instead of incrementing past the end — so the bar's final state was simply
 * never rendered.
 *
 * It also disagreed with the "Question N / M" label sitting directly beside
 * it, which counts from one.
 */

function makeQuestion(id: string): TriviaQuestion {
  const answers: Answer[] = [
    { id: `${id}:correct`, text: 'A', isCorrect: true },
    { id: `${id}:incorrect-0`, text: 'B', isCorrect: false },
  ];
  return {
    id,
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question: `Question ${id}?`,
    correct_answer: 'A',
    incorrect_answers: ['B'],
    all_answers: answers,
    source: 'open_trivia',
  };
}

function setup(questionCount: number) {
  TestBed.configureTestingModule({
    providers: [
      { provide: TriviaService, useValue: { getQuestions: () => Promise.resolve([]) } },
      { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
    ],
  });
  const service = TestBed.inject(GameControllerService);
  service.questions.set(Array.from({ length: questionCount }, (_, i) => makeQuestion(`q${i}`)));
  return service;
}

describe('GameControllerService progress', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows one question of ten as 10%, not 0%', () => {
    const service = setup(10);

    expect(service.currentIndex()).toBe(0);
    expect(service.progressPercentage()).toBe(10);
  });

  // The bar has to agree with the "Question N / M" label beside it, which
  // counts from one — otherwise one of the two is lying at every step.
  it('agrees with the question counter at every step', () => {
    const service = setup(5);

    for (let index = 0; index < 5; index++) {
      service.currentIndex.set(index);
      const label = index + 1;
      expect(service.progressPercentage()).toBe((label / 5) * 100);
    }
  });

  it('is full on the last question, which is as far as the bar ever gets', () => {
    const service = setup(10);
    service.currentIndex.set(9);

    expect(service.isLastQuestion()).toBe(true);
    expect(service.progressPercentage()).toBe(100);
  });

  it('is full immediately for a single-question game', () => {
    const service = setup(1);

    expect(service.progressPercentage()).toBe(100);
  });

  // `/play` redirects when there is no active question, but a computed signal
  // shouldn't produce NaN on the way there — `[style.width.%]="NaN"` is an
  // invalid declaration the browser drops silently.
  it('reports 0 rather than NaN when there are no questions', () => {
    const service = setup(0);

    expect(service.progressPercentage()).toBe(0);
    expect(Number.isNaN(service.progressPercentage())).toBe(false);
  });

  // Guards the neighbouring signal, whose name is one word away: `percentage`
  // is accuracy, `progressPercentage` is position, and they answer different
  // questions.
  it('tracks position, not score', () => {
    const service = setup(10);
    service.currentIndex.set(4);
    service.score.set(1);

    expect(service.progressPercentage()).toBe(50);
    expect(service.percentage()).toBe(10);
  });
});
