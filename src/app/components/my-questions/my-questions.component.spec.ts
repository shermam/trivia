import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CustomQuestionContent, CustomQuestionDoc } from '../../models/question.model';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { FirebaseService, UserQuestionCursor } from '../../services/firebase.service';
import { TriviaService } from '../../services/trivia.service';
import { MyQuestion, MyQuestionsComponent, MyQuestionsView } from './my-questions.component';

/**
 * `/my-questions` (`FEAT-007`).
 *
 * The screen shows an author what became of their contributions, so what is
 * worth testing is not the markup but the four decisions around it: which of
 * the five states it resolves to (and that the two nobody asks for — "auth has
 * not answered" and "the read failed" — resolve to the least alarming thing,
 * `CLAUDE.md` §4.4); that a rejected row shows the reviewer's words, or says
 * plainly that there were none; that saving an edit puts the row back to
 * pending and drops the note that was about the text just replaced; and that
 * removing one takes it out of the list.
 */

interface FakeUser {
  uid: string;
  isAnonymous: boolean;
}

/** The template-facing members are `protected`; the spec drives them directly. */
interface InternalMyQuestions {
  view(): MyQuestionsView;
  questions(): MyQuestion[];
  hasMore(): boolean;
  loadError(): string | null;
  actionResult(): string;
  dialog(): { kind: 'edit' | 'remove'; question: MyQuestion } | null;
  dialogError(): string | null;
  validationSummary(): string | null;
  form: ReturnType<typeof import('../question-form/question-form').createQuestionForm>;
  openEdit(question: MyQuestion, event: Event): void;
  openRemove(question: MyQuestion, event: Event): void;
  closeDialog(): void;
  saveEdit(): Promise<void>;
  confirmRemove(): Promise<void>;
  showMore(): Promise<void>;
  retry(): void;
  openSignIn(): void;
  statusLabel(question: MyQuestion): string;
}

function myQuestion(id: string, overrides: Partial<CustomQuestionDoc> = {}): MyQuestion {
  return {
    id,
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question: `Q ${id}?`,
    correct_answer: 'A',
    incorrect_answers: ['B', 'C', 'D'],
    createdBy: 'author-1',
    createdAt: 1_760_000_000_000,
    status: 'pending',
    ...overrides,
  };
}

interface SetupOptions {
  user?: FakeUser | null;
  authReady?: boolean;
  questions?: MyQuestion[];
  next?: UserQuestionCursor | null;
  secondPage?: MyQuestion[];
  loadFails?: boolean;
  writeFails?: boolean;
  embedded?: boolean;
}

/**
 * Providers only — no component. `setup()` builds an instance by hand and
 * `render()` needs the same doubles behind a real fixture; configuring here
 * keeps the rendered tests from getting a second instance and asserting
 * against the one they are not driving.
 */
function configure(options: SetupOptions = {}) {
  const {
    user = { uid: 'author-1', isAnonymous: false },
    authReady = true,
    questions = [myQuestion('q1')],
    next = null,
    secondPage = [],
    loadFails = false,
    writeFails = false,
    embedded = false,
  } = options;

  const userSignal = signal<FakeUser | null>(user);
  const authReadySignal = signal(authReady);

  const getUserQuestions = vi.fn((_uid: string, after?: UserQuestionCursor) => {
    if (loadFails) {
      return Promise.reject(new Error('refused'));
    }
    return after === undefined
      ? Promise.resolve({ questions, next })
      : Promise.resolve({ questions: secondPage, next: null });
  });
  const updateUserQuestion = vi.fn((_id: string, _content: CustomQuestionContent) =>
    writeFails ? Promise.reject(new Error('refused')) : Promise.resolve(),
  );
  const deleteUserQuestion = vi.fn((_id: string) =>
    writeFails ? Promise.reject(new Error('refused')) : Promise.resolve(),
  );
  const open = vi.fn();

  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: FirebaseService,
        useValue: { getUserQuestions, updateUserQuestion, deleteUserQuestion },
      },
      { provide: TriviaService, useValue: { getCategories: () => Promise.resolve([]) } },
      {
        provide: AuthService,
        useValue: {
          user: userSignal,
          authReady: authReadySignal,
          isAnonymous: () => userSignal()?.isAnonymous ?? false,
        },
      },
      { provide: AuthMenuStateService, useValue: { open } },
      { provide: EmbedModeService, useValue: { isEmbedded: () => embedded } },
    ],
  });

  return {
    getUserQuestions,
    updateUserQuestion,
    deleteUserQuestion,
    userSignal,
    authReadySignal,
    open,
  };
}

