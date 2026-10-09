import { TestBed } from '@angular/core/testing';
import { TriviaQuestion } from '../models/question.model';
import { FirebaseService, RawDocument } from './firebase.service';
import { QuizService } from './quiz.service';
import { TriviaService } from './trivia.service';

/**
 * `QuizService` (`FEAT-024`): what loading a quiz finds, and the reading of
 * what came back. The two reads behind it are faked — `firebase.service.spec`
 * pins their wire shape and `trivia.service.spec` the order they resolve in —
 * so what is under test here is the decision between the states.
 */

const STORED = {
  title: 'The 1998 World Cup',
  description: 'Ten questions.',
  questionIds: ['q-1', 'q-2', 'q-3'],
  createdBy: 'curator-uid',
  createdAt: 1_759_900_000_000,
  isPublished: true,
};

function question(id: string): TriviaQuestion {
  return {
    id,
    type: 'multiple',
    difficulty: 'easy',
    question: `Question ${id}?`,
    correct_answer: 'A',
    incorrect_answers: ['B'],
    all_answers: [
      { id: `${id}:correct`, text: 'A', isCorrect: true },
      { id: `${id}:incorrect-0`, text: 'B', isCorrect: false },
    ],
    source: 'custom',
  };
}

function setup(options: {
  quiz?: RawDocument | null | Error;
  questions?: TriviaQuestion[] | Error;
  list?: RawDocument[] | Error;
}) {
  const getQuiz = vi.fn((id: string) => {
    void id;
    return options.quiz instanceof Error
      ? Promise.reject(options.quiz)
      : Promise.resolve(options.quiz ?? null);
  });
  const getPublishedQuizzes = vi.fn(() =>
    options.list instanceof Error
      ? Promise.reject(options.list)
      : Promise.resolve(options.list ?? []),
  );
  const getQuizQuestions = vi.fn((ids: readonly string[]) => {
    void ids;
    return options.questions instanceof Error
      ? Promise.reject(options.questions)
      : Promise.resolve(options.questions ?? []);
  });
  TestBed.configureTestingModule({
    providers: [
      { provide: FirebaseService, useValue: { getQuiz, getPublishedQuizzes } },
      { provide: TriviaService, useValue: { getQuizQuestions } },
    ],
  });
  return { service: TestBed.inject(QuizService), getQuiz, getQuizQuestions, getPublishedQuizzes };
}

describe('QuizService.load', () => {
  it('finds a published quiz ready to play, with the questions it can play', async () => {
    const questions = [question('q-1'), question('q-2'), question('q-3')];
    const { service, getQuizQuestions } = setup({
      quiz: { id: 'world-cup-1998', data: STORED },
      questions,
    });

    const load = await service.load('world-cup-1998');

    expect(load).toEqual({
      kind: 'ready',
      quiz: { id: 'world-cup-1998', ...STORED },
      questions,
      unavailable: 0,
    });
    // The quiz's own ids, in its own order, are what is resolved.
    expect(getQuizQuestions).toHaveBeenCalledWith(['q-1', 'q-2', 'q-3']);
  });

  // The administrator's decision of 8 October 2026, over FEAT-024 §0.4: a
  // question that is gone or no longer approved is skipped, and the quiz plays
  // what remains — counted, so the page can say so before Start.
  it('counts the questions it cannot play, and plays the rest', async () => {
    const { service } = setup({
      quiz: { id: 'world-cup-1998', data: STORED },
      questions: [question('q-2')],
    });

    const load = await service.load('world-cup-1998');

    expect(load.kind).toBe('ready');
    expect(load.kind === 'ready' && load.unavailable).toBe(2);
    expect(load.kind === 'ready' && load.questions.map((q) => q.id)).toEqual(['q-2']);
  });

  it('is empty, not ready, when none of its questions can be played', async () => {
    const { service } = setup({ quiz: { id: 'world-cup-1998', data: STORED }, questions: [] });

    expect(await service.load('world-cup-1998')).toEqual({
      kind: 'empty',
      quiz: { id: 'world-cup-1998', ...STORED },
    });
  });

  it('is not found when there is no published quiz at the address', async () => {
    const { service, getQuizQuestions } = setup({ quiz: null });

    expect(await service.load('never-written')).toEqual({ kind: 'notFound' });
    expect(getQuizQuestions).not.toHaveBeenCalled();
  });

  // Unreachable through the rules, which serve nothing else — and a reader that
  // trusted that would start showing drafts the day the rule was widened.
  it('is not found for an unpublished document, whatever the rules served', async () => {
    const { service } = setup({
      quiz: { id: 'draft', data: { ...STORED, isPublished: false } },
      questions: [question('q-1')],
    });

    expect(await service.load('draft')).toEqual({ kind: 'notFound' });
  });

  it('is not found for a document with no title to show', async () => {
    const { service } = setup({ quiz: { id: 'untitled', data: { ...STORED, title: '' } } });

    expect(await service.load('untitled')).toEqual({ kind: 'notFound' });
  });

  // Straight from the URL, so it is checked before it is a path: a `/` in it
  // would otherwise be a document path the REST client refuses with a throw.
  it('is not found, without a read, for an address that cannot name a document', async () => {
    const { service, getQuiz } = setup({ quiz: { id: 'x', data: STORED } });

    for (const address of ['', 'a/b', '..', '__reserved__']) {
      expect(await service.load(address), address).toEqual({ kind: 'notFound' });
    }
    expect(getQuiz).not.toHaveBeenCalled();
  });

  // A failed read is not "no such quiz" (`CLAUDE.md` §4.4): it throws, so the
  // page can offer a retry instead of telling the player the quiz is gone.
  it('throws when the quiz cannot be read', async () => {
    const { service } = setup({ quiz: new Error('network') });

    await expect(service.load('world-cup-1998')).rejects.toThrow('network');
  });

  it('throws when the questions cannot be read', async () => {
    const { service } = setup({
      quiz: { id: 'world-cup-1998', data: STORED },
      questions: new Error('timeout'),
    });

    await expect(service.load('world-cup-1998')).rejects.toThrow('timeout');
  });
});

describe('QuizService.listPublished', () => {
  it('reads every quiz the list returned, in the order it returned them', async () => {
    const { service } = setup({
      list: [
        { id: 'newer', data: STORED },
        { id: 'older', data: { ...STORED, title: 'Older' } },
      ],
    });

    expect((await service.listPublished()).map((quiz) => quiz.id)).toEqual(['newer', 'older']);
  });

  // A link to a quiz that can never start, or one with nothing to call it,
  // is worse than no link.
  it('leaves out what the app cannot use: no title, unpublished, no questions', async () => {
    const { service } = setup({
      list: [
        { id: 'good', data: STORED },
        { id: 'untitled', data: { ...STORED, title: ' ' } },
        { id: 'draft', data: { ...STORED, isPublished: false } },
        { id: 'empty', data: { ...STORED, questionIds: ['a/b'] } },
      ],
    });

    expect((await service.listPublished()).map((quiz) => quiz.id)).toEqual(['good']);
  });

  it('throws when the list cannot be read', async () => {
    const { service } = setup({ list: new Error('refused') });

    await expect(service.listPublished()).rejects.toThrow('refused');
  });
});
