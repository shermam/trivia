import { TestBed } from '@angular/core/testing';
import { CustomQuestionDoc } from '../../models/question.model';
import {
  AUTHOR_PAGE_SIZE,
  BulkDecisionOutcome,
  FirebaseService,
  UserQuestionCursor,
  UserQuestionsPage,
} from '../../services/firebase.service';
import {
  AuthorContributionsComponent,
  AuthorStatusView,
  BulkRejection,
  SelectionLineView,
  describeOutcome,
} from './author-contributions.component';
import { verbatim, type Message } from '../../i18n/message';
import { english } from '../../i18n/testing';

/**
 * Everything one account contributed, for a reviewer (`FEAT-006`).
 *
 * What these pin is the part an end-to-end run passes straight over: that a
 * selection can only ever be one page, that a partial failure is reported as
 * one rather than as the whole set failing or succeeding, that nothing is sent
 * without a selection and a reason, and that the uid the view queries by never
 * reaches the screen. The read and the writes themselves are
 * `firebase.service.spec.ts`'s, and whether the rules allow them is the rules
 * suite's.
 */

type Q = CustomQuestionDoc & { id: string };

const AUTHOR = 'author-uid-8f3k2';

function question(id: string, overrides: Partial<Q> = {}): Q {
  return {
    id,
    type: 'multiple',
    difficulty: 'easy',
    question: `Question ${id}?`,
    correct_answer: 'A',
    incorrect_answers: ['B'],
    tags: ['chemistry'],
    createdBy: AUTHOR,
    createdAt: 1_760_000_000_000,
    status: 'pending',
    ...overrides,
  };
}

/** A promise the test settles, for holding a read or a write open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The template-facing members are `protected`; the spec drives them directly. */
interface InternalView {
  rows(): Q[];
  pageIndex(): number;
  statusView(): AuthorStatusView;
  selectionLine(): SelectionLineView;
  selected(): ReadonlySet<string>;
  allSelected(): boolean;
  someSelected(): boolean;
  reasonError(): Message | null;
  selectionError(): Message | null;
  outcome(): Message | null;
  announcement(): Message | null;
  inFlight(): boolean;
  toggle(question: Q, checked: boolean): void;
  toggleAll(): void;
  setReason(value: string): void;
  rejectSelected(): Promise<void>;
  older(): void;
  newer(): void;
  retry(): void;
  back(): void;
}

function setup(
  options: {
    pages?: UserQuestionsPage[] | (() => Promise<UserQuestionsPage>);
    reject?: (ids: readonly string[]) => Promise<BulkDecisionOutcome>;
  } = {},
) {
  const pages = options.pages ?? [{ questions: [], next: null }];
  let call = 0;
  const getQuestionsByAuthor = vi.fn(
    (_uid: string, _after?: UserQuestionCursor): Promise<UserQuestionsPage> =>
      typeof pages === 'function'
        ? pages()
        : Promise.resolve(pages[Math.min(call++, pages.length - 1)]),
  );
  const rejectQuestions = vi.fn(
    (
      ids: readonly string[],
      _reason: string,
      onProgress?: (done: number, total: number) => void,
    ): Promise<BulkDecisionOutcome> => {
      onProgress?.(ids.length, ids.length);
      return options.reject
        ? options.reject(ids)
        : Promise.resolve({ succeeded: [...ids], failed: [] });
    },
  );

  TestBed.configureTestingModule({
    providers: [{ provide: FirebaseService, useValue: { getQuestionsByAuthor, rejectQuestions } }],
  });
  const fixture = TestBed.createComponent(AuthorContributionsComponent);
  fixture.componentRef.setInput('authorUid', AUTHOR);
  fixture.componentRef.setInput(
    'anchor',
    question('anchor', { question: 'The one it came from?' }),
  );
  fixture.componentRef.setInput('returnLabel', verbatim('Pending'));

  const emitted: BulkRejection[] = [];
  fixture.componentInstance.rejected.subscribe((event) => emitted.push(event));
  let closed = 0;
  fixture.componentInstance.closed.subscribe(() => closed++);

  return {
    fixture,
    view: fixture.componentInstance as never as InternalView,
    host: fixture.nativeElement as HTMLElement,
    getQuestionsByAuthor,
    rejectQuestions,
    emitted,
    closedCount: () => closed,
    settle: async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    },
  };
}

