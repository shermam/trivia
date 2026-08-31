import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';
import { CustomQuestionDoc, QuestionStatus } from '../../models/question.model';
import { FirebaseService } from '../../services/firebase.service';
import { ReviewerService } from '../../services/reviewer.service';
import { ReviewQueueComponent } from './review-queue.component';

/**
 * The queue's own logic, separate from the rules that authorise it.
 *
 * Three of these cover behaviour nothing else can see: that a late answer for
 * a tab the reviewer has already left cannot overwrite the tab they are on,
 * that a decision removes its row without a refetch, and that a refused
 * decision does not silently look like success. All three are the kind of
 * thing an e2e run passes straight over because it never races them.
 */

type Q = CustomQuestionDoc & { id: string };

function question(id: string, overrides: Partial<Q> = {}): Q {
  return {
    id,
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question: `Q ${id}?`,
    correct_answer: 'A',
    incorrect_answers: ['B'],
    status: 'pending',
    ...overrides,
  };
}

function setup(
  options: {
    byStatus?: Partial<Record<QuestionStatus, Q[]>>;
    loadFails?: boolean;
    writeFails?: boolean;
    isReviewer?: boolean;
  } = {},
) {
  const { byStatus = {}, loadFails = false, writeFails = false, isReviewer = true } = options;

  const getQuestionsByStatus = vi.fn((status: QuestionStatus) =>
    loadFails ? throwError(() => new Error('nope')) : of(byStatus[status] ?? []),
  );
  const setQuestionStatus = vi.fn(() =>
    writeFails ? Promise.reject(new Error('refused')) : Promise.resolve(),
  );

  TestBed.configureTestingModule({
    providers: [
      { provide: FirebaseService, useValue: { getQuestionsByStatus, setQuestionStatus } },
      {
        provide: ReviewerService,
        useValue: { isReviewer: signal(isReviewer), isResolved: signal(true) },
      },
    ],
  });

  const component = TestBed.runInInjectionContext(() => new ReviewQueueComponent());
  return {
    component: component as never as InternalReviewQueue,
    getQuestionsByStatus,
    setQuestionStatus,
  };
}