function setup(options: SetupOptions = {}) {
  const doubles = configure(options);
  const component = TestBed.runInInjectionContext(
    () => new MyQuestionsComponent(),
  ) as never as InternalMyQuestions;
  return { component, ...doubles };
}

/** Runs pending effects, then drains the microtask queue the read resolves on. */
async function settle(): Promise<void> {
  TestBed.tick();
  await Promise.resolve();
  await Promise.resolve();
  TestBed.tick();
}

/** A click event whose `currentTarget` is a real, connected button. */
function clickOn(): Event {
  const button = document.createElement('button');
  document.body.appendChild(button);
  const event = new Event('click');
  Object.defineProperty(event, 'currentTarget', { value: button });
  return event;
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
  document.body.innerHTML = '';
});

describe('MyQuestionsComponent states', () => {
  it('shows the loading state, and reads nothing, before auth has answered', async () => {
    const { component, getUserQuestions } = setup({ user: null, authReady: false });

    await settle();

    expect(component.view()).toBe('loading');
    expect(getUserQuestions).not.toHaveBeenCalled();
  });

  /**
   * The `isAnonymous()` trap (`CLAUDE.md` §4.4): the signal is
   * `user()?.isAnonymous ?? false`, so it reads `false` when there is no user
   * **at all** — and a screen branching on the absence of a negative would show
   * a signed-out visitor an empty state claiming they have contributed nothing.
   */
  it('treats a null user as signed out rather than as an account with no questions', async () => {
    const { component, getUserQuestions } = setup({ user: null });

    await settle();

    expect(component.view()).toBe('signedOut');
    expect(getUserQuestions).not.toHaveBeenCalled();
  });

  it('treats an anonymous session as signed out — it can never have written one', async () => {
    const { component, getUserQuestions } = setup({
      user: { uid: 'anon', isAnonymous: true },
    });

    await settle();

    expect(component.view()).toBe('signedOut');
    expect(getUserQuestions).not.toHaveBeenCalled();
  });

  it('lists the questions the signed-in author wrote', async () => {
    const { component, getUserQuestions } = setup({
      questions: [myQuestion('q1'), myQuestion('q2')],
    });

    await settle();

    expect(getUserQuestions).toHaveBeenCalledWith('author-1');
    expect(component.view()).toBe('loaded');
    expect(component.questions().map((q) => q.id)).toEqual(['q1', 'q2']);
  });

  it('offers the empty state to an account that has contributed nothing', async () => {
    const { component } = setup({ questions: [] });

    await settle();

    expect(component.view()).toBe('empty');
  });

  /**
   * A failed read outranks an empty one. "You have not contributed anything" is
   * a claim, and a refused or timed-out read is not evidence for it — the same
   * false narration `CLAUDE.md` §4.4 forbids of an error message.
   */
  it('reports a failed read rather than an empty contribution list', async () => {
    const { component } = setup({ loadFails: true });

    await settle();

    expect(component.view()).toBe('failed');
    expect(component.loadError()).toMatch(/Could not load/);
  });

  it('clears the previous account rows when the account changes', async () => {
    const { component, getUserQuestions, userSignal } = setup({
      questions: [myQuestion('q1')],
    });
    await settle();
    expect(component.questions()).toHaveLength(1);

    userSignal.set(null);
    await settle();

    expect(component.view()).toBe('signedOut');
    expect(component.questions()).toEqual([]);
    expect(getUserQuestions).toHaveBeenCalledTimes(1);
  });

  it('appends the next page rather than replacing what is on screen', async () => {
    const { component } = setup({
      questions: [myQuestion('q1')],
      next: [1_760_000_000_000, 'q1'],
      secondPage: [myQuestion('q2')],
    });
    await settle();
    expect(component.hasMore()).toBe(true);

    await component.showMore();
    await settle();

    expect(component.questions().map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(component.hasMore()).toBe(false);
  });

  it('opens the auth menu rather than navigating anywhere', async () => {
    const { component, open } = setup({ user: null });
    await settle();

    component.openSignIn();

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('names each moderation status in words a contributor reads', () => {
    const { component } = setup();

    expect(component.statusLabel(myQuestion('q1', { status: 'pending' }))).toBe('Pending review');
    expect(component.statusLabel(myQuestion('q1', { status: 'approved' }))).toBe('Approved');
    expect(component.statusLabel(myQuestion('q1', { status: 'rejected' }))).toBe('Rejected');
    // A document predating the field. Nothing left in the bank has one, and the
    // screen still must not render `undefined` at a person.
    expect(component.statusLabel(myQuestion('q1', { status: undefined }))).toBe('Unknown');
  });
});

describe('MyQuestionsComponent editing', () => {
  it('fills the form from the question being edited', async () => {
    const { component } = setup({
      questions: [
        myQuestion('q1', {
          question: 'Original?',
          correct_answer: 'Yes',
          incorrect_answers: ['No', 'Maybe', 'Unsure'],
          sourceUrl: 'https://example.com/a',
          explanation: 'Because.',
        }),
      ],
    });
    await settle();

    component.openEdit(component.questions()[0], clickOn());

    expect(component.dialog()?.kind).toBe('edit');
    expect(component.form.getRawValue()).toMatchObject({
      question: 'Original?',
      correctAnswer: 'Yes',
      incorrectAnswers: ['No', 'Maybe', 'Unsure'],
      sourceUrl: 'https://example.com/a',
      explanation: 'Because.',
    });
  });

  /**
   * The edit's whole contract, from the author's side: the row goes back to
   * pending, and the reviewer's note goes with it — it was about the text that
   * has just been replaced, and `firestore.rules` refuses an owner edit that
   * leaves it standing.
   */
  it('sends the row back to pending and drops the old rejection note', async () => {
    const { component, updateUserQuestion } = setup({
      questions: [myQuestion('q1', { status: 'rejected', rejectionReason: 'The date is wrong.' })],
    });
    await settle();

    component.openEdit(component.questions()[0], clickOn());
    component.form.controls.question.setValue('Corrected?');
    await component.saveEdit();
    await settle();

    expect(updateUserQuestion).toHaveBeenCalledWith(
      'q1',
      expect.objectContaining({ question: 'Corrected?' }),
    );
    expect(component.questions()[0].status).toBe('pending');
    expect(component.questions()[0].rejectionReason).toBeUndefined();
    expect(component.dialog()).toBeNull();
    expect(component.actionResult()).toMatch(/pending review again/);
  });

  /**
   * `FEAT-019`. A resubmit rewrites the whole document, so a field the edit
   * form does not carry is a field the edit silently deletes — which is how an
   * author's Markdown question would come back rendering its own asterisks
   * after a one-word correction. The pair below is the round trip: the toggle
   * arrives set, and the value goes back out.
   */
  it('keeps the format when the author edits a markdown question', async () => {
    const { component, updateUserQuestion } = setup({
      questions: [myQuestion('q1', { question: '**Original?**', format: 'markdown' })],
    });
    await settle();

    component.openEdit(component.questions()[0], clickOn());
    expect(component.form.getRawValue().format).toBe('markdown');

    component.form.controls.question.setValue('**Corrected?**');
    await component.saveEdit();
    await settle();

    expect(updateUserQuestion).toHaveBeenCalledWith(
      'q1',
      expect.objectContaining({ format: 'markdown' }),
    );
  });

  /**
   * And the other direction, which is the one an exact-key allowlist makes
   * awkward: switching back to plain has to *remove* the key rather than write
   * `'plain'`, because an absent field is what plain means everywhere else
   * (`data-model.md` §3). `FirebaseService.updateUserQuestion` does the
   * removal; what this pins is that the content it is handed has no `format`
   * at all, rather than one it has to interpret.
   */
  it('drops the format when the author switches a markdown question back to plain', async () => {
    const { component, updateUserQuestion } = setup({
      questions: [myQuestion('q1', { question: '**Original?**', format: 'markdown' })],
    });
    await settle();

    component.openEdit(component.questions()[0], clickOn());
    component.form.controls.format.setValue('plain');
    await component.saveEdit();
    await settle();

    const [, content] = updateUserQuestion.mock.calls[0];
    expect('format' in content).toBe(false);
  });

  /**
   * The overwhelmingly common row: no `format` at all. The form has to open on
   * plain rather than on `undefined`, or the segmented control renders with
   * neither segment selected.
   */
  it('opens a question with no format on the plain segment', async () => {
    const { component } = setup({ questions: [myQuestion('q1')] });
    await settle();

    component.openEdit(component.questions()[0], clickOn());

    expect(component.form.getRawValue().format).toBe('plain');
  });

  it('refuses to save an invalid form and says which field is wrong', async () => {
    const { component, updateUserQuestion } = setup();
    await settle();

    component.openEdit(component.questions()[0], clickOn());
    component.form.controls.question.setValue('   ');
    await component.saveEdit();

    expect(updateUserQuestion).not.toHaveBeenCalled();
    expect(component.validationSummary()).toMatch(/Question/);
    expect(component.dialog()?.kind).toBe('edit');
  });

  /**
   * `firestore.rules` refuses a question whose correct answer also appears
   * among the incorrect ones (finding B1), so without this the author's only
   * feedback would be a `permission-denied` naming nothing.
   */
  it('names a duplicated answer instead of sending a write the rules refuse', async () => {
    const { component, updateUserQuestion } = setup();
    await settle();

    component.openEdit(component.questions()[0], clickOn());
    component.form.controls.correctAnswer.setValue('B');
    await component.saveEdit();

    expect(updateUserQuestion).not.toHaveBeenCalled();
    expect(component.dialogError()).toMatch(/listed more than once/);
  });

  it('keeps the dialog open and reports a refused save', async () => {
    const { component } = setup({ writeFails: true });
    await settle();

    component.openEdit(component.questions()[0], clickOn());
    await component.saveEdit();
    await settle();

    expect(component.dialog()?.kind).toBe('edit');
    expect(component.dialogError()).toMatch(/Could not save/);
    expect(component.questions()).toHaveLength(1);
  });
});

describe('MyQuestionsComponent removal', () => {
  it('asks before removing, and removes nothing until it is confirmed', async () => {
    const { component, deleteUserQuestion } = setup();
    await settle();

    component.openRemove(component.questions()[0], clickOn());

    expect(component.dialog()?.kind).toBe('remove');
    expect(deleteUserQuestion).not.toHaveBeenCalled();

    component.closeDialog();

    expect(component.dialog()).toBeNull();
    expect(deleteUserQuestion).not.toHaveBeenCalled();
    expect(component.questions()).toHaveLength(1);
  });

  it('drops the row once the removal lands', async () => {
    const { component, deleteUserQuestion } = setup({
      questions: [myQuestion('q1'), myQuestion('q2')],
    });
    await settle();

    component.openRemove(component.questions()[0], clickOn());
    await component.confirmRemove();
    await settle();

    expect(deleteUserQuestion).toHaveBeenCalledWith('q1');
    expect(component.questions().map((q) => q.id)).toEqual(['q2']);
    expect(component.dialog()).toBeNull();
    expect(component.actionResult()).toMatch(/removed from the app/i);
  });

  it('keeps the row and reports a refused removal', async () => {
    const { component } = setup({ writeFails: true });
    await settle();

    component.openRemove(component.questions()[0], clickOn());
    await component.confirmRemove();
    await settle();

    expect(component.dialog()?.kind).toBe('remove');
    expect(component.dialogError()).toMatch(/Could not remove/);
    expect(component.questions()).toHaveLength(1);
  });
});

/**
 * The two dialogs, rendered.
 *
 * jsdom has no layout and cannot enforce `inert` or `visibility`, so what this
 * can prove is the contract's *markup* half: the role, the modal promise, the
 * label it points at, and — the one a reviewer of the copy would look for
 * first — that the confirmation says "Remove from the app" rather than
 * promising an erasure the irrevocable licence makes impossible
 * (`FEAT-007` §0). The focus half needs a real browser and is pinned in the
 * Playwright spec.
 */
describe('MyQuestionsComponent rendered', () => {
  async function render(options: SetupOptions = {}) {
    const doubles = configure(options);
    const fixture = TestBed.createComponent(MyQuestionsComponent);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    return {
      ...doubles,
      fixture,
      host,
      query: (selector: string) => document.querySelector<HTMLElement>(selector),
      click: async (selector: string) => {
        document.querySelector<HTMLElement>(selector)!.click();
        await settle();
        fixture.detectChanges();
      },
    };
  }

  it('shows the reviewer words on a rejected question', async () => {
    const { query } = await render({
      questions: [myQuestion('q1', { status: 'rejected', rejectionReason: 'The date is wrong.' })],
    });

    expect(query('[data-cy="my-question-rejection"]')?.textContent).toContain('The date is wrong.');
    expect(query('[data-cy="my-question-status"]')?.textContent).toContain('Rejected');
  });

  // The normal case rather than an error: a reviewer may reject without one,
  // and every question rejected before the field existed has none.
  it('says plainly when a rejection carries no reason', async () => {
    const { query } = await render({
      questions: [myQuestion('q1', { status: 'rejected' })],
    });

    expect(query('[data-cy="my-question-rejection"]')?.textContent).toContain(
      'No reason was given',
    );
  });

  it('shows no rejection block on a question that was not rejected', async () => {
    const { query } = await render({ questions: [myQuestion('q1', { status: 'approved' })] });

    expect(query('[data-cy="my-question-rejection"]')).toBeNull();
  });

  it('opens the edit dialog as a labelled modal carrying the shared form', async () => {
    const { query, click } = await render();

    await click('[data-cy="edit-question"]');

    const dialog = query('[data-cy="edit-question-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('edit-dialog-title');
    expect(query('#edit-dialog-title')).not.toBeNull();
    // The shared fields, under this dialog's own id prefix, so a page showing
    // both this and `/add-question` would still have one `<label for>` per
    // control.
    expect(query('#edit-question')).not.toBeNull();
    expect(query('#edit-correctAnswer')).not.toBeNull();
  });

  it('says "Remove from the app", never "delete permanently"', async () => {
    const { query, click } = await render();

    await click('[data-cy="remove-question"]');

    const dialog = query('[data-cy="remove-question-dialog"]');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const text = dialog?.textContent ?? '';
    expect(text).toContain('Remove from the app');
    expect(text).toContain('does not withdraw the licence');
    expect(text.toLowerCase()).not.toContain('delete permanently');
    expect(text.toLowerCase()).not.toContain('permanently delete');
  });

  /**
   * The bug this exists for shipped and was caught only by Playwright: the edit
   * form carried `(ngSubmit)` with no `[formGroup]` on the `<form>` itself, so
   * the binding listened for an event nobody raises, the submit button fell
   * through to a **native** form submission, and the browser navigated away.
   * On screen that is indistinguishable from a save that closed the dialog and
   * did nothing — the row simply still says what it said.
   *
   * Driving the real submit event is the whole point; calling `saveEdit()`
   * directly proves nothing about the wiring, which is the thing that was
   * wrong (`CLAUDE.md` §4.4's "drive the real element").
   */
  it('saves when the form is submitted, not only when the method is called', async () => {
    const { query, click, updateUserQuestion, fixture } = await render();
    await click('[data-cy="edit-question"]');

    query('[data-cy="edit-question-dialog"]')!
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    fixture.detectChanges();

    expect(updateUserQuestion).toHaveBeenCalledTimes(1);
  });

  it('closes a dialog on Escape', async () => {
    const { query, click, fixture } = await render();
    await click('[data-cy="remove-question"]');

    query('[data-cy="remove-question-dialog"]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await settle();
    fixture.detectChanges();

    expect(query('[data-cy="remove-question-dialog"]')).toBeNull();
  });

  it('announces both triggers as opening a dialog, and only the open one as expanded', async () => {
    // `aria-haspopup` + `aria-expanded` are the disclosure contract
    // (`CLAUDE.md` §4.5), and the expanded state is per row: every row has its
    // own pair of buttons, so a page-level "a dialog is open" would announce
    // every trigger on screen as expanded whenever any one of them was.
    const { query, click } = await render({
      questions: [myQuestion('q1'), myQuestion('q2')],
    });

    const editTriggers = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-cy="edit-question"]'));
    for (const trigger of editTriggers()) {
      expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    }
    expect(query('[data-cy="remove-question"]')?.getAttribute('aria-haspopup')).toBe('dialog');

    await click('[data-cy="edit-question"]');

    expect(editTriggers()[0].getAttribute('aria-expanded')).toBe('true');
    // The other row's Edit, and this row's Remove, are not the open dialog.
    expect(editTriggers()[1].getAttribute('aria-expanded')).toBe('false');
    expect(query('[data-cy="remove-question"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  /**
   * Focus on close, both ways round.
   *
   * The interesting half is the second: confirming a removal deletes the row
   * the opener lived on, so the restore has nothing to go back to, and focus
   * asked to stay on a detached element drops silently to `<body>` — a
   * keyboard user returned to the top of the document with no announcement
   * (`CLAUDE.md` §4.5). jsdom enforces that much, because a detached node
   * genuinely cannot take focus.
   */
  it('returns focus to the trigger when a dialog is cancelled', async () => {
    const { query, click, fixture } = await render();
    await click('[data-cy="edit-question"]');
    const opener = query('[data-cy="edit-question"]')!;

    await click('[data-cy="cancel-edit"]');
    await settle();
    fixture.detectChanges();

    expect(document.activeElement).toBe(opener);
  });

  it('falls back to the status block when the trigger row has just been removed', async () => {
    const { query, click, fixture } = await render();
    await click('[data-cy="remove-question"]');

    await click('[data-cy="confirm-remove"]');
    await settle();
    fixture.detectChanges();

    expect(query('[data-cy="my-question"]')).toBeNull();
    expect(document.activeElement).toBe(query('[data-cy="my-questions-status"]'));
    expect(document.activeElement).not.toBe(document.body);
  });
});
