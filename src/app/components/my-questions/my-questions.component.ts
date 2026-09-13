import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CustomQuestionDoc, QuestionStatus } from '../../models/question.model';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { FirebaseService, UserQuestionCursor } from '../../services/firebase.service';
import { TriviaCategory, TriviaService } from '../../services/trivia.service';
import { keepTabInside } from '../../utils/focus-trap.util';
import { IconComponent } from '../icon/icon.component';
import { QuestionFieldsComponent } from '../question-form/question-fields.component';
import {
  applyIncorrectAnswerValidators,
  createQuestionForm,
  describeInvalidFields,
  duplicateAnswerMessage,
  focusFirstInvalidControl,
  patchQuestionForm,
  questionFields,
  toQuestionContent,
} from '../question-form/question-form';

/** One of the author's own questions, as this screen holds it. */
export type MyQuestion = CustomQuestionDoc & { id: string };

/**
 * What the card is showing. Enumerated in one `computed` rather than as a
 * template chain, for the reason `/profile`'s five states are: the *ordering*
 * of those branches is itself a defect no template test can reach, and the
 * default has to be the least alarming one (`CLAUDE.md` §4.4).
 */
export type MyQuestionsView = 'signedOut' | 'loading' | 'failed' | 'empty' | 'loaded';

/** Which dialog is open over the list, and about which question. */
interface OpenDialog {
  kind: 'edit' | 'remove';
  question: MyQuestion;
}

const STATUS_LABELS: Record<QuestionStatus, string> = {
  pending: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
};

/**
 * The author's own contributions (`FEAT-007`): what became of each one, and the
 * two things only its author may do to it.
 *
 * **Nothing here is a privilege check.** `firestore.rules` decides whether the
 * read returns anything and whether either button does anything; this screen
 * decides what to render (`CLAUDE.md` §4.2). A signed-out visitor is told what
 * the page is for rather than redirected — there is no guard in this app and no
 * `/login` route to send them to, and an anonymous session can never have
 * written a question anyway, because `create` requires a real, verified
 * account.
 *
 * **Editing is not gated on Pro, and that is deliberate** (`FEAT-007` §0):
 * contributing more questions is what the subscription buys, and correcting or
 * withdrawing one already written is not. A lapsed author who cannot fix their
 * own mistake leaves a wrong question in circulation for everybody.
 */