/** The template-facing members are `protected`; the spec drives them directly. */
interface InternalReviewQueue {
  ngOnInit(): void;
  load(): Promise<void>;
  select(status: QuestionStatus): Promise<void>;
  decide(question: Q, status: QuestionStatus): Promise<void>;
  activeStatus(): QuestionStatus;
  questions(): Q[];
  isLoading(): boolean;
  loadError(): string | null;
  actionError(): string | null;
  actionResult(): string | null;
  isFull(): boolean;
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('ReviewQueueComponent', () => {
  it('opens on the pending tab and loads it', async () => {
    const { component, getQuestionsByStatus } = setup({ byStatus: { pending: [question('p1')] } });

    await component.load();

    expect(component.activeStatus()).toBe('pending');
    expect(getQuestionsByStatus).toHaveBeenCalledWith('pending');
    expect(component.questions().map((q) => q.id)).toEqual(['p1']);
  });

  it('loads the chosen tab when it changes', async () => {
    const { component, getQuestionsByStatus } = setup({
      byStatus: { pending: [question('p1')], rejected: [question('r1', { status: 'rejected' })] },
    });
    await component.load();

    await component.select('rejected');

    expect(getQuestionsByStatus).toHaveBeenLastCalledWith('rejected');
    expect(component.questions().map((q) => q.id)).toEqual(['r1']);
  });

  it('does not refetch the tab already selected', async () => {
    const { component, getQuestionsByStatus } = setup({ byStatus: { pending: [question('p1')] } });
    await component.load();

    await component.select('pending');

    expect(getQuestionsByStatus).toHaveBeenCalledTimes(1);
  });

  it('removes a decided question from the list without refetching', async () => {
    const { component, getQuestionsByStatus, setQuestionStatus } = setup({
      byStatus: { pending: [question('p1'), question('p2')] },
    });
    await component.load();

    await component.decide(question('p1'), 'approved');

    expect(setQuestionStatus).toHaveBeenCalledWith('p1', 'approved');
    expect(component.questions().map((q) => q.id)).toEqual(['p2']);
    expect(getQuestionsByStatus).toHaveBeenCalledTimes(1);
  });

  it('announces the decision it made', async () => {
    // Rendered into a role="status" region. Without it the list silently loses
    // a row and a screen reader user is told nothing (`CLAUDE.md` §4.5).
    const { component } = setup({ byStatus: { pending: [question('p1')] } });
    await component.load();

    await component.decide(question('p1'), 'rejected');

    expect(component.actionResult()).toMatch(/rejected/);
  });

  it('keeps the row and reports the failure when a decision is refused', async () => {
    const { component } = setup({ byStatus: { pending: [question('p1')] }, writeFails: true });
    await component.load();

    await component.decide(question('p1'), 'approved');

    expect(component.questions().map((q) => q.id)).toEqual(['p1']);
    expect(component.actionError()).toBeTruthy();
    expect(component.actionResult()).toBeNull();
  });

  it('reports a failed load without narrating a cause it did not verify', async () => {
    const { component } = setup({ loadFails: true });

    await component.load();

    // A refusal, a timeout and a network fault are indistinguishable from here
    // — `CLAUDE.md` §4.4 forbids picking one and telling the user it happened.
    expect(component.loadError()).toBe('Could not load the queue. Please try again.');
    expect(component.isLoading()).toBe(false);
  });

  it('does not let a late answer overwrite the tab the reviewer moved to', async () => {
    // The race this exists for: switching tabs quickly means two reads in
    // flight, and the slower one must not repaint the list.
    const pending = new Subject<Q[]>();
    const getQuestionsByStatus = vi.fn((status: QuestionStatus) =>
      status === 'pending' ? pending.asObservable() : of([question('r1', { status: 'rejected' })]),
    );

    TestBed.configureTestingModule({
      providers: [
        {
          provide: FirebaseService,
          useValue: { getQuestionsByStatus, setQuestionStatus: vi.fn() },
        },
        {
          provide: ReviewerService,
          useValue: { isReviewer: signal(true), isResolved: signal(true) },
        },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () => new ReviewQueueComponent(),
    ) as never as InternalReviewQueue;

    const slow = component.load();
    await component.select('rejected');
    expect(component.questions().map((q) => q.id)).toEqual(['r1']);

    pending.next([question('p1')]);
    pending.complete();
    await slow;

    expect(component.activeStatus()).toBe('rejected');
    expect(component.questions().map((q) => q.id)).toEqual(['r1']);
  });

  it('says so when the page is full, rather than implying it is the whole queue', async () => {
    const { component } = setup({
      byStatus: { pending: Array.from({ length: 50 }, (_, i) => question(`p${i}`)) },
    });

    await component.load();

    expect(component.isFull()).toBe(true);
  });
});

/**
 * `FEAT-022`. Rendered, because the value of this feature to a reviewer is
 * entirely in the link being *there* — a card that silently stops passing the
 * fields through looks identical to a question that never carried a source,
 * and the tests above build the component directly and would never see it.
 */
describe('ReviewQueueComponent source attribution', () => {
  async function render(questions: Q[]) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: FirebaseService,
          useValue: {
            getQuestionsByStatus: () => of(questions),
            setQuestionStatus: vi.fn(() => Promise.resolve()),
          },
        },
        {
          provide: ReviewerService,
          useValue: { isReviewer: signal(true), isResolved: signal(true) },
        },
      ],
    });
    const fixture = TestBed.createComponent(ReviewQueueComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    return Array.from(host.querySelectorAll<HTMLElement>('[data-cy="review-question"]'));
  }

  it('shows the source as a link the reviewer can open to check the answer', async () => {
    const cards = await render([
      question('p1', {
        sourceUrl: 'https://example.org/h2o',
        sourceTitle: 'Example Journal',
      }),
    ]);

    const link = cards[0].querySelector<HTMLAnchorElement>('[data-cy="question-source-link"]');
    expect(link?.getAttribute('href')).toBe('https://example.org/h2o');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.textContent).toContain('Example Journal');
  });

  it('renders no source furniture on a card that carries none', async () => {
    const cards = await render([question('p1')]);

    expect(cards[0].querySelector('[data-cy="question-source"]')).toBeNull();
  });
});
