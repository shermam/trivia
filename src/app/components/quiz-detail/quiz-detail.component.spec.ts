import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TimeLimitOption, TriviaQuestion } from '../../models/question.model';
import { Quiz, QuizContext } from '../../models/quiz.model';
import { ConnectivityService } from '../../services/connectivity.service';
import { DailyGameLimitService } from '../../services/daily-game-limit.service';
import { GameControllerService } from '../../services/game-controller.service';
import { QuizLoad, QuizService } from '../../services/quiz.service';
import { SubscriptionService } from '../../services/subscription.service';
import { QuizDetailComponent } from './quiz-detail.component';

/**
 * `/quiz/:quizId` (`FEAT-024`). Rendered through the real router, so the id
 * reaches the screen the way it does in the app — as a route parameter — and a
 * second quiz's address reuses the component the way a link between two quizzes
 * does.
 *
 * jsdom has no layout, so what the size rule needs (`CLAUDE.md` §4.4) is
 * measured by `e2e/specs/unauthenticated/curated-quiz.spec.ts`; these pin the
 * states, the time-limit guard and what Start hands the controller.
 */

function quiz(overrides: Partial<Quiz> = {}): Quiz {
  return {
    id: 'world-cup-1998',
    title: 'The 1998 World Cup',
    description: 'Ten questions, in the order the tournament played them.',
    questionIds: ['q-1', 'q-2', 'q-3'],
    createdBy: 'curator-uid',
    createdAt: 1_759_900_000_000,
    isPublished: true,
    ...overrides,
  };
}

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

function ready(overrides: Partial<Quiz> = {}, playable = 3): QuizLoad {
  const found = quiz(overrides);
  return {
    kind: 'ready',
    quiz: found,
    questions: found.questionIds.slice(0, playable).map(question),
    unavailable: found.questionIds.length - playable,
  };
}

interface Options {
  load?: (id: string) => Promise<QuizLoad>;
  startQuiz?: (
    quiz: QuizContext,
    questions: readonly TriviaQuestion[],
    timeLimit: TimeLimitOption,
  ) => Promise<boolean>;
  hasGamesLeft?: boolean;
  online?: boolean;
  resumable?: boolean;
}