@Component({
  selector: 'app-my-questions',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, IconComponent, QuestionFieldsComponent],
  templateUrl: './my-questions.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyQuestionsComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly firebaseService = inject(FirebaseService);
  private readonly triviaService = inject(TriviaService);
  protected readonly authService = inject(AuthService);
  protected readonly authMenuState = inject(AuthMenuStateService);
  protected readonly embedMode = inject(EmbedModeService);

  protected readonly questions = signal<MyQuestion[]>([]);
  protected readonly cursor = signal<UserQuestionCursor | null>(null);
  protected readonly hasMore = computed(() => this.cursor() !== null);
  protected readonly isLoading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly categories = signal<TriviaCategory[]>([]);

  /**
   * Which uid the rows on screen belong to.
   *
   * The read is asynchronous and the account can change under it — signing out
   * of one account and into another, or the anonymous session resolving after
   * the first paint. Writing a late answer for the previous uid would show one
   * person another person's contributions, which is the same stale-answer bug
   * `ReviewerService` guards against for the moderation role.
   */
  private loadedUid: string | null = null;

  /**
   * Positively "a real account", never "not anonymous". `isAnonymous()` is
   * `user()?.isAnonymous ?? false`, which is `false` when there is no user at
   * all — so every frame before auth resolves would fall through to the
   * signed-in branch and this page would flash a "no questions yet" empty state
   * at a visitor who has not been asked to sign in (`CLAUDE.md` §4.4).
   */
  protected readonly showsRealAccount = computed(
    () => this.authService.user() !== null && !this.authService.isAnonymous(),
  );

  protected readonly view = computed<MyQuestionsView>(() => {
    // "We do not know yet" resolves to the loading face, never to a claim
    // about the reader's account or their contributions.
    if (!this.authService.authReady()) {
      return 'loading';
    }
    if (!this.showsRealAccount()) {
      return 'signedOut';
    }
    if (this.isLoading()) {
      return 'loading';
    }
    // A failed read outranks an empty one: "you have not contributed anything"
    // is a claim, and a refused or timed-out read is not evidence for it.
    if (this.loadError()) {
      return 'failed';
    }
    return this.questions().length === 0 ? 'empty' : 'loaded';
  });

  /**
   * Announced on every outcome — an edit and a removal both mutate the list
   * under the reader, which is silent to assistive tech otherwise.
   *
   * There is deliberately no page-level *error* signal beside it. Both writes
   * are made from inside a dialog and both report their failure into that
   * dialog (`dialogError`), where the reader already is and where the retry
   * is: an error banner behind the dialog would be one nobody is looking at.
   */
  protected readonly actionResult = signal('');

  protected readonly dialog = signal<OpenDialog | null>(null);

  /**
   * Whether *this row's* dialog of *this kind* is the one showing, for the
   * trigger's `aria-expanded`. Per row rather than per page: every row has its
   * own Edit and Remove, so a bare "a dialog is open" would announce every
   * trigger on the screen as expanded whenever any one of them was.
   */
  protected isDialogOpenFor(kind: OpenDialog['kind'], question: MyQuestion): boolean {
    const open = this.dialog();
    return open?.kind === kind && open.question.id === question.id;
  }
  protected readonly isSaving = signal(false);
  protected readonly dialogError = signal<string | null>(null);
  protected readonly validationSummary = signal<string | null>(null);

  /** The shared question form, filled from the row being edited. */
  protected readonly form = createQuestionForm(this.fb);

  /**
   * The block of stacked messages. Focus target twice over: when a retry hides
   * the button it was called from, and when a dialog closes onto a row that no
   * longer exists — see `retry()` and the focus effect.
   */
  private readonly statusBlock = viewChild<ElementRef<HTMLElement>>('statusBlock');
  private readonly dialogElement = viewChild<ElementRef<HTMLElement>>('dialogElement');
  private wasDialogOpen = false;
  /**
   * The control that opened the dialog, captured when it is opened rather than
   * read from `document.activeElement`.
   *
   * Each row has its own Edit and Remove buttons, so there is one opener per
   * dialog instance and no ambiguity to resolve — and reading `activeElement`
   * would be actively worse: a click does not focus a `<button>` on
   * Safari/macOS, so the capture reads `<body>`, which is connected, so the
   * restore "succeeds" into nothing (`CLAUDE.md` §4.5).
   */
  private dialogOpener: HTMLElement | null = null;

  constructor() {
    this.form.controls.type.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((type) => applyIncorrectAnswerValidators(this.form, type));

    // Re-reads whenever the account changes, sign-out included — which has to
    // clear the rows rather than leave the previous account's contributions on
    // screen.
    effect(() => {
      if (!this.authService.authReady()) {
        return;
      }
      const uid = this.showsRealAccount() ? (this.authService.user()?.uid ?? null) : null;
      if (uid === this.loadedUid) {
        return;
      }
      this.loadedUid = uid;
      this.questions.set([]);
      this.cursor.set(null);
      if (uid === null) {
        this.isLoading.set(false);
        return;
      }
      void this.load(uid);
    });

    // The dialog's focus contract. Deferred by a microtask for the reason
    // game-over's is: the dialog element does not exist yet on the pass that
    // opens it, and still exists on the pass that closes it, so a decision made
    // inside the effect reads the previous frame (`CLAUDE.md` §4.4).
    effect(() => {
      const isOpen = this.dialog() !== null;
      const element = this.dialogElement();

      if (isOpen && element) {
        // The dialog itself, not its first control, so it is announced with its
        // title before Tab reaches anything inside it.
        element.nativeElement.focus();
      }

      if (!isOpen && this.wasDialogOpen) {
        const opener = this.dialogOpener;
        const fallback = this.statusBlock();
        this.dialogOpener = null;
        queueMicrotask(() => {
          if (opener?.isConnected) {
            opener.focus();
            return;
          }
          // The opener is gone, which is the *expected* path for a removal:
          // confirming it deletes the row the button lived on. Focus asked to
          // stay on a detached element drops silently to `<body>`
          // (`CLAUDE.md` §4.5), sending a keyboard user back to the top of the
          // document — so it goes to the status block instead, which is
          // present in every state and carries the sentence that says what
          // just happened.
          fallback?.nativeElement.focus();
        });
      }

      this.wasDialogOpen = isOpen;
    });
  }

  ngOnInit(): void {
    void this.loadCategories();
  }

  private async loadCategories(): Promise<void> {
    try {
      this.categories.set(await this.triviaService.getCategories());
    } catch {
      // Suggestions are a nicety; the category field is free text either way.
    }
  }

  private async load(uid: string): Promise<void> {
    this.isLoading.set(true);
    this.loadError.set(null);
    try {
      const page = await this.firebaseService.getUserQuestions(uid);
      if (this.loadedUid !== uid) {
        return;
      }
      this.questions.set(page.questions);
      this.cursor.set(page.next);
    } catch {
      // Deliberately generic: a refused read, a timeout and a network fault
      // are indistinguishable here, and narrating one the client did not verify
      // is what `CLAUDE.md` §4.4 forbids. What it must never do is fall through
      // to the empty state — "you have not contributed anything" is a claim,
      // and a read that failed is not evidence for it.
      if (this.loadedUid === uid) {
        this.loadError.set('Could not load your questions. Please try again.');
      }
    } finally {
      if (this.loadedUid === uid) {
        this.isLoading.set(false);
      }
    }
  }

  /**
   * Re-runs a read that failed.
   *
   * Moves focus before starting it, because starting it is what takes the
   * focused element away: the block returns to its loading face, "Try again"
   * turns `visibility: hidden`, and focus asked to stay on a hidden element
   * drops silently to `<body>` (`CLAUDE.md` §4.4).
   */
  protected retry(): void {
    this.statusBlock()?.nativeElement.focus();
    const uid = this.loadedUid;
    if (uid) {
      void this.load(uid);
    }
  }

  /** Appends the page after the last row, keeping what is already on screen. */
  protected async showMore(): Promise<void> {
    const cursor = this.cursor();
    const uid = this.loadedUid;
    if (cursor === null || uid === null || this.isLoading()) {
      return;
    }
    this.isLoading.set(true);
    this.loadError.set(null);
    try {
      const page = await this.firebaseService.getUserQuestions(uid, cursor);
      // Two clicks in flight at once, or a reload landing in between, would
      // otherwise append the same page twice.
      if (this.loadedUid === uid && this.cursor() === cursor) {
        this.questions.update((rows) => [...rows, ...page.questions]);
        this.cursor.set(page.next);
      }
    } catch {
      if (this.loadedUid === uid) {
        this.loadError.set('Could not load more of your questions. Please try again.');
      }
    } finally {
      if (this.loadedUid === uid) {
        this.isLoading.set(false);
      }
    }
  }

  protected openSignIn(): void {
    this.authMenuState.open();
  }

  protected openEdit(question: MyQuestion, event: Event): void {
    this.dialogOpener = event.currentTarget as HTMLElement | null;
    this.dialogError.set(null);
    this.validationSummary.set(null);
    patchQuestionForm(this.form, question);
    this.dialog.set({ kind: 'edit', question });
  }

  protected openRemove(question: MyQuestion, event: Event): void {
    this.dialogOpener = event.currentTarget as HTMLElement | null;
    this.dialogError.set(null);
    this.dialog.set({ kind: 'remove', question });
  }

  protected closeDialog(): void {
    if (this.isSaving()) {
      return;
    }
    this.dialog.set(null);
  }

  protected keepFocusInDialog(event: KeyboardEvent): void {
    keepTabInside(event, this.dialogElement()?.nativeElement);
  }

  protected async saveEdit(): Promise<void> {
    const open = this.dialog();
    if (this.isSaving() || open?.kind !== 'edit') {
      return;
    }

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      const fields = questionFields(this.form, 'edit-');
      this.validationSummary.set(describeInvalidFields(fields));
      focusFirstInvalidControl(fields);
      return;
    }
    this.validationSummary.set(null);

    const { content, duplicate, invalidBoolean } = toQuestionContent(this.form.getRawValue());
    if (invalidBoolean) {
      this.form.controls.correctAnswer.markAsTouched();
      this.validationSummary.set('Choose whether the statement is true or false.');
      return;
    }
    if (duplicate) {
      this.dialogError.set(duplicateAnswerMessage(duplicate));
      return;
    }
    if (!content) {
      return;
    }

    this.isSaving.set(true);
    this.dialogError.set(null);
    try {
      await this.firebaseService.updateUserQuestion(open.question.id, content);
      // Applied locally rather than refetched: the whole page would otherwise
      // reload behind a dialog the reader has just dismissed, and the new row
      // is entirely known here. `rejectionReason` is dropped because the write
      // clears it — the note was about the text that has just been replaced.
      this.questions.update((rows) =>
        rows.map((row) =>
          row.id === open.question.id
            ? {
                id: row.id,
                createdBy: row.createdBy,
                createdAt: row.createdAt,
                status: 'pending' as const,
                ...content,
              }
            : row,
        ),
      );
      this.dialog.set(null);
      this.actionResult.set('Question updated. It is pending review again.');
    } catch {
      this.dialogError.set('Could not save your changes. Please try again.');
    } finally {
      this.isSaving.set(false);
    }
  }

  protected async confirmRemove(): Promise<void> {
    const open = this.dialog();
    if (this.isSaving() || open?.kind !== 'remove') {
      return;
    }
    this.isSaving.set(true);
    this.dialogError.set(null);
    try {
      await this.firebaseService.deleteUserQuestion(open.question.id);
      this.questions.update((rows) => rows.filter((row) => row.id !== open.question.id));
      this.dialog.set(null);
      this.actionResult.set('Question removed from the app.');
    } catch {
      this.dialogError.set('Could not remove that question. Please try again.');
    } finally {
      this.isSaving.set(false);
    }
  }

  protected statusLabel(question: MyQuestion): string {
    return question.status ? STATUS_LABELS[question.status] : 'Unknown';
  }

  protected submittedAt(question: MyQuestion): string {
    return question.createdAt ? new Date(question.createdAt).toLocaleString() : 'Unknown';
  }
}
