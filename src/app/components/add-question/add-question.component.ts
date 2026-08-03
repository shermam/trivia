import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { CustomQuestionDoc, Difficulty, QuestionType } from '../../models/question.model';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { FirebaseService } from '../../services/firebase.service';
import { SubscriptionService } from '../../services/subscription.service';
import { TriviaCategory, TriviaService } from '../../services/trivia.service';
import { IconComponent } from '../icon/icon.component';

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
    category: ['', [Validators.required, Validators.maxLength(100)]],
    difficulty: ['medium' as Difficulty, Validators.required],
    type: ['multiple' as QuestionType, Validators.required],
    question: ['', [Validators.required, Validators.maxLength(500)]],
    correctAnswer: ['', [Validators.required, Validators.maxLength(200)]],
    // Not marked `required` here: for a boolean question these three fields
    // are irrelevant and hidden in the template. Validity for the "multiple"
    // case is checked by hand in onSubmit() instead of via array validators,
    // since the requirement is conditional on the `type` field above.
    incorrectAnswers: this.fb.nonNullable.array([
      this.fb.nonNullable.control(''),
      this.fb.nonNullable.control(''),
      this.fb.nonNullable.control(''),
    ]),
  });

  async ngOnInit(): Promise<void> {
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

    const raw = this.form.getRawValue();
    const isBoolean = raw.type === 'boolean';
    const incorrectAnswers = isBoolean
      ? [raw.correctAnswer.trim() === 'True' ? 'False' : 'True']
      : raw.incorrectAnswers.map((answer) => answer.trim());

    const isValid =
      this.form.get('category')!.valid &&
      this.form.get('question')!.valid &&
      this.form.get('correctAnswer')!.valid &&
      (isBoolean
        ? raw.correctAnswer === 'True' || raw.correctAnswer === 'False'
        : incorrectAnswers.every((answer) => answer.length > 0));

    if (!isValid) {
      this.form.markAllAsTouched();
      return;
    }

    const question: CustomQuestionDoc = {
      category: raw.category.trim(),
      type: raw.type,
      difficulty: raw.difficulty,
      question: raw.question.trim(),
      correct_answer: raw.correctAnswer.trim(),
      incorrect_answers: incorrectAnswers,
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
    } catch {
      this.submitError.set('Could not save your question. Please try again.');
    } finally {
      this.isSubmitting.set(false);
    }
  }

  protected addAnother(): void {
    this.hasSubmitted.set(false);
    this.submitError.set(null);
    this.form.reset({ difficulty: 'medium', type: 'multiple' });
  }

  protected backToGame(): void {
    this.router.navigateByUrl('/');
  }

  protected goToPricing(): void {
    this.router.navigateByUrl('/pricing');
  }
}