async function render(url: string, options: Options = {}) {
  const load = vi.fn(options.load ?? (() => Promise.resolve(ready())));
  const limitReached = signal(false);
  const isLoading = signal(false);
  const hasGamesLeft = signal(options.hasGamesLeft ?? true);
  const hasResumableGame = signal(options.resumable ?? false);
  const startQuiz = vi.fn(options.startQuiz ?? (() => Promise.resolve(true)));
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'quiz/:quizId', component: QuizDetailComponent }]),
      { provide: QuizService, useValue: { load } },
      {
        provide: GameControllerService,
        useValue: {
          startQuiz,
          isLoading,
          limitReached,
          hasResumableGame,
        },
      },
      {
        provide: DailyGameLimitService,
        useValue: {
          isUnlimited: signal(false),
          hasGamesLeft,
          remaining: signal(4),
          refresh: vi.fn(() => Promise.resolve()),
        },
      },
      { provide: SubscriptionService, useValue: { primePricing: vi.fn() } },
      { provide: ConnectivityService, useValue: { isOnline: signal(options.online ?? true) } },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url, QuizDetailComponent);
  // The read is a resolved promise; let it land and render.
  await harness.fixture.whenStable();
  harness.detectChanges();
  return {
    harness,
    host: harness.routeNativeElement as HTMLElement,
    load,
    startQuiz,
    limitReached,
    isLoading,
    hasGamesLeft,
    hasResumableGame,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const text = (host: HTMLElement, cy: string) =>
  host.querySelector(`[data-cy="${cy}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

const radio = (host: HTMLElement, value: TimeLimitOption) =>
  host.querySelector(`[data-cy="quiz-time-limit-${value}"]`) as HTMLInputElement;

/** Picks a limit the way a player does — the radio's own change, not a signal write. */
function choose(host: HTMLElement, value: TimeLimitOption): void {
  const input = radio(host, value);
  input.checked = true;
  input.dispatchEvent(new Event('change'));
}

describe('QuizDetailComponent — a quiz ready to start', () => {
  it('reads the quiz its address names', async () => {
    const { load } = await render('/quiz/world-cup-1998');

    expect(load).toHaveBeenCalledWith('world-cup-1998');
  });

  it('shows the title, the description and how many questions it plays', async () => {
    const { host } = await render('/quiz/world-cup-1998');

    expect(text(host, 'quiz-title')).toBe('The 1998 World Cup');
    expect(text(host, 'quiz-description')).toBe(
      'Ten questions, in the order the tournament played them.',
    );
    expect(text(host, 'quiz-question-count')).toBe('3 questions, in the order they were chosen');
    expect(host.querySelector('[data-cy="quiz-unavailable"]')).toBeNull();
    expect(host.querySelector('[data-cy="start-quiz"]')).not.toBeNull();
  });

  it('announces the outcome of the read in its live region', async () => {
    const { host } = await render('/quiz/world-cup-1998');

    expect(text(host, 'quiz-status')).toBe('Quiz ready: 3 questions.');
  });

  // Said before Start, not discovered after it (administrator decision,
  // 8 October 2026): the quiz plays what remains of its list.
  it('says how many of its questions it will leave out', async () => {
    const { host } = await render('/quiz/world-cup-1998', {
      load: () => Promise.resolve(ready({}, 1)),
    });

    expect(text(host, 'quiz-question-count')).toBe('1 question, in the order they were chosen');
    expect(text(host, 'quiz-unavailable')).toBe(
      '2 of its 3 questions cannot be played right now, so it plays the other 1.',
    );
  });

  it('starts the quiz with the questions it read, under the default limit', async () => {
    const { host, startQuiz } = await render('/quiz/world-cup-1998');

    (host.querySelector('[data-cy="start-quiz"]') as HTMLButtonElement).click();

    expect(startQuiz).toHaveBeenCalledWith(
      { id: 'world-cup-1998', title: 'The 1998 World Cup' },
      [question('q-1'), question('q-2'), question('q-3')],
      15,
    );
  });

  it('warns that starting replaces a game in progress', async () => {
    const { host } = await render('/quiz/world-cup-1998', { resumable: true });

    expect(text(host, 'quiz-replaces-game')).toBe(
      'Starting this quiz replaces the game you have in progress.',
    );
  });

  /**
   * Start commits the quiz's own game before the play screen has loaded, so a
   * live read of "is a game in progress" turns true while Start says
   * "Starting…" — and the warning arriving then moved Start down a line under
   * the pointer (`CLAUDE.md` §4.4; measured by `curated-quiz.spec.ts`). The
   * answer is the one from when the quiz was read.
   */
  it('does not warn about the game its own Start has just begun', async () => {
    const { harness, host, hasResumableGame } = await render('/quiz/world-cup-1998');

    hasResumableGame.set(true);
    harness.detectChanges();

    expect(host.querySelector('[data-cy="quiz-replaces-game"]')).toBeNull();
  });

  it('offers Pro instead of Start when the day’s free games are spent', async () => {
    const { host } = await render('/quiz/world-cup-1998', { hasGamesLeft: false });

    expect(host.querySelector('[data-cy="start-quiz"]')).toBeNull();
    expect(host.querySelector('[data-cy="quiz-daily-limit-reached"]')).not.toBeNull();
  });

  /**
   * Start spends the day's last free game before the play screen has loaded,
   * so the allowance reads zero while Start still says "Starting…" — and the
   * offer, a far taller box, replaced the button under the pointer for as long
   * as `/play`'s chunk took (`CLAUDE.md` §4.4; `curated-quiz.spec.ts` measures
   * it). A start the allowance refused still ends on the offer.
   */
  it('keeps Start while its own start spends the last free game, and offers Pro after a refusal', async () => {
    const { harness, host, isLoading, hasGamesLeft, limitReached } =
      await render('/quiz/world-cup-1998');

    isLoading.set(true);
    hasGamesLeft.set(false);
    harness.detectChanges();

    expect(text(host, 'start-quiz')).toBe('Starting…');
    expect(host.querySelector('[data-cy="quiz-daily-limit-reached"]')).toBeNull();

    limitReached.set(true);
    isLoading.set(false);
    harness.detectChanges();

    expect(host.querySelector('[data-cy="start-quiz"]')).toBeNull();
    expect(host.querySelector('[data-cy="quiz-daily-limit-reached"]')).not.toBeNull();
  });

  it('says so, generically, when Start did not start the game', async () => {
    const { harness, host } = await render('/quiz/world-cup-1998', {
      startQuiz: () => Promise.resolve(false),
    });

    (host.querySelector('[data-cy="start-quiz"]') as HTMLButtonElement).click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(text(host, 'quiz-start-error')).toBe('The quiz could not start. Please try again.');
  });
});

/**
 * The WCAG 2.2.1 guard (`FEAT-024` §2). A quiz's `suggestedTimeLimit`
 * pre-selects the picker and **never** locks it: a countdown the player cannot
 * turn off is the failure audit G7 fixed. The override is driven through the
 * real radio, because a test that wrote the signal would pass against a
 * template that had stopped letting anybody change it.
 */
describe('QuizDetailComponent — the time limit is the player’s', () => {
  it('pre-selects the limit the quiz suggests, and says it is a suggestion', async () => {
    const { host } = await render('/quiz/world-cup-1998', {
      load: () => Promise.resolve(ready({ suggestedTimeLimit: 30 })),
    });

    expect(radio(host, 30).checked).toBe(true);
    expect(radio(host, 15).checked).toBe(false);
    expect(text(host, 'quiz-suggested-limit')).toBe('Suggested for this quiz: 30 seconds.');
  });

  it('lets the player override the suggestion to no limit, and starts under it', async () => {
    const { harness, host, startQuiz } = await render('/quiz/world-cup-1998', {
      load: () => Promise.resolve(ready({ suggestedTimeLimit: 15 })),
    });

    choose(host, 'unlimited');
    harness.detectChanges();
    expect(radio(host, 'unlimited').checked).toBe(true);
    expect(radio(host, 'unlimited').disabled).toBe(false);

    (host.querySelector('[data-cy="start-quiz"]') as HTMLButtonElement).click();

    expect(startQuiz).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'unlimited');
  });

  it('offers every limit, none of them disabled, whatever the quiz suggests', async () => {
    const { host } = await render('/quiz/world-cup-1998', {
      load: () => Promise.resolve(ready({ suggestedTimeLimit: 15 })),
    });

    for (const value of [15, 30, 'unlimited'] as const) {
      expect(radio(host, value), String(value)).not.toBeNull();
      expect(radio(host, value).disabled, String(value)).toBe(false);
    }
  });

  it('groups the limits under their caption (G4)', async () => {
    const { host } = await render('/quiz/world-cup-1998');

    const group = host.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute('aria-labelledby')).toBe('quiz-time-limit-label');
    expect(host.querySelector('#quiz-time-limit-label')?.textContent?.trim()).toBe(
      'Time per Question',
    );
  });

  // Every variant is rendered, stacked, so the line keeps the tallest's height
  // (`CLAUDE.md` §4.4) — and only the chosen one is visible.
  it('shows the note for the chosen limit, with the others held invisible', async () => {
    const { harness, host } = await render('/quiz/world-cup-1998');

    choose(host, 'unlimited');
    harness.detectChanges();

    const notes = [...host.querySelectorAll('[data-cy="quiz-time-limit-note"] > p')];
    expect(notes).toHaveLength(3);
    const visible = notes.filter((note) => !note.classList.contains('invisible'));
    expect(visible.map((note) => note.textContent?.trim())).toEqual([
      'No countdown. Quizzes are not ranked, so take all the time you need.',
    ]);
  });
});

describe('QuizDetailComponent — when there is nothing to start', () => {
  it('says the quiz was not found, inside the page, with a way back', async () => {
    const { host } = await render('/quiz/never-written', {
      load: () => Promise.resolve({ kind: 'notFound' }),
    });

    expect(text(host, 'quiz-title')).toBe('Quiz not found');
    expect(host.querySelector('[data-cy="quiz-not-found"]')).not.toBeNull();
    expect(host.querySelector('[data-cy="start-quiz"]')).toBeNull();
    expect(host.querySelector('a[href="/"]')).not.toBeNull();
    expect(text(host, 'quiz-status')).toBe('Quiz not found.');
  });

  it('says a quiz with nothing playable cannot start, rather than starting it', async () => {
    const { host } = await render('/quiz/world-cup-1998', {
      load: () => Promise.resolve({ kind: 'empty', quiz: quiz() }),
    });

    expect(text(host, 'quiz-title')).toBe('The 1998 World Cup');
    expect(host.querySelector('[data-cy="quiz-empty"]')).not.toBeNull();
    expect(host.querySelector('[data-cy="start-quiz"]')).toBeNull();
  });

  // A failed read is not "no such quiz" (`CLAUDE.md` §4.4).
  it('offers a retry when the read fails, and reads again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const { harness, host, load } = await render('/quiz/world-cup-1998', {
      load: () => (calls++ === 0 ? Promise.reject(new Error('timeout')) : Promise.resolve(ready())),
    });

    expect(text(host, 'quiz-title')).toBe('This quiz could not be loaded');
    expect(text(host, 'quiz-load-failed')).toBe(
      'Something went wrong while reading it. Please try again.',
    );

    (host.querySelector('[data-cy="quiz-retry"]') as HTMLButtonElement).click();
    // Focus goes to the heading before the button it was on is hidden.
    expect(document.activeElement).toBe(host.querySelector('[data-cy="quiz-title"]'));
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(load).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-cy="start-quiz"]')).not.toBeNull();
  });

  it('says a quiz needs a connection when the read fails offline', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { host } = await render('/quiz/world-cup-1998', {
      load: () => Promise.reject(new Error('offline')),
      online: false,
    });

    expect(text(host, 'quiz-load-failed')).toBe(
      "You're offline, and a quiz needs a connection to load its questions.",
    );
  });
});

describe('QuizDetailComponent — one component, two addresses', () => {
  it('reads the second quiz when a link to it reuses the screen', async () => {
    const { harness, host, load } = await render('/quiz/world-cup-1998', {
      load: (id) => Promise.resolve(ready({ id, title: id === 'second' ? 'Second' : 'First' })),
    });
    expect(text(host, 'quiz-title')).toBe('First');

    await harness.navigateByUrl('/quiz/second', QuizDetailComponent);
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(load).toHaveBeenLastCalledWith('second');
    expect(text(host, 'quiz-title')).toBe('Second');
  });

  // The slower answer must not overwrite the newer one.
  it('ignores a read that answers after a newer one was started', async () => {
    let releaseFirst: (load: QuizLoad) => void = () => undefined;
    const { harness, host } = await render('/quiz/first', {
      load: (id) =>
        id === 'first'
          ? new Promise<QuizLoad>((resolve) => (releaseFirst = resolve))
          : Promise.resolve(ready({ id, title: 'Second' })),
    });

    await harness.navigateByUrl('/quiz/second', QuizDetailComponent);
    await harness.fixture.whenStable();
    releaseFirst(ready({ id: 'first', title: 'First' }));
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(text(host, 'quiz-title')).toBe('Second');
  });
});
