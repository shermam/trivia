import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { NewCustomQuestionDoc } from '../../models/question.model';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { FirebaseService } from '../../services/firebase.service';
import { SubscriptionService } from '../../services/subscription.service';
import { TriviaService } from '../../services/trivia.service';
import { AddQuestionComponent } from './add-question.component';

/**
 * The report behind this spec: a Pro test account could not add a question,
 * and nothing on screen said why. Three separate silent failures were in the
 * way, and each one gets its test here.
 *
 * Two of them are only visible in a *rendered* component — whether an error
 * message reaches the DOM, and where focus lands. The H4 review taught this
 * the hard way: an instance-level test sees a signal change and calls it a
 * day, while the user sees nothing move.
 */

const permissionDenied = () =>
  Object.assign(new Error('Missing or insufficient permissions.'), {
    code: 'permission-denied',
  });

type AddCustomQuestion = (question: NewCustomQuestionDoc) => Promise<void>;

function setup(
  options: {
    addCustomQuestion?: AddCustomQuestion;
    /** The `stripeRole` claim on the refreshed token — the rules' actual gate. */
    hasProClaim?: boolean;
  } = {},
) {
  const addCustomQuestion = vi.fn<AddCustomQuestion>(
    options.addCustomQuestion ?? (() => Promise.resolve()),
  );

  TestBed.configureTestingModule({
    providers: [
      {
        provide: FirebaseService,
        useValue: { addCustomQuestion },
      },
      {
        provide: AuthService,
        useValue: {
          user: signal({ uid: 'author-1', displayName: 'Ada' }),
          isAnonymous: signal(false),
          isFullyAuthenticated: signal(true),
          // Defaults to true: the interesting case is a *refused* write from
          // an account the client believes is Pro.
          isProUser: signal(options.hasProClaim ?? true),
          refreshIdToken: () => Promise.resolve(),
          resendVerificationEmail: () => Promise.resolve(),
        },
      },
      { provide: SubscriptionService, useValue: { isProUser: signal(true) } },
      { provide: AuthMenuStateService, useValue: { open: () => undefined } },
      { provide: TriviaService, useValue: { getCategories: () => Promise.resolve([]) } },
      { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
    ],
  });

  const fixture = TestBed.createComponent(AddQuestionComponent);
  const component = fixture.componentInstance as unknown as {
    form: {
      controls: {
        category: { setValue: (v: string) => void };
        question: { setValue: (v: string) => void };
        correctAnswer: { setValue: (v: string) => void };
        type: { setValue: (v: string) => void };
        incorrectAnswers: { controls: { setValue: (v: string) => void }[] };
      };
    };
    onSubmit: () => Promise<void>;
    validationSummary: () => string | null;
    submitError: () => string | null;
    hasSubmitted: () => boolean;
  };

  /** Fills every field a valid multiple-choice question needs. */
  const fillValidForm = () => {
    component.form.controls.category.setValue('Science');
    component.form.controls.question.setValue('What is the chemical symbol for water?');
    component.form.controls.correctAnswer.setValue('H2O');
    const [a, b, c] = component.form.controls.incorrectAnswers.controls;
    a.setValue('CO2');
    b.setValue('O2');
    c.setValue('NaCl');
  };

  return { fixture, component, addCustomQuestion, fillValidForm };
}

describe('AddQuestionComponent validation', () => {
  afterEach(() => TestBed.resetTestingModule());

  // The reported behaviour: Save appeared to do nothing at all.
  it('explains a missing category instead of silently refusing to submit', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.category.setValue('');

    await component.onSubmit();

    expect(addCustomQuestion).not.toHaveBeenCalled();
    expect(component.validationSummary()).toMatch(/Category/i);
  });

  it('names every offending field when several are empty', async () => {
    const { component } = setup();

    await component.onSubmit();

    expect(component.validationSummary()).toMatch(/fields need your attention/i);
    expect(component.validationSummary()).toMatch(/category/i);
    expect(component.validationSummary()).toMatch(/question/i);
  });

  // `Validators.required` accepts "   ", and the rules check the trimmed
  // value — so without `nonBlank` this submitted and came back as a bare
  // permission-denied.
  it('treats a whitespace-only field as empty, the way the rules do', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.category.setValue('   ');

    await component.onSubmit();

    expect(addCustomQuestion).not.toHaveBeenCalled();
    expect(component.validationSummary()).toMatch(/Category/i);
  });

  it('submits a valid multiple-choice question', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();

    await component.onSubmit();

    expect(addCustomQuestion).toHaveBeenCalledTimes(1);
    expect(component.validationSummary()).toBeNull();
    expect(component.hasSubmitted()).toBe(true);
  });

  // The three incorrect-answer fields are hidden for a boolean question and
  // their validators have to come off with them, or the form is permanently
  // invalid with nothing on screen to fix.
  it('submits a boolean question without the hidden incorrect-answer fields', async () => {
    const { component, addCustomQuestion } = setup();
    component.form.controls.category.setValue('Science');
    component.form.controls.question.setValue('Water boils at 100C at sea level.');
    component.form.controls.type.setValue('boolean');
    component.form.controls.correctAnswer.setValue('True');

    await component.onSubmit();

    expect(addCustomQuestion).toHaveBeenCalledTimes(1);
    expect(addCustomQuestion.mock.calls[0][0].incorrect_answers).toEqual(['False']);
  });

  it('re-applies the incorrect-answer requirement when switching back to multiple choice', async () => {
    const { component, addCustomQuestion } = setup();
    component.form.controls.category.setValue('Science');
    component.form.controls.question.setValue('Q?');
    component.form.controls.type.setValue('boolean');
    component.form.controls.correctAnswer.setValue('True');
    component.form.controls.type.setValue('multiple');

    await component.onSubmit();

    expect(addCustomQuestion).not.toHaveBeenCalled();
    expect(component.validationSummary()).toMatch(/incorrect answer/i);
  });
});

