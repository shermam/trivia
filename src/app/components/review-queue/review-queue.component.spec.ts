import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';
import { CustomQuestionDoc, QuestionReport, QuestionStatus } from '../../models/question.model';
import { FirebaseService } from '../../services/firebase.service';
import { ReportCursor, ReviewerService } from '../../services/reviewer.service';
import { ReportRow, ReviewQueueComponent, ReviewView } from './review-queue.component';

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
    reports?: QuestionReport[];
    /** The cursor the faked page hands back — `null` means "this is the end". */
    reportsNext?: ReportCursor | null;
    questionsById?: Q[];
    loadFails?: boolean;
    reportsFail?: boolean;
    writeFails?: boolean;
    isReviewer?: boolean;
  } = {},
) {
  const {
    byStatus = {},
    reports = [],
    reportsNext = null,
    questionsById = [],
    loadFails = false,
    reportsFail = false,
    writeFails = false,
    isReviewer = true,
  } = options;

  const getQuestionsByStatus = vi.fn((status: QuestionStatus) =>
    loadFails ? throwError(() => new Error('nope')) : of(byStatus[status] ?? []),
  );
  const getQuestionsByIds = vi.fn((ids: string[]) =>
    of(questionsById.filter((question) => ids.includes(question.id))),
  );
  const setQuestionStatus = vi.fn(() =>
    writeFails ? Promise.reject(new Error('refused')) : Promise.resolve(),
  );
  // The cursor is declared even though the fake ignores it: `mock.calls` is
  // typed from the signature, and a zero-argument one makes "asked for the page
  // after this row" unassertable.
  const getQuestionReports = vi.fn((_after?: ReportCursor) =>
    reportsFail
      ? Promise.reject(new Error('permission-denied'))
      : Promise.resolve({ reports, next: reportsNext }),
  );

  TestBed.configureTestingModule({
    providers: [
      {
        provide: FirebaseService,
        useValue: { getQuestionsByStatus, getQuestionsByIds, setQuestionStatus },
      },
      {
        provide: ReviewerService,
        useValue: {
          isReviewer: signal(isReviewer),
          isResolved: signal(true),
          getQuestionReports,
        },
      },
    ],
  });

  const component = TestBed.runInInjectionContext(() => new ReviewQueueComponent());
  return {
    component: component as never as InternalReviewQueue,
    getQuestionsByStatus,
    getQuestionsByIds,
    getQuestionReports,
    setQuestionStatus,
  };
}

/** The template-facing members are `protected`; the spec drives them directly. */
interface InternalReviewQueue {
  ngOnInit(): void;
  load(): Promise<void>;
  select(view: ReviewView): Promise<void>;
  decide(question: Q, status: QuestionStatus): Promise<void>;
  showMoreReports(): Promise<void>;
  activeView(): ReviewView;
  questions(): Q[];
  reports(): ReportRow[];
  reportsView(): 'loading' | 'failed' | 'empty' | 'loaded';
  hasMoreReports(): boolean;
  isLoading(): boolean;
  loadError(): string | null;
  actionError(): string | null;
  actionResult(): string | null;
  isFull(): boolean;
  reasonFor(question: Q): string;
  setReason(questionId: string, value: string): void;
  isReasonTooLong(question: Q): boolean;
}