async function rendered(options: Parameters<typeof setup>[0]) {
  const harness = setup(options);
  await harness.settle();
  return harness;
}

function face(host: HTMLElement, cy: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[data-cy="${cy}"]`);
  expect(element, cy).not.toBeNull();
  return element!;
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('AuthorContributionsComponent: the read', () => {
  it('asks for this account, from the newest page, on arrival', async () => {
    const { getQuestionsByAuthor, view } = await rendered({
      pages: [{ questions: [question('p1'), question('a1', { status: 'approved' })], next: null }],
    });

    expect(getQuestionsByAuthor).toHaveBeenCalledTimes(1);
    expect(getQuestionsByAuthor).toHaveBeenCalledWith(AUTHOR, undefined);
    expect(view.rows().map((row) => row.id)).toEqual(['p1', 'a1']);
    expect(view.statusView()).toBe('loaded');
  });

  /**
   * `FEAT-006` §0: the reviewer reaches an author through a question, and the
   * uid the read is filtered on is not something this screen shows. Every row
   * carries it as `createdBy`, so a template that rendered a row's author
   * would put it on screen fifty times.
   */
  it('never renders the uid it queries by', async () => {
    const { host } = await rendered({
      pages: [{ questions: [question('p1'), question('r1', { status: 'rejected' })], next: null }],
    });

    expect(host.textContent).toContain('Question p1?');
    expect(host.textContent).toContain('The one it came from?');
    expect(host.textContent).not.toContain(AUTHOR);
  });

  /**
   * The reserved-space contract (`CLAUDE.md` §4.4). jsdom has no layout, so
   * the assertion is the mechanism: every message is in the DOM from the first
   * frame, in one grid cell, switched with `invisible` — which is what makes
   * the block as tall as the tallest of them in a browser.
   * `review-author-view.spec.ts` measures the box itself.
   */
  it('keeps the loading, empty, failed and loaded messages in one cell', async () => {
    const read = deferred<UserQuestionsPage>();
    const { host, settle } = setup({ pages: () => read.promise });
    await settle();

    const faces = ['author-loading', 'author-empty', 'author-failed', 'author-summary'].map((cy) =>
      face(host, cy),
    );
    for (const element of faces) {
      expect(element.className).toContain('col-start-1 row-start-1');
    }
    expect(face(host, 'author-loading').classList.contains('invisible')).toBe(false);
    expect(face(host, 'author-empty').classList.contains('invisible')).toBe(true);

    read.resolve({ questions: [], next: null });
    await settle();

    expect(face(host, 'author-loading').classList.contains('invisible')).toBe(true);
    expect(face(host, 'author-empty').classList.contains('invisible')).toBe(false);
  });

  /**
   * The view replaces the queue under the reviewer, so it takes focus and is
   * announced by name — after the render, since the heading does not exist
   * until the template has run (`CLAUDE.md` §4.4).
   */
  it('moves focus to its heading when it opens', async () => {
    const { host } = await rendered({ pages: [{ questions: [question('p1')], next: null }] });

    expect(document.activeElement).toBe(face(host, 'author-view-heading'));
  });

  it('says a failed read failed, rather than that the account has nothing', async () => {
    const { view, host } = await rendered({ pages: () => Promise.reject(new Error('refused')) });

    expect(view.statusView()).toBe('failed');
    expect(face(host, 'author-failed').classList.contains('invisible')).toBe(false);
    expect(face(host, 'author-empty').classList.contains('invisible')).toBe(true);
  });

  /**
   * The failed face holds its height from the first frame only if its words
   * are there from the first frame: a message filled in from a signal is an
   * empty paragraph until the read fails, and the block would grow the moment
   * it did.
   */
  it('carries the failed message from first paint, not from the failure', async () => {
    const read = deferred<UserQuestionsPage>();
    const { host, settle } = setup({ pages: () => read.promise });
    await settle();

    expect(face(host, 'author-failed').textContent).toContain(
      'Could not load this account’s contributions.',
    );
  });
});

describe('AuthorContributionsComponent: the selection', () => {
  const mixed = (): UserQuestionsPage => ({
    questions: [
      question('p1'),
      question('a1', { status: 'approved' }),
      question('r1', { status: 'rejected', rejectionReason: 'Already spam.' }),
    ],
    next: null,
  });

  it('selects every question on the page that can be rejected — and not one already rejected', async () => {
    const { view, host } = await rendered({ pages: [mixed()] });

    view.toggleAll();

    expect([...view.selected()].sort()).toEqual(['a1', 'p1']);
    expect(view.allSelected()).toBe(true);
    const boxes = [...host.querySelectorAll<HTMLInputElement>('[data-cy="author-select"]')];
    expect(boxes.map((box) => box.disabled)).toEqual([false, false, true]);
  });

  it('clears the selection when everything selectable is already selected', async () => {
    const { view } = await rendered({ pages: [mixed()] });
    view.toggleAll();

    view.toggleAll();

    expect(view.selected().size).toBe(0);
  });

  it('marks select-all mixed while only some are selected', async () => {
    const { view, host, settle } = await rendered({ pages: [mixed()] });

    view.toggle(question('p1'), true);
    await settle();

    expect(view.someSelected()).toBe(true);
    expect(face(host, 'select-all') as HTMLInputElement).toHaveProperty('indeterminate', true);
    expect(face(host, 'selection-count').textContent?.trim()).toBe('1 of 2 selected');
  });

  it('will not select a question that is already rejected', async () => {
    const { view } = await rendered({ pages: [mixed()] });

    view.toggle(question('r1', { status: 'rejected' }), true);

    expect(view.selected().size).toBe(0);
  });

  it('says so when nothing on the page can be rejected, rather than offering a count of none', async () => {
    const { view } = await rendered({
      pages: [{ questions: [question('r1', { status: 'rejected' })], next: null }],
    });

    expect(view.selectionLine()).toBe('nothing-to-reject');
  });
});

describe('AuthorContributionsComponent: rejecting the selection', () => {
  const page = (): UserQuestionsPage => ({
    questions: [question('p1'), question('a1', { status: 'approved' })],
    next: null,
  });

  it('sends nothing without a selection, and says so where the selection is made', async () => {
    const { view, host, rejectQuestions } = await rendered({ pages: [page()] });
    view.setReason('Spam account.');

    await view.rejectSelected();

    expect(rejectQuestions).not.toHaveBeenCalled();
    expect(english(view.selectionError())).toBe('Select at least one question to reject.');
    expect(view.selectionLine()).toBe('error');
    expect(document.activeElement).toBe(face(host, 'select-all'));
  });

  it('sends nothing without a reason, and names the field', async () => {
    const { view, host, rejectQuestions, settle } = await rendered({ pages: [page()] });
    view.toggleAll();
    view.setReason('   ');

    await view.rejectSelected();
    await settle();

    expect(rejectQuestions).not.toHaveBeenCalled();
    expect(english(view.reasonError())).toMatch(/Give a reason/);
    const box = face(host, 'bulk-reason');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.getAttribute('aria-describedby')).toContain('author-bulk-reason-error');
    expect(document.activeElement).toBe(box);
  });

  it('refuses a reason longer than the rules accept, before sending anything', async () => {
    const { view, rejectQuestions } = await rendered({ pages: [page()] });
    view.toggleAll();
    view.setReason('x'.repeat(501));

    await view.rejectSelected();

    expect(rejectQuestions).not.toHaveBeenCalled();
    expect(english(view.reasonError())).toBe('A reason must be 500 characters or fewer.');
  });

  /**
   * The reason box's error lands in a line held from the first frame, the
   * selection line's technique one control down: invisible copies of both
   * messages share the cell the showing one lands in, so the line is as tall
   * as the longer of them before either is said, and the Reject button under
   * it — the control just pressed — does not move when one appears or clears
   * (`CLAUDE.md` §4.4). `review-author-view.spec.ts` measures the button.
   */
  it('holds the reason error’s line from the first frame, at the longer message', async () => {
    const { view, host, settle } = await rendered({ pages: [page()] });

    const line = face(host, 'bulk-reason-error-line');
    const sizers = [...line.children].filter((cell) => cell.getAttribute('aria-hidden') === 'true');
    expect(sizers.map((cell) => cell.textContent?.trim())).toEqual([
      'Give a reason — it is shown to the author on every question this rejects.',
      'A reason must be 500 characters or fewer.',
    ]);
    for (const cell of sizers) {
      expect(cell.className).toContain('col-start-1 row-start-1');
      expect(cell.classList.contains('invisible')).toBe(true);
    }
    expect(host.querySelector('[data-cy="bulk-reason-error"]')).toBeNull();

    view.toggleAll();
    await view.rejectSelected();
    await settle();

    const error = face(host, 'bulk-reason-error');
    expect(error.parentElement).toBe(line);
    expect(error.className).toContain('col-start-1 row-start-1');
    expect(error.textContent?.trim()).toBe(english(view.reasonError()));
  });

  it('sends the selection with the one trimmed reason', async () => {
    const { view, rejectQuestions } = await rendered({ pages: [page()] });
    view.toggleAll();
    view.setReason('  Spam account.  ');

    await view.rejectSelected();

    expect(rejectQuestions).toHaveBeenCalledTimes(1);
    const [ids, reason] = rejectQuestions.mock.calls[0];
    expect([...ids].sort()).toEqual(['a1', 'p1']);
    expect(reason).toBe('Spam account.');
  });

  it('marks what was rejected where it stands, tells the queue, and announces it', async () => {
    const { view, emitted } = await rendered({ pages: [page()] });
    view.toggleAll();
    view.setReason('Spam account.');

    await view.rejectSelected();

    expect(view.rows().map((row) => [row.id, row.status, row.rejectionReason])).toEqual([
      ['p1', 'rejected', 'Spam account.'],
      ['a1', 'rejected', 'Spam account.'],
    ]);
    expect(emitted).toHaveLength(1);
    expect([...emitted[0].ids].sort()).toEqual(['a1', 'p1']);
    expect(emitted[0].reason).toBe('Spam account.');
    expect(view.selected().size).toBe(0);
    expect(english(view.announcement())).toBe('Rejected 2 questions.');
    expect(view.selectionLine()).toBe('outcome');
  });

  /**
   * The spec's acceptance row: a bulk action reports a partial failure
   * honestly rather than as a whole-set failure. The rows that landed change
   * status, the one that did not keeps its old status and **stays selected**,
   * so pressing Reject again is the retry — and only what landed is reported
   * to the queue.
   */
  it('reports a partial failure as one, and keeps what was not confirmed selected', async () => {
    const { view, emitted } = await rendered({
      pages: [page()],
      reject: () => Promise.resolve({ succeeded: ['p1'], failed: ['a1'] }),
    });
    view.toggleAll();
    view.setReason('Spam account.');

    await view.rejectSelected();

    expect(view.rows().map((row) => [row.id, row.status])).toEqual([
      ['p1', 'rejected'],
      ['a1', 'approved'],
    ]);
    expect([...view.selected()]).toEqual(['a1']);
    expect(emitted.map((event) => [...event.ids])).toEqual([['p1']]);
    expect(english(view.outcome())).toBe(
      'Rejected 1 of 2. 1 could not be confirmed and is still selected — try again.',
    );
  });

  it('reports none landing without telling the queue anything changed', async () => {
    const { view, emitted } = await rendered({
      pages: [page()],
      reject: (ids) => Promise.resolve({ succeeded: [], failed: [...ids] }),
    });
    view.toggleAll();
    view.setReason('Spam account.');

    await view.rejectSelected();

    expect(emitted).toHaveLength(0);
    expect(view.rows().map((row) => row.status)).toEqual(['pending', 'approved']);
    expect(english(view.outcome())).toBe(
      'None of the 2 could be confirmed. They are still selected — try again.',
    );
  });

  /**
   * The focused control must stay focusable while the writes are out: a
   * `disabled` button under the reviewer's focus would drop it to `<body>`
   * (`CLAUDE.md` §4.4). `aria-disabled` says it is busy without doing that.
   */
  it('keeps the button focusable while the writes are out, and refuses a second press', async () => {
    const write = deferred<BulkDecisionOutcome>();
    const { view, host, rejectQuestions, settle } = await rendered({
      pages: [page()],
      reject: () => write.promise,
    });
    view.toggleAll();
    view.setReason('Spam account.');

    const pending = view.rejectSelected();
    await settle();

    const button = face(host, 'bulk-reject') as HTMLButtonElement;
    expect(view.inFlight()).toBe(true);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await view.rejectSelected();
    expect(rejectQuestions).toHaveBeenCalledTimes(1);

    write.resolve({ succeeded: ['p1', 'a1'], failed: [] });
    await pending;
  });

  it('will not go back while the writes are out', async () => {
    const write = deferred<BulkDecisionOutcome>();
    const { view, closedCount } = await rendered({
      pages: [page()],
      reject: () => write.promise,
    });
    view.toggleAll();
    view.setReason('Spam account.');
    const pending = view.rejectSelected();

    view.back();
    expect(closedCount()).toBe(0);

    write.resolve({ succeeded: ['p1', 'a1'], failed: [] });
    await pending;
    view.back();
    expect(closedCount()).toBe(1);
  });

  /**
   * The selection line is one cell holding every message it can show, plus an
   * invisible copy of the longest — a partial failure written with the widest
   * numbers a page can produce — so an outcome landing never makes it taller
   * and the list under it never moves (`CLAUDE.md` §4.4).
   */
  it('reserves the selection line at the longest outcome a page can produce', async () => {
    const { host } = await rendered({ pages: [page()] });

    const line = face(host, 'selection-line');
    const cells = [...line.children] as HTMLElement[];
    for (const cell of cells) {
      expect(cell.className).toContain('col-start-1 row-start-1');
    }
    const sizer = cells.find((cell) => cell.getAttribute('aria-hidden') === 'true');
    expect(sizer?.classList.contains('invisible')).toBe(true);
    expect(sizer?.textContent?.trim()).toBe(
      `Rejected ${AUTHOR_PAGE_SIZE} of ${AUTHOR_PAGE_SIZE}. ${AUTHOR_PAGE_SIZE} could not be confirmed and are still selected — try again.`,
    );
  });

  /**
   * Same rule, one row down: the status pill holds all its labels in one cell,
   * so a row rejected by the bulk action does not hand its question text more
   * room and re-wrap under the reviewer.
   */
  it('holds every status label in the pill, showing only the current one', async () => {
    const { view, host, settle } = await rendered({ pages: [page()] });
    view.toggleAll();
    view.setReason('Spam account.');

    await view.rejectSelected();
    await settle();

    const pill = host.querySelector<HTMLElement>('[data-cy="author-question-status"]')!;
    expect(pill.getAttribute('data-status')).toBe('rejected');
    const labels = [...pill.children] as HTMLElement[];
    expect(labels.map((label) => label.textContent?.trim())).toEqual([
      'Pending review',
      'Approved',
      'Rejected',
      'Unknown',
    ]);
    expect(labels.map((label) => label.classList.contains('invisible'))).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });
});

describe('AuthorContributionsComponent: paging', () => {
  const cursor: UserQuestionCursor = [1_760_000_000_000, 'p50'];
  const firstPage = (): UserQuestionsPage => ({
    questions: [question('p1'), question('p2')],
    next: cursor,
  });
  const secondPage = (): UserQuestionsPage => ({ questions: [question('p51')], next: null });

  it('asks for the page after the cursor it was handed, and replaces the list with it', async () => {
    const { view, getQuestionsByAuthor, settle } = await rendered({
      pages: [firstPage(), secondPage()],
    });

    view.older();
    await settle();

    expect(getQuestionsByAuthor).toHaveBeenLastCalledWith(AUTHOR, cursor);
    expect(view.rows().map((row) => row.id)).toEqual(['p51']);
    expect(view.pageIndex()).toBe(1);
  });

  /**
   * A selection belongs to the page it was made on. Kept across a page change
   * it would let one action name questions the reviewer can no longer see —
   * and more than a page of them, which is the bound the whole design rests on.
   */
  it('clears the selection with the page', async () => {
    const { view, settle } = await rendered({ pages: [firstPage(), secondPage()] });
    view.toggleAll();
    expect(view.selected().size).toBe(2);

    view.older();
    await settle();

    expect(view.selected().size).toBe(0);
  });

  it('goes back to the newer page from its own start', async () => {
    const { view, getQuestionsByAuthor, settle } = await rendered({
      pages: [firstPage(), secondPage(), firstPage()],
    });
    view.older();
    await settle();

    view.newer();
    await settle();

    expect(getQuestionsByAuthor).toHaveBeenLastCalledWith(AUTHOR, undefined);
    expect(view.pageIndex()).toBe(0);
    expect(view.rows().map((row) => row.id)).toEqual(['p1', 'p2']);
  });

  it('keeps the page that loaded when the next one fails, and retries the one that failed', async () => {
    let call = 0;
    const { view, getQuestionsByAuthor, settle } = await rendered({
      pages: () => {
        call++;
        if (call === 1) return Promise.resolve(firstPage());
        if (call === 2) return Promise.reject(new Error('timeout'));
        return Promise.resolve(secondPage());
      },
    });

    view.older();
    await settle();
    expect(view.statusView()).toBe('failed');
    expect(view.rows().map((row) => row.id)).toEqual(['p1', 'p2']);
    expect(view.pageIndex()).toBe(0);

    view.retry();
    await settle();

    expect(getQuestionsByAuthor).toHaveBeenLastCalledWith(AUTHOR, cursor);
    expect(view.rows().map((row) => row.id)).toEqual(['p51']);
    expect(view.statusView()).toBe('loaded');
  });

  it('offers paging only once there is more than one page', async () => {
    const single = await rendered({ pages: [{ questions: [question('p1')], next: null }] });
    expect(single.host.querySelector('[data-cy="author-paging"]')).toBeNull();
    TestBed.resetTestingModule();

    const paged = await rendered({ pages: [firstPage()] });
    expect(paged.host.querySelector('[data-cy="author-paging"]')).not.toBeNull();
    expect(face(paged.host, 'author-newer')).toHaveProperty('disabled', true);
    expect(face(paged.host, 'author-older')).toHaveProperty('disabled', false);
  });
});

describe('describeOutcome', () => {
  it('counts a whole success', () => {
    expect(english(describeOutcome(1, 1))).toBe('Rejected 1 question.');
    expect(english(describeOutcome(12, 12))).toBe('Rejected 12 questions.');
  });

  it('separates a partial failure from the success beside it', () => {
    expect(english(describeOutcome(10, 12))).toBe(
      'Rejected 10 of 12. 2 could not be confirmed and are still selected — try again.',
    );
  });

  it('never says a write was not saved — only that it could not be confirmed', () => {
    for (const sentence of [describeOutcome(0, 1), describeOutcome(0, 3), describeOutcome(2, 3)]) {
      expect(english(sentence)).toMatch(/could (not )?be confirmed/);
      expect(english(sentence)).not.toMatch(/not saved|failed/);
    }
  });
});
