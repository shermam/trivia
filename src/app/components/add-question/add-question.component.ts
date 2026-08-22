import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { Difficulty, NewCustomQuestionDoc, QuestionType } from '../../models/question.model';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { FirebaseService, QuestionQuotaExceededError } from '../../services/firebase.service';
import { isFirestorePermissionDenied } from '../../services/firestore-rest/firestore-rest.client';
import { SubscriptionService } from '../../services/subscription.service';
import { TriviaCategory, TriviaService } from '../../services/trivia.service';
import { IconComponent } from '../icon/icon.component';

/**
 * `Validators.required` accepts `"   "`, and `firestore.rules` does not: it
 * checks `size() > 0` on the *trimmed* value this component sends. Without a
 * trim-aware check the form would happily submit whitespace and the write
 * would come back as a bare `permission-denied` — a rejection the user cannot
 * act on, for a rule the client already knows about.
 */
function nonBlank(control: AbstractControl): ValidationErrors | null {
  return typeof control.value === 'string' && control.value.trim().length === 0
    ? { required: true }
    : null;
}

@Component({
  selector: 'app-add-question',
  standalone: true,
  imports: [ReactiveFormsModule, IconComponent],
  templateUrl: './add-question.component.html',
  styleUrl: './add-question.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddQuestionComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly firebaseService = inject(FirebaseService);
  private readonly triviaService = inject(TriviaService);
  private readonly router = inject(Router);
  protected readonly authService = inject(AuthService);
  protected readonly authMenuState = inject(AuthMenuStateService);
  protected readonly subscriptionService = inject(SubscriptionService);

  protected readonly categories = signal<TriviaCategory[]>([]);
  protected readonly isSubmitting = signal(false);
  protected readonly submitError = signal<string | null>(null);
  protected readonly hasSubmitted = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    category: ['', [Validators.required, nonBlank, Validators.maxLength(100)]],
    difficulty: ['medium' as Difficulty, Validators.required],
    type: ['multiple' as QuestionType, Validators.required],
    question: ['', [Validators.required, nonBlank, Validators.maxLength(500)]],
    correctAnswer: ['', [Validators.required, nonBlank, Validators.maxLength(200)]],
    // Required only for a "multiple" question — for a boolean one these three
    // are irrelevant and hidden, and the opposite value is derived instead.
    // The validators are therefore applied and cleared as `type` changes
    // (see the constructor) rather than checked by hand at submit time: that
    // keeps `form.invalid` the single source of truth, which is what lets the
    // template render per-field errors and the submit handler focus the first
    // offending control.
    incorrectAnswers: this.fb.nonNullable.array([
      this.fb.nonNullable.control(''),
      this.fb.nonNullable.control(''),
      this.fb.nonNullable.control(''),
    ]),
  });

  /**
   * Set when a submit was refused before it left the browser. Rendered next
   * to the button *and* announced, because the failure this exists for is a
   * user clicking Save repeatedly while nothing whatsoever happens.
   */
  protected readonly validationSummary = signal<string | null>(null);

  constructor() {
    this.applyIncorrectAnswerValidators(this.form.controls.type.value);
    this.form.controls.type.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((type) => this.applyIncorrectAnswerValidators(type));
  }

  private applyIncorrectAnswerValidators(type: QuestionType): void {
    for (const control of this.form.controls.incorrectAnswers.controls) {
      if (type === 'multiple') {
        control.setValidators([Validators.required, nonBlank, Validators.maxLength(200)]);
      } else {
        control.clearValidators();
      }
      // `emitEvent: false` — this runs inside a `valueChanges` subscription on
      // the same form, and re-emitting from here would re-enter it.
      control.updateValueAndValidity({ emitEvent: false });
    }
  }

  // Angular calls `ngOnInit` and discards whatever it returns, so an `async`
  // one is an interface misuse: any rejection escapes as an unhandled promise
  // rather than being reported. Keep the hook synchronous and kick the async
  // work off explicitly.
  ngOnInit(): void {
    void this.loadCategories();
  }

  private async loadCategories(): Promise<void> {
    try {
      this.categories.set(await this.triviaService.getCategories());
    } catch {
      // Category suggestions are a nicety (via <datalist>) — the category
      // field stays a free-text input either way.
    }
  }

  protected openSignIn(): void {
    this.authMenuState.open();
  }

  protected async resendVerification(): Promise<void> {
    this.submitError.set(null);
    try {
      await this.authService.resendVerificationEmail();
    } catch {
      this.submitError.set('Could not send the verification email. Please try again.');
    }
  }

  protected async onSubmit(): Promise<void> {
    if (
      this.isSubmitting() ||
      !this.authService.isFullyAuthenticated() ||
      !this.subscriptionService.isProUser()
    ) {
      return;
    }

    // Every field's validity now lives on the form itself (see
    // `applyIncorrectAnswerValidators`), so an invalid submit can say *what*
    // is wrong and put the cursor on it. It used to `markAllAsTouched()` and
    // return into a template that rendered no field errors at all — so
    // forgetting the category produced a Save button that silently did
    // nothing, with no way to discover why.
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.validationSummary.set(this.describeMissingFields());
      this.focusFirstInvalidControl();
      return;
    }
    this.validationSummary.set(null);

    const raw = this.form.getRawValue();
    const isBoolean = raw.type === 'boolean';
    const incorrectAnswers = isBoolean
      ? [raw.correctAnswer.trim() === 'True' ? 'False' : 'True']
      : raw.incorrectAnswers.map((answer) => answer.trim());

    // The one rule the form's own validators can't express: a boolean
    // question's correct answer has to be one of exactly two literals.
    if (isBoolean && raw.correctAnswer !== 'True' && raw.correctAnswer !== 'False') {
      this.form.controls.correctAnswer.markAsTouched();
      this.validationSummary.set('Choose whether the statement is true or false.');
      return;
    }

    // `firestore.rules` rejects these outright (finding B1), so without a
    // check here the submitter's only feedback would be a raw
    // permission-denied that names nothing. Compared case-insensitively on
    // trimmed text: "Paris" and "paris " are the same answer to a player, and
    // a question offering both is broken whatever the rules make of it.
    const duplicate = findDuplicateAnswer(raw.correctAnswer.trim(), incorrectAnswers);
    if (duplicate) {
      this.submitError.set(
        `"${duplicate}" is listed more than once. Every answer has to be different, ` +
          `or the question would have two right answers.`,
      );
      return;
    }

    // `isFullyAuthenticated()` above already implies a signed-in user, but the
    // uid is needed as a value here, so read it explicitly rather than
    // asserting non-null.
    const author = this.authService.user();
    if (!author) {
      return;
    }

    const question: NewCustomQuestionDoc = {
      category: raw.category.trim(),
      type: raw.type,
      difficulty: raw.difficulty,
      question: raw.question.trim(),
      correct_answer: raw.correctAnswer.trim(),
      incorrect_answers: incorrectAnswers,
      // Attribution. `firestore.rules` requires createdBy to equal the
      // caller's own uid and createdAt to be near server time, so a submission
      // can't be attributed to someone else or backdated.
      createdBy: author.uid,
      createdAt: Date.now(),
    };

    this.isSubmitting.set(true);
    this.submitError.set(null);
    try {
      // Guarantees the write carries an up-to-date `stripeRole` claim even
      // if this user's Pro status just changed (e.g. in another tab, or
      // moments ago via SubscriptionService's own background refresh that
      // may not have landed yet) — firestore.rules checks the claim on the
      // token attached to this exact request, not the client's cached
      // `isProUser` signal.
      await this.authService.refreshIdToken();
      await this.firebaseService.addCustomQuestion(question);
      this.hasSubmitted.set(true);
    } catch (error) {
      this.submitError.set(this.explainSubmitFailure(error));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  /**
   * Says why the write was refused, but only where that can be *checked*.
   *
   * The rules gate this write on the `stripeRole` claim, and the token was
   * force-refreshed on the line above — so if the claim still isn't there, a
   * `permission-denied` has exactly one explanation available to the client,
   * and it is one the user can act on. That is the difference from B4's
   * mistake: this is read from the refreshed token, not guessed from the
   * error code.
   *
   * It is a real state, not a hypothetical: an active subscription whose
   * price carries no `firebaseRole` metadata mirrors into Firestore with
   * `role: null`, so the webhook never derives a claim (`functions/src/
   * role.ts`) and every submission is refused. Before this, that user saw
   * "Please try again" forever.
   *
   * Any other cause — a clock outside the accepted window, a field the rules
   * bound more tightly than the form does, a network failure — stays generic
   * rather than being narrated wrongly.
   */
  private explainSubmitFailure(error: unknown): string {
    // Checked, not guessed. `FirebaseService` only raises this after reading
    // the counter back and finding the hour genuinely full — a refusal on its
    // own would not license the claim, since a stale counter is refused
    // identically (`CLAUDE.md` §4.4, finding B4).
    if (error instanceof QuestionQuotaExceededError) {
      return error.message;
    }
    const isPermissionDenied = isFirestorePermissionDenied(error);
    if (isPermissionDenied && !this.authService.isProUser()) {
      return (
        'Your account does not have Pro access right now, so the question was rejected. ' +
        'If you just subscribed, sign out and back in — it can take a moment to apply.'
      );
    }
    return 'Could not save your question. Please try again.';
  }

  /** Field labels in form order, for the summary and the focus target. */
  private readonly fieldLabels: { control: AbstractControl; id: string; label: string }[] = [
    { control: this.form.controls.category, id: 'category', label: 'Category' },
    { control: this.form.controls.question, id: 'question', label: 'Question' },
    { control: this.form.controls.correctAnswer, id: 'correctAnswer', label: 'Correct answer' },
    ...this.form.controls.incorrectAnswers.controls.map((control, index) => ({
      control,
      id: `incorrect-answer-${index}`,
      label: `Incorrect answer ${index + 1}`,
    })),
  ];

  private describeMissingFields(): string {
    const invalid = this.fieldLabels.filter((field) => field.control.invalid);
    if (invalid.length === 0) {
      return 'Please check the form and try again.';
    }
    if (invalid.length === 1) {
      return `${invalid[0].label} needs your attention before this can be saved.`;
    }
    return `${invalid.length} fields need your attention: ${invalid
      .map((field) => field.label.toLowerCase())
      .join(', ')}.`;
  }

  /**
   * Puts the cursor on the first thing that's wrong. Without it, a long form
   * can report an error that is scrolled off screen — the same "nothing
   * happened" experience in a different costume.
   */
  private focusFirstInvalidControl(): void {
    const first = this.fieldLabels.find((field) => field.control.invalid);
    if (first) {
      document.getElementById(first.id)?.focus();
    }
  }

  /** Whether to show a field's error — only once the user has engaged with it. */
  protected showsError(control: AbstractControl): boolean {
    return control.invalid && (control.touched || control.dirty);
  }

  protected errorFor(control: AbstractControl, label: string, maxLength: number): string {
    if (control.hasError('required')) {
      return `${label} is required.`;
    }
    if (control.hasError('maxlength')) {
      return `${label} must be ${maxLength} characters or fewer.`;
    }
    return '';
  }

  protected addAnother(): void {
    this.hasSubmitted.set(false);
    this.submitError.set(null);
    this.form.reset({ difficulty: 'medium', type: 'multiple' });
  }

  protected backToGame(): void {
    void this.router.navigateByUrl('/');
  }

  protected goToPricing(): void {
    void this.router.navigateByUrl('/pricing');
  }
}

/**
 * The repeated answer, if any, comparing trimmed text case-insensitively.
 *
 * Returns the offending text rather than a boolean so the message can name it
 * — "one of your answers is duplicated" leaves the submitter hunting through
 * four fields.
 */
function findDuplicateAnswer(correctAnswer: string, incorrectAnswers: string[]): string | null {
  const seen = new Set<string>();
  for (const answer of [correctAnswer, ...incorrectAnswers]) {
    const key = answer.trim().toLowerCase();
    if (seen.has(key)) {
      return answer.trim();
    }
    seen.add(key);
  }
  return null;
}
