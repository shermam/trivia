import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { Answer, TriviaQuestion } from '../../models/question.model';
import { GameControllerService } from '../../services/game-controller.service';
import { TriviaService } from '../../services/trivia.service';
import { QuizLoopComponent } from './quiz-loop.component';

/**
 * Finding B5. `TriviaService.playingOffline` was set the moment a game fell
 * back to the cached offline pool, and read by nothing — so a player mid-way
 * through a game on stale cached questions was never told. This pins that the
 * `/play` screen renders a banner exactly when that signal is true, which the
 * old dead-code state would have failed.
 */

function makeQuestion(): TriviaQuestion {
  const all_answers: Answer[] = [
    { id: 'q1:correct', text: 'Paris', isCorrect: true },
    { id: 'q1:incorrect-0', text: 'London', isCorrect: false },
  ];
  return {
    id: 'q1',
    category: 'Geography',
    type: 'multiple',
    difficulty: 'easy',
    question: 'Capital of France?',
    correct_answer: 'Paris',
    incorrect_answers: ['London'],
    all_answers,
    source: 'open_trivia',
  };
}

function setup(playingOffline: boolean) {
  const currentQuestion = signal<TriviaQuestion | null>(makeQuestion());

  TestBed.configureTestingModule({
    providers: [
      {
        provide: GameControllerService,
        useValue: {
          currentQuestion,
          currentIndex: signal(0),
          totalQuestions: signal(1),
          score: signal(0),
          progressPercentage: signal(100),
          isLastQuestion: signal(true),
          registerAnswer: () => undefined,
          advanceQuestion: () => undefined,
        },
      },
      {
        provide: TriviaService,
        useValue: { playingOffline: signal(playingOffline) },
      },
      { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
    ],
  });

  const fixture = TestBed.createComponent(QuizLoopComponent);
  fixture.detectChanges();
  return fixture;
}

describe('QuizLoopComponent — offline banner (B5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // The countdown starts an interval in ngOnInit; destroying clears it.
    vi.useRealTimers();
  });

  it('shows the offline banner when playingOffline is true', () => {
    const fixture = setup(true);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('these questions are from your saved offline pool');
    fixture.destroy();
  });

  it('hides the offline banner when playingOffline is false', () => {
    const fixture = setup(false);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('saved offline pool');
    fixture.destroy();
  });
});