describe('AddQuestionComponent submit failures', () => {
  afterEach(() => TestBed.resetTestingModule());

  /**
   * The production symptom. The claim is what `firestore.rules` checks and
   * the token was force-refreshed a line earlier, so its absence is read,
   * not guessed — which is what makes naming this cause honest (contrast
   * B4, where a single message was invented for every rejection).
   */
  it('says Pro access is missing when the refreshed token carries no claim', async () => {
    const { component, fillValidForm } = setup({
      addCustomQuestion: () => Promise.reject(permissionDenied()),
      hasProClaim: false,
    });
    fillValidForm();

    await component.onSubmit();

    expect(component.submitError()).toMatch(/does not have Pro access/i);
    expect(component.hasSubmitted()).toBe(false);
  });

  // Claim present: the rejection is something else (a clock outside the
  // window, a bound the form doesn't know about), so don't invent a cause.
  it('stays generic for a permission denial that the claim cannot explain', async () => {
    const { component, fillValidForm } = setup({
      addCustomQuestion: () => Promise.reject(permissionDenied()),
      hasProClaim: true,
    });
    fillValidForm();

    await component.onSubmit();

    expect(component.submitError()).toBe('Could not save your question. Please try again.');
  });

  it('stays generic for a transport failure', async () => {
    const { component, fillValidForm } = setup({
      addCustomQuestion: () => Promise.reject(new Error('offline')),
      hasProClaim: false,
    });
    fillValidForm();

    await component.onSubmit();

    expect(component.submitError()).toBe('Could not save your question. Please try again.');
  });
});

/**
 * Rendered tests. A signal flipping is not the same as a user seeing
 * something change, and this bug was precisely the gap between the two.
 */
describe('AddQuestionComponent rendered feedback', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the error next to the field and links it for assistive tech', async () => {
    const { fixture, component, fillValidForm } = setup();
    fixture.detectChanges();
    fillValidForm();
    component.form.controls.category.setValue('');

    await component.onSubmit();
    fixture.detectChanges();

    const error: HTMLElement | null = fixture.nativeElement.querySelector('#category-error');
    expect(error?.textContent).toMatch(/Category is required/i);

    const input: HTMLElement | null = fixture.nativeElement.querySelector('#category');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.getAttribute('aria-describedby')).toBe('category-error');
  });

  it('moves focus to the first invalid field so the problem is unmissable', async () => {
    const { fixture, component, fillValidForm } = setup();
    fixture.detectChanges();
    fillValidForm();
    component.form.controls.category.setValue('');

    await component.onSubmit();
    fixture.detectChanges();

    expect(document.activeElement?.id).toBe('category');
  });

  // Control for the test above: focus is only claimed when something is
  // actually wrong, so a passing submit doesn't yank the cursor around.
  it('leaves focus alone when the form is valid', async () => {
    const { fixture, component, fillValidForm } = setup();
    fixture.detectChanges();
    fillValidForm();

    await component.onSubmit();
    fixture.detectChanges();

    expect(document.activeElement?.id).not.toBe('category');
  });
});
