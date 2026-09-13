import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NewCustomQuestionDoc } from '../../models/question.model';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { FirebaseService, QuestionQuotaExceededError } from '../../services/firebase.service';
import { isFirestorePermissionDenied } from '../../services/firestore-rest/firestore-rest.client';
import { SubscriptionService } from '../../services/subscription.service';
import { TriviaCategory, TriviaService } from '../../services/trivia.service';
import { IconComponent } from '../icon/icon.component';
import { QuestionFieldsComponent } from '../question-form/question-fields.component';
import {
  applyIncorrectAnswerValidators,
  createQuestionForm,
  describeInvalidFields,
  duplicateAnswerMessage,
  focusFirstInvalidControl,
  questionFields,
  toQuestionContent,
} from '../question-form/question-form';

@Component({
  selector: 'app-add-question',
  standalone: true,
  imports: [ReactiveFormsModule, IconComponent, QuestionFieldsComponent],
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

  /**
   * The shared question form (`question-form.ts`), which `/my-questions`' edit
   * dialog builds from the same factory — one set of bounds mirroring
   * `firestore.rules`, rather than two that can drift.
   */
  protected readonly form = createQuestionForm(this.fb);

  /**
   * Set when a submit was refused before it left the browser. Rendered next
   * to the button *and* announced, because the failure this exists for is a
   * user clicking Save repeatedly while nothing whatsoever happens.
   */
  protected readonly validationSummary = signal<string | null>(null);

  constructor() {
    applyIncorrectAnswerValidators(this.form, this.form.controls.type.value);
    this.form.controls.type.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((type) => applyIncorrectAnswerValidators(this.form, type));
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

    // Every field's validity lives on the form itself, so an invalid submit can
    // say *what* is wrong and put the cursor on it. It used to
    // `markAllAsTouched()` and return into a template that rendered no field
    // errors at all — so forgetting the category produced a Save button that
    // silently did nothing, with no way to discover why.
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      const fields = questionFields(this.form);
      this.validationSummary.set(describeInvalidFields(fields));
      focusFirstInvalidControl(fields);
      return;
    }
    this.validationSummary.set(null);

    const { content, duplicate, invalidBoolean } = toQuestionContent(this.form.getRawValue());
    // The one rule the form's own validators can't express: a boolean
    // question's correct answer has to be one of exactly two literals.
    if (invalidBoolean) {
      this.form.controls.correctAnswer.markAsTouched();
      this.validationSummary.set('Choose whether the statement is true or false.');
      return;
    }
    if (duplicate) {
      this.submitError.set(duplicateAnswerMessage(duplicate));
      return;
    }
    if (!content) {
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
      ...content,
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