function report(id: string, overrides: Partial<QuestionReport> = {}): QuestionReport {
  return {
    id,
    questionId: 'p1',
    reason: 'incorrect',
    createdAt: 1_760_000_000_000,
    dayOnly: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('ReviewQueueComponent', () => {
  it('opens on the pending tab and loads it', async () => {
    const { component, getQuestionsByStatus } = setup({ byStatus: { pending: [question('p1')] } });

    await component.load();

    expect(component.activeView()).toBe('pending');
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

    expect(setQuestionStatus).toHaveBeenCalledWith('p1', 'approved', '');
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

    expect(component.activeView()).toBe('rejected');
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

  /**
   * The wiring half of `SourceLinkComponent`'s `showHost` (its own spec owns
   * the rendering). A card that stops passing the flag looks identical to one
   * that never had it, and the failure is silent in the worst place: a title
   * the contributor typed, standing in for a destination nobody is shown, on
   * the screen where a question is approved on evidence.
   */
  it('discloses where a mismatched title actually points', async () => {
    const cards = await render([
      question('p1', {
        sourceUrl: 'https://not-wikipedia.example/page',
        sourceTitle: 'Wikipedia',
      }),
    ]);

    const link = cards[0].querySelector<HTMLAnchorElement>('[data-cy="question-source-link"]');
    expect(link?.textContent).toContain('Wikipedia');
    expect(link?.textContent).toContain('not-wikipedia.example');
  });

  it('renders no source furniture on a card that carries none', async () => {
    const cards = await render([question('p1')]);

    expect(cards[0].querySelector('[data-cy="question-source"]')).toBeNull();
  });

  it("shows the contributor's justification, which is what a tricky question is approved on", async () => {
    const cards = await render([
      question('p1', { explanation: 'Every distractor is a real molecule, which is the trick.' }),
    ]);

    const justification = cards[0].querySelector('[data-cy="question-justification"]');
    expect(justification?.textContent).toContain('Every distractor is a real molecule');
  });

  it('renders no justification block on a card that carries none', async () => {
    const cards = await render([question('p1')]);

    expect(cards[0].querySelector('[data-cy="question-justification"]')).toBeNull();
  });

  /**
   * The card's topics (`FEAT-052`), through the derivation every reader
   * shares: a contribution's own tags, or — for a question written before
   * topics replaced categories, like this file's fixtures — the tag its
   * category derives. The card has no Category row to read it from any more.
   */
  it('shows a question’s topics, deriving one from a category with no tags', async () => {
    const cards = await render([
      question('p1', { tags: ['cold-war', 'treaties'] }),
      question('p2'),
    ]);
    const chips = (card: HTMLElement) =>
      [...card.querySelectorAll('[data-cy="review-question-tags"] li')].map((chip) =>
        chip.textContent?.trim(),
      );

    expect(chips(cards[0])).toEqual(['#cold-war', '#treaties']);
    expect(chips(cards[1])).toEqual(['#science']);
    expect(cards[1].textContent).not.toContain('Category:');
  });
});

/**
 * The reports tab (`FEAT-026`).
 *
 * What these cover that the e2e suite cannot: the two reads being paired
 * correctly when one of them comes back short, a refused read reading as
 * "could not load" rather than as "nobody has complained", and a decision made
 * from a report leaving the report standing.
 */
describe('ReviewQueueComponent reports tab', () => {
  it('pairs each report with the question it names, in two bounded reads', async () => {
    const { component, getQuestionReports, getQuestionsByIds } = setup({
      reports: [report('r1', { questionId: 'p1' }), report('r2', { questionId: 'p2' })],
      questionsById: [question('p1'), question('p2')],
    });

    await component.select('reports');

    expect(getQuestionReports).toHaveBeenCalledTimes(1);
    expect(getQuestionsByIds).toHaveBeenCalledWith(['p1', 'p2']);
    expect(component.reports().map((row) => [row.report.id, row.question?.id])).toEqual([
      ['r1', 'p1'],
      ['r2', 'p2'],
    ]);
  });

  // A report outlives the question it names — `custom_questions` is deletable
  // from the console and nothing cascades — and the row still has to render,
  // because a complaint about a question somebody has already removed is not an
  // error, it is a complaint that has been dealt with.
  it('keeps a report whose question has been deleted', async () => {
    const { component } = setup({
      reports: [report('r1', { questionId: 'gone' })],
      questionsById: [],
    });

    await component.select('reports');

    expect(component.reports()).toEqual([
      { report: report('r1', { questionId: 'gone' }), question: null },
    ]);
  });

  it('shows the empty state only when the read succeeded and found nothing', async () => {
    const { component } = setup({ reports: [] });

    await component.select('reports');

    expect(component.reportsView()).toBe('empty');
  });

  /**
   * The one this tab could most easily get wrong. A refused or timed-out read
   * tells a reviewer nothing about whether anybody has complained, so falling
   * through to "No reports have been filed" would be a claim made on no
   * evidence (`CLAUDE.md` §4.4) — and the consequence is a queue that looks
   * clear while complaints pile up behind a broken read.
   */
  it('does not narrate a refused read as an empty queue', async () => {
    const { component } = setup({ reportsFail: true });

    await component.select('reports');

    expect(component.reportsView()).toBe('failed');
    expect(component.loadError()).toBe('Could not load the reports. Please try again.');
    expect(component.reports()).toEqual([]);
  });

  /**
   * The page after the last row, appended — not a bigger first page. A growing
   * limit re-reads everything already on screen on every click, and Firestore
   * bills per document read; this is the difference between a second click
   * costing 25 reads and costing 50.
   */
  it('asks for the page after the cursor it was handed, and appends it', async () => {
    const cursor: ReportCursor = [1_760_000_000_000, 'r2'];
    const { component, getQuestionReports } = setup({
      reports: [report('r1'), report('r2')],
      reportsNext: cursor,
      questionsById: [question('p1')],
    });
    await component.select('reports');
    expect(getQuestionReports.mock.calls[0][0]).toBeUndefined();
    expect(component.hasMoreReports()).toBe(true);

    getQuestionReports.mockResolvedValueOnce({ reports: [report('r3')], next: null });
    await component.showMoreReports();

    expect(getQuestionReports.mock.calls[1][0]).toBe(cursor);
    expect(component.reports().map((row) => row.report.id)).toEqual(['r1', 'r2', 'r3']);
    // The end of the collection takes the affordance away rather than leaving a
    // button that fetches nothing.
    expect(component.hasMoreReports()).toBe(false);
  });

  it('offers more only while the service says there is a next page', async () => {
    const { component } = setup({
      reports: [report('r1')],
      questionsById: [question('p1')],
    });

    await component.select('reports');

    expect(component.hasMoreReports()).toBe(false);
  });

  /**
   * Rejecting from a report leaves the report standing — there is no "handled"
   * flag, by design — so the row updates in place instead of disappearing. The
   * question's stored status is what the card's buttons are drawn from, so a
   * row that kept the old one would go on offering a decision already made.
   */
  it('updates the question in place rather than dropping the report', async () => {
    const { component, setQuestionStatus } = setup({
      reports: [report('r1', { questionId: 'p1' })],
      questionsById: [question('p1', { status: 'approved' })],
    });
    await component.select('reports');

    await component.decide(question('p1', { status: 'approved' }), 'rejected');

    expect(setQuestionStatus).toHaveBeenCalledWith('p1', 'rejected', '');
    expect(component.reports()).toHaveLength(1);
    expect(component.reports()[0].question?.status).toBe('rejected');
    expect(component.actionResult()).toMatch(/rejected/);
  });

  // Several complaints about one question is the normal case, and one write
  // settles all of them. A row left showing the old status would go on offering
  // a decision that has already been made.
  it('settles every row about the same question with one decision', async () => {
    const { component } = setup({
      reports: [
        report('r1', { questionId: 'p1' }),
        report('r2', { questionId: 'p1' }),
        report('r3', { questionId: 'p2' }),
      ],
      questionsById: [question('p1', { status: 'approved' }), question('p2')],
    });
    await component.select('reports');

    await component.decide(question('p1', { status: 'approved' }), 'rejected');

    expect(component.reports().map((row) => row.question?.status)).toEqual([
      'rejected',
      'rejected',
      'pending',
    ]);
  });

  it('keeps the report row and reports the failure when a decision is refused', async () => {
    const { component } = setup({
      reports: [report('r1', { questionId: 'p1' })],
      questionsById: [question('p1')],
      writeFails: true,
    });
    await component.select('reports');

    await component.decide(question('p1'), 'rejected');

    expect(component.reports()[0].question?.status).toBe('pending');
    expect(component.actionError()).toBeTruthy();
  });

  /**
   * The mirror of the late-answer test above, for the error path — and the
   * sharper of the two, because an error message names a tab. A reports read
   * that fails after the reviewer has moved on would otherwise put "Could not
   * load the reports" over a perfectly good list of pending questions, with a
   * Try again that reloads the tab it is not about.
   */
  it('does not paint a reports failure over the tab the reviewer moved to', async () => {
    let rejectReports!: (error: Error) => void;
    const getQuestionReports = vi.fn(
      () => new Promise<never>((_resolve, reject) => (rejectReports = reject)),
    );

    TestBed.configureTestingModule({
      providers: [
        {
          provide: FirebaseService,
          useValue: {
            getQuestionsByStatus: () => of([question('p1')]),
            getQuestionsByIds: () => of([]),
            setQuestionStatus: vi.fn(),
          },
        },
        {
          provide: ReviewerService,
          useValue: {
            isReviewer: signal(true),
            isResolved: signal(true),
            getQuestionReports,
          },
        },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () => new ReviewQueueComponent(),
    ) as never as InternalReviewQueue;

    const slowReports = component.select('reports');
    await component.select('pending');
    rejectReports(new Error('permission-denied'));
    await slowReports;

    expect(component.activeView()).toBe('pending');
    expect(component.loadError()).toBeNull();
    expect(component.questions().map((q) => q.id)).toEqual(['p1']);
  });
});

/**
 * The reports tab as rendered. Two of these are about what is *not* on screen,
 * which is exactly what a component built directly cannot tell you.
 */
describe('ReviewQueueComponent reports tab, rendered', () => {
  async function renderReports(options: {
    reports: QuestionReport[];
    questionsById?: Q[];
  }): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: FirebaseService,
          useValue: {
            getQuestionsByStatus: () => of([]),
            getQuestionsByIds: (ids: string[]) =>
              of((options.questionsById ?? []).filter((question) => ids.includes(question.id))),
            setQuestionStatus: vi.fn(() => Promise.resolve()),
          },
        },
        {
          provide: ReviewerService,
          useValue: {
            isReviewer: signal(true),
            isResolved: signal(true),
            getQuestionReports: () => Promise.resolve({ reports: options.reports, next: null }),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ReviewQueueComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('[data-cy="review-tab"][data-status="reports"]')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    return host;
  }

  /**
   * The reserved-space contract (`CLAUDE.md` §4.4). jsdom has no layout, so the
   * assertion is the mechanism rather than the pixels: every message is in the
   * DOM, in the same grid cell, switched with `invisible` — which is what makes
   * the block as tall as the tallest of them in a real browser. Were these
   * `@if`-ed the tab would resize the moment the read landed, and neither this
   * suite nor Lighthouse would notice. Pinning the class rather than the
   * geometry is the same trade the account chip's animation spec makes
   * (`app.md` §1.5).
   */
  it('keeps the loading and empty messages in one cell, so the tab cannot resize', async () => {
    const host = await renderReports({ reports: [] });

    const loading = host.querySelector<HTMLElement>('[data-cy="reports-loading"]')!;
    const empty = host.querySelector<HTMLElement>('[data-cy="reports-empty"]')!;
    expect(loading.className).toContain('col-start-1 row-start-1');
    expect(empty.className).toContain('col-start-1 row-start-1');
    // The read has landed, so the empty message is the visible face and the
    // loading one is hidden — still laid out, still holding the height.
    expect(empty.classList.contains('invisible')).toBe(false);
    expect(loading.classList.contains('invisible')).toBe(true);
  });

  /**
   * `reportedBy` never leaves `ReviewerService`, but the report's **document
   * id** ends in the same uid — it is the row's `@for` key, and a key that
   * reached the markup would put the reporter's identity on the reviewer's
   * screen by accident.
   */
  it('shows the complaint without identifying who filed it', async () => {
    const host = await renderReports({
      reports: [
        report('5954006-3-anonuid2b9', {
          questionId: 'p1',
          detail: 'We live on Earth, not Mars.',
        }),
      ],
      questionsById: [question('p1')],
    });

    const row = host.querySelector<HTMLElement>('[data-cy="review-report"]')!;
    expect(row.textContent).toContain('The answer is wrong');
    expect(row.textContent).toContain('We live on Earth, not Mars.');
    expect(row.textContent).toContain('Q p1?');
    expect(row.textContent).not.toContain('anonuid2b9');
  });

  /**
   * An anonymised report keeps the UTC day it was filed, stored as that day's
   * midnight (`FEAT-042`). Rendered with a time, it would claim a moment
   * nobody filed it at — and west of Greenwich, the evening of the day before.
   * A report still inside its thirty days keeps its moment, and shows it.
   *
   * **The spy is what makes this fail where CI runs.** CI runs in UTC, where a
   * formatter that dropped `timeZone: 'UTC'` renders exactly the same text, so
   * the rendered assertions alone pass against that break; they fail only for
   * a reader west of Greenwich. Asserting the option on the call itself fails
   * in every timezone.
   */
  it('shows an anonymised report’s filing day in UTC, with no time of day', async () => {
    const day = Date.UTC(2026, 9, 9);
    const moment = day + 13 * 60 * 60 * 1000;
    const toLocaleDateString = vi.spyOn(Date.prototype, 'toLocaleDateString');
    const host = await renderReports({
      reports: [
        report('Xq3vL9aT2bRk8mNc4PdE', { createdAt: day, dayOnly: true }),
        report('5954006-3-anonuid2b9', { createdAt: moment }),
      ],
      questionsById: [question('p1')],
    });

    // Every time the anonymised report's day is formatted, it is formatted in
    // UTC — and it is formatted at least once.
    const formattedDay = toLocaleDateString.mock.calls
      .map((args, call) => ({
        at: (toLocaleDateString.mock.contexts[call] as Date).getTime(),
        timeZone: args[1]?.timeZone,
      }))
      .filter(({ at }) => at === day);
    expect(formattedDay.length).toBeGreaterThan(0);
    expect(formattedDay.every(({ timeZone }) => timeZone === 'UTC')).toBe(true);

    const [anonymised, attributed] = [
      ...host.querySelectorAll<HTMLElement>('[data-cy="report-filed"]'),
    ].map((line) => line.textContent?.trim());
    expect(anonymised).toBe(
      `Reported ${new Date(day).toLocaleDateString(undefined, { timeZone: 'UTC' })} (UTC)`,
    );
    expect(anonymised).not.toMatch(/\d:\d\d/);
    expect(attributed).toBe(`Reported ${new Date(moment).toLocaleString()}`);
  });

  it('says the question is gone rather than rendering an empty card', async () => {
    const host = await renderReports({
      reports: [report('r1', { questionId: 'deleted-question' })],
      questionsById: [],
    });

    const row = host.querySelector<HTMLElement>('[data-cy="review-report"]')!;
    expect(row.querySelector('[data-cy="reported-question"]')).toBeNull();
    expect(row.querySelector('[data-cy="reported-question-missing"]')?.textContent).toContain(
      'deleted-question',
    );
  });

  /**
   * One unusable `questionId` must not take the page down with it.
   *
   * `question_reports` is writable from the Firebase console, where nothing
   * validates the field, so a stored `42` or a value carrying a `/` can reach
   * the queue — and `ReviewerService` maps a non-string to `''` rather than
   * dropping the complaint. Both are ids a `__name__` filter refuses, so the
   * batched lookup has to leave them out instead of throwing: otherwise every
   * report on the page disappears behind "Could not load the reports", and
   * Try again can never clear it while that one document exists.
   * `firebase.service.spec.ts` covers the dropping; this covers what the
   * reviewer is left looking at.
   */
  it('renders the good reports beside a malformed one rather than failing the page', async () => {
    const host = await renderReports({
      reports: [
        report('r1', { questionId: 'p1' }),
        report('r2', { questionId: '' }),
        report('r3', { questionId: 'custom_questions/p1' }),
      ],
      questionsById: [question('p1')],
    });

    const rows = [...host.querySelectorAll<HTMLElement>('[data-cy="review-report"]')];
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector('[data-cy="reported-question"]')).not.toBeNull();
    expect(rows[1].querySelector('[data-cy="reported-question-missing"]')).not.toBeNull();
    expect(rows[2].querySelector('[data-cy="reported-question-missing"]')).not.toBeNull();
    expect(host.querySelector<HTMLElement>('[data-cy="reports-failed"]')!.className).toContain(
      'invisible',
    );
  });
});

/**
 * The reviewer's rejection note (`FEAT-007`).
 *
 * The interesting half is not that the string reaches the write — it is the
 * three ways it must *not*. A reason typed about one question must not travel
 * with another one's decision (one `ng-template` renders every row, so a single
 * value would); approving must send no reason at all, because
 * `firestore.rules` refuses one on anything but a rejected question and the
 * write would be refused outright; and a note longer than the rules accept has
 * to be named here rather than arriving as a bare `permission-denied`.
 */
describe('ReviewQueueComponent rejection reasons', () => {
  it('sends the reason typed for that row when rejecting', async () => {
    const { component, setQuestionStatus } = setup({
      byStatus: { pending: [question('p1')] },
    });
    await component.load();

    component.setReason('p1', '  The date is wrong.  ');
    await component.decide(question('p1'), 'rejected');

    expect(setQuestionStatus).toHaveBeenCalledWith('p1', 'rejected', 'The date is wrong.');
  });

  // The trap the keyed drafts exist for: the card is one template rendered per
  // row, so a single shared value would put question one's words on question
  // two's rejection.
  it('keeps each draft with the row it was typed on', async () => {
    const { component, setQuestionStatus } = setup({
      byStatus: { pending: [question('p1'), question('p2')] },
    });
    await component.load();

    component.setReason('p1', 'About the first one.');
    await component.decide(question('p2'), 'rejected');

    expect(setQuestionStatus).toHaveBeenCalledWith('p2', 'rejected', '');
  });

  // `firestore.rules` refuses a reason on a question that is not rejected, so
  // an approval carrying one is refused outright rather than merely untidy.
  it('sends no reason when approving, even with words in the box', async () => {
    const { component, setQuestionStatus } = setup({
      byStatus: { pending: [question('p1')] },
    });
    await component.load();

    component.setReason('p1', 'Typed and then thought better of.');
    await component.decide(question('p1'), 'approved');

    expect(setQuestionStatus).toHaveBeenCalledWith('p1', 'approved', '');
  });

  it('refuses a reason longer than the rules accept, and says so', async () => {
    const { component, setQuestionStatus } = setup({
      byStatus: { pending: [question('p1')] },
    });
    await component.load();

    component.setReason('p1', 'x'.repeat(501));
    expect(component.isReasonTooLong(question('p1'))).toBe(true);

    await component.decide(question('p1'), 'rejected');

    expect(setQuestionStatus).not.toHaveBeenCalled();
    expect(component.actionError()).toMatch(/500 characters or fewer/);
  });

  // Rejecting an already-rejected question — to fix a typo in the note, say —
  // must not wipe what the author has already been shown just because the box
  // was never touched.
  it('starts the box from the reason already stored', async () => {
    const { component, setQuestionStatus } = setup({
      byStatus: {
        rejected: [question('p1', { status: 'rejected', rejectionReason: 'Too vague.' })],
      },
    });
    await component.select('rejected');

    expect(component.reasonFor(question('p1', { rejectionReason: 'Too vague.' }))).toBe(
      'Too vague.',
    );

    await component.decide(
      question('p1', { status: 'rejected', rejectionReason: 'Too vague.' }),
      'rejected',
    );

    expect(setQuestionStatus).toHaveBeenCalledWith('p1', 'rejected', 'Too vague.');
  });

  it('lets a reviewer clear a stored reason deliberately', async () => {
    const { component, setQuestionStatus } = setup({
      byStatus: {
        rejected: [question('p1', { status: 'rejected', rejectionReason: 'Too vague.' })],
      },
    });
    await component.select('rejected');

    component.setReason('p1', '');
    await component.decide(
      question('p1', { status: 'rejected', rejectionReason: 'Too vague.' }),
      'rejected',
    );

    expect(setQuestionStatus).toHaveBeenCalledWith('p1', 'rejected', '');
  });
});

/**
 * The Rejected tab, rendered (`FEAT-007`).
 *
 * `firestore.rules` deliberately lets a reviewer attach or change a reason on a
 * question they have **already** rejected. That was unreachable in the first
 * cut: the reason box rendered on every card, so on this tab it pre-filled with
 * the stored note and read as editable, while the button that would have sent
 * it was hidden as a no-op — leaving Approve, which discards what was typed
 * *and* clears the stored reason. A widened rule with no control that reaches
 * it is a rule nobody can use.
 */
describe('ReviewQueueComponent rejected tab, rendered', () => {
  const setQuestionStatus = vi.fn(() => Promise.resolve());

  async function renderRejected(rejected: Q[]) {
    setQuestionStatus.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: FirebaseService,
          useValue: {
            getQuestionsByStatus: (status: QuestionStatus) =>
              of(status === 'rejected' ? rejected : []),
            setQuestionStatus,
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
    host.querySelector<HTMLElement>('[data-cy="review-tab"][data-status="rejected"]')!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    return {
      fixture,
      host,
      settle: async () => {
        await fixture.whenStable();
        fixture.detectChanges();
      },
    };
  }

  const rejectedQuestion = () =>
    question('p1', { status: 'rejected', rejectionReason: 'The date is wrong.' });

  it('offers a control that reaches the write, labelled for what it does there', async () => {
    const { host } = await renderRejected([rejectedQuestion()]);

    const button = host.querySelector<HTMLElement>('[data-cy="reject-question"]');
    expect(button).not.toBeNull();
    expect(button?.textContent?.trim()).toBe('Update reason');
    // Approve stays, because approving a rejected question is still a decision
    // a reviewer makes from here.
    expect(host.querySelector('[data-cy="approve-question"]')).not.toBeNull();
  });

  it('sends the edited reason without moving the question out of the tab', async () => {
    const { host, settle } = await renderRejected([rejectedQuestion()]);

    const box = host.querySelector<HTMLTextAreaElement>('[data-cy="rejection-reason"]')!;
    expect(box.value).toBe('The date is wrong.');
    box.value = 'The date is wrong, and the source says so.';
    box.dispatchEvent(new Event('input'));
    await settle();

    host.querySelector<HTMLElement>('[data-cy="reject-question"]')!.click();
    await settle();

    expect(setQuestionStatus).toHaveBeenCalledWith(
      'p1',
      'rejected',
      'The date is wrong, and the source says so.',
    );
    // The row still belongs to the tab it was decided in — dropping it, which
    // is right for every decision that moves a question, would make it vanish
    // from the list it is still a member of.
    expect(host.querySelectorAll('[data-cy="review-question"]')).toHaveLength(1);
  });

  // "Question marked rejected" about a question that was already rejected
  // narrates something that did not happen (`CLAUDE.md` §4.4).
  it('announces a reason update as an update, not as a decision', async () => {
    const { host, settle } = await renderRejected([rejectedQuestion()]);

    host.querySelector<HTMLElement>('[data-cy="reject-question"]')!.click();
    await settle();

    const status = Array.from(host.querySelectorAll('[role="status"]'))
      .map((node) => node.textContent?.trim())
      .filter(Boolean);
    expect(status).toContain('Reason updated.');
  });

  it('clears the note when the box is emptied deliberately', async () => {
    const { host, settle } = await renderRejected([rejectedQuestion()]);

    const box = host.querySelector<HTMLTextAreaElement>('[data-cy="rejection-reason"]')!;
    box.value = '';
    box.dispatchEvent(new Event('input'));
    await settle();

    host.querySelector<HTMLElement>('[data-cy="reject-question"]')!.click();
    await settle();

    expect(setQuestionStatus).toHaveBeenCalledWith('p1', 'rejected', '');
    // ...and the box stays empty. The draft is deleted once the write lands, so
    // `reasonFor()` falls back to the row's own value and the `[value]` binding
    // rewrites the textarea from it — which put the old note back on screen
    // under an announcement saying it had been cleared. The write was right and
    // the screen was wrong, which is the worst version of this to debug.
    expect(host.querySelector<HTMLTextAreaElement>('[data-cy="rejection-reason"]')!.value).toBe('');
  });
});

/**
 * `FEAT-006`: the way into everything one account contributed, and back.
 *
 * The view itself is `author-contributions.component.spec.ts`'s. What is
 * pinned here is the queue's half: which cards offer the way in (an account
 * has to be there to look up), that a non-reviewer is offered nothing, that
 * the queue is hidden rather than destroyed while the view is open, that a
 * bulk action brings the queue's own copies up to date without a second read,
 * and where focus goes on the way back.
 */
describe('ReviewQueueComponent: everything one account contributed (FEAT-006)', () => {
  const AUTHOR = 'author-uid-x91';

  async function renderQueue(
    options: {
      pending?: Q[];
      reports?: QuestionReport[];
      questionsById?: Q[];
      isReviewer?: boolean;
      byAuthor?: Q[];
    } = {},
  ) {
    const getQuestionsByAuthor = vi.fn((_uid: string) =>
      Promise.resolve({ questions: options.byAuthor ?? [], next: null }),
    );
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: FirebaseService,
          useValue: {
            getQuestionsByStatus: (status: QuestionStatus) =>
              of(status === 'pending' ? (options.pending ?? []) : []),
            getQuestionsByIds: (ids: string[]) =>
              of((options.questionsById ?? []).filter((q) => ids.includes(q.id))),
            setQuestionStatus: vi.fn(() => Promise.resolve()),
            getQuestionsByAuthor,
            rejectQuestions: vi.fn(),
          },
        },
        {
          provide: ReviewerService,
          useValue: {
            isReviewer: signal(options.isReviewer ?? true),
            isResolved: signal(true),
            getQuestionReports: () =>
              Promise.resolve({ reports: options.reports ?? [], next: null }),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ReviewQueueComponent);
    // A few passes, each ending on a macrotask: the reports tab reads twice in
    // sequence (the page, then its questions), and `whenStable` does not wait
    // on a promise chain nothing registered as pending work.
    const settle = async () => {
      for (let pass = 0; pass < 3; pass++) {
        fixture.detectChanges();
        await fixture.whenStable();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      fixture.detectChanges();
    };
    await settle();
    return {
      fixture,
      host: fixture.nativeElement as HTMLElement,
      component: fixture.componentInstance as never as InternalReviewQueue & {
        applyBulkRejection(event: { ids: readonly string[]; reason: string }): void;
      },
      getQuestionsByAuthor,
      settle,
    };
  }

  function openers(host: HTMLElement): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>('[data-cy="open-author-view"]')];
  }

  it('offers the way in on a card with an account behind it, and on no other', async () => {
    const { host } = await renderQueue({
      pending: [
        question('attributed', { createdBy: AUTHOR, createdAt: 3 }),
        question('unattributed', { createdAt: 2 }),
        question('erased', { createdBy: '[deleted-user]', createdAt: 1 }),
      ],
    });

    const cards = [...host.querySelectorAll<HTMLElement>('[data-cy="review-question"]')];
    expect(cards).toHaveLength(3);
    const offering = cards.filter((card) => card.querySelector('[data-cy="open-author-view"]'));
    expect(offering.map((card) => card.textContent)).toEqual([
      expect.stringContaining('Q attributed?'),
    ]);
  });

  /**
   * The UI half of the gate, which is the reviewer branch the whole page is
   * already behind — the same `user_roles` document the rules read. A
   * non-reviewer is shown no card, so no way in, and the rules refuse the read
   * regardless (`firestore-tests`).
   */
  it('offers a non-reviewer nothing at all', async () => {
    const { host } = await renderQueue({
      isReviewer: false,
      pending: [question('attributed', { createdBy: AUTHOR })],
    });

    expect(openers(host)).toHaveLength(0);
    expect(host.querySelector('app-author-contributions')).toBeNull();
  });

  it('opens the account from a card, hiding the queue rather than destroying it', async () => {
    const { host, getQuestionsByAuthor, settle } = await renderQueue({
      pending: [question('p1', { createdBy: AUTHOR })],
      byAuthor: [question('p1', { createdBy: AUTHOR })],
    });

    openers(host)[0].click();
    await settle();

    expect(getQuestionsByAuthor).toHaveBeenCalledWith(AUTHOR, undefined);
    expect(host.querySelector('[data-cy="author-view"]')).not.toBeNull();
    const queue = host.querySelector<HTMLElement>('[data-cy="review-queue-body"]')!;
    expect(queue.hidden).toBe(true);
    // Still there: the card, its drafts and the button that opened the view.
    expect(queue.querySelector('[data-cy="review-question"]')).not.toBeNull();
    expect(host.querySelector('[data-cy="close-author-view"]')?.textContent).toContain(
      'Back to Pending',
    );
  });

  it('opens the account from a report, too', async () => {
    const { host, getQuestionsByAuthor, settle } = await renderQueue({
      reports: [report('r1', { questionId: 'p1' })],
      questionsById: [question('p1', { createdBy: AUTHOR })],
    });
    host.querySelector<HTMLElement>('[data-cy="review-tab"][data-status="reports"]')!.click();
    await settle();

    openers(host)[0].click();
    await settle();

    expect(getQuestionsByAuthor).toHaveBeenCalledWith(AUTHOR, undefined);
    expect(host.querySelector('[data-cy="close-author-view"]')?.textContent).toContain(
      'Back to Reports',
    );
  });

  it('takes a bulk-rejected question out of Pending without reading the tab again', async () => {
    const { component, host, settle } = await renderQueue({
      pending: [question('p1', { createdBy: AUTHOR }), question('p2', { createdBy: 'other' })],
    });
    openers(host)[0].click();
    await settle();

    component.applyBulkRejection({ ids: ['p1'], reason: 'Spam account.' });

    expect(component.questions().map((q) => q.id)).toEqual(['p2']);
  });

  it('updates a report row’s question in place rather than dropping the report', async () => {
    const { component, host, settle } = await renderQueue({
      reports: [report('r1', { questionId: 'p1' }), report('r2', { questionId: 'p1' })],
      questionsById: [question('p1', { createdBy: AUTHOR })],
    });
    host.querySelector<HTMLElement>('[data-cy="review-tab"][data-status="reports"]')!.click();
    await settle();
    openers(host)[0].click();
    await settle();

    component.applyBulkRejection({ ids: ['p1'], reason: 'Spam account.' });

    expect(
      component
        .reports()
        .map((row) => [row.report.id, row.question?.status, row.question?.rejectionReason]),
    ).toEqual([
      ['r1', 'rejected', 'Spam account.'],
      ['r2', 'rejected', 'Spam account.'],
    ]);
  });

  /**
   * Focus goes back to the button that was pressed — after the render, since
   * until then the queue is still hidden — and to the tab when that button has
   * gone with its row. jsdom enforces neither `hidden` nor detachment in
   * `focus()`, so this pins the choice of target; `review-author-view.spec.ts`
   * proves the browser honours it.
   */
  it('returns focus to the button that opened the view', async () => {
    const { host, settle } = await renderQueue({
      pending: [question('p1', { createdBy: AUTHOR })],
    });
    const opener = openers(host)[0];
    opener.click();
    await settle();

    host.querySelector<HTMLElement>('[data-cy="close-author-view"]')!.click();
    await settle();

    expect(host.querySelector('[data-cy="author-view"]')).toBeNull();
    expect(host.querySelector<HTMLElement>('[data-cy="review-queue-body"]')!.hidden).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('returns focus to the tab when the opener left with its row', async () => {
    const { component, host, settle } = await renderQueue({
      pending: [question('p1', { createdBy: AUTHOR })],
    });
    openers(host)[0].click();
    await settle();
    component.applyBulkRejection({ ids: ['p1'], reason: 'Spam account.' });
    await settle();

    host.querySelector<HTMLElement>('[data-cy="close-author-view"]')!.click();
    await settle();

    expect(document.activeElement).toBe(
      host.querySelector('[data-cy="review-tab"][data-status="pending"]'),
    );
  });
});
