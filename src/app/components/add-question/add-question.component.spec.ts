import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { FirestoreRestError } from '../../services/firestore-rest/firestore-rest.client';
import { NewCustomQuestionDoc } from '../../models/question.model';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { FirebaseService } from '../../services/firebase.service';
import { SubscriptionService } from '../../services/subscription.service';
import {
  QuestionForm,
  addIncorrectAnswer,
  removeIncorrectAnswer,
} from '../question-form/question-form';
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

/**
 * The error a rules refusal actually produces now.
 *
 * It used to be `Object.assign(new Error(...), { code: 'permission-denied' })`,
 * mirroring the Firestore SDK. That shape no longer exists — `FirebaseService`
 * goes over REST and throws `FirestoreRestError` — and the old fake is the
 * reason this suite kept passing while the component underneath had stopped
 * recognising a refusal at all. Building the real error is what makes the test
 * a check on the contract rather than on a copy of it.
 */
const permissionDenied = () =>
  new FirestoreRestError('PERMISSION_DENIED', 403, 'Missing or insufficient permissions.');

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
      { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
    ],
  });

  const fixture = TestBed.createComponent(AddQuestionComponent);
  const component = fixture.componentInstance as unknown as {
    form: {
      controls: {
        question: { setValue: (v: string) => void };
        correctAnswer: { setValue: (v: string) => void };
        type: { setValue: (v: string) => void };
        sourceUrl: { setValue: (v: string) => void };
        sourceTitle: { setValue: (v: string) => void };
        explanation: { setValue: (v: string) => void };
        tags: { setValue: (v: string[]) => void };
        incorrectAnswers: { controls: { setValue: (v: string) => void }[] };
      };
    };
    onSubmit: () => Promise<void>;
    validationSummary: () => string | null;
    submitError: () => string | null;
    hasSubmitted: () => boolean;
  };

  /** Fills every field a valid multiple-choice question needs — a topic among them (`FEAT-052`). */
  const fillValidForm = () => {
    component.form.controls.tags.setValue(['chemistry']);
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

  // The reported behaviour: Save appeared to do nothing at all. Topics are the
  // first required field now (`FEAT-052`), and the rules refuse a create
  // without one — so forgetting them has to be said, not refused in silence.
  it('explains missing topics instead of silently refusing to submit', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.tags.setValue([]);

    await component.onSubmit();

    expect(addCustomQuestion).not.toHaveBeenCalled();
    expect(component.validationSummary()).toMatch(/Topics/i);
  });

  it('names every offending field when several are empty', async () => {
    const { component } = setup();

    await component.onSubmit();

    expect(component.validationSummary()).toMatch(/fields need your attention/i);
    expect(component.validationSummary()).toMatch(/topics/i);
    expect(component.validationSummary()).toMatch(/question/i);
  });

  // `Validators.required` accepts "   ", and the rules check the trimmed
  // value — so without `nonBlank` this submitted and came back as a bare
  // permission-denied.
  it('treats a whitespace-only field as empty, the way the rules do', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.question.setValue('   ');

    await component.onSubmit();

    expect(addCustomQuestion).not.toHaveBeenCalled();
    expect(component.validationSummary()).toMatch(/Question/i);
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
    component.form.controls.tags.setValue(['physics']);
    component.form.controls.question.setValue('Water boils at 100C at sea level.');
    component.form.controls.type.setValue('boolean');
    component.form.controls.correctAnswer.setValue('True');

    await component.onSubmit();

    expect(addCustomQuestion).toHaveBeenCalledTimes(1);
    expect(addCustomQuestion.mock.calls[0][0].incorrect_answers).toEqual(['False']);
  });

  it('re-applies the incorrect-answer requirement when switching back to multiple choice', async () => {
    const { component, addCustomQuestion } = setup();
    component.form.controls.tags.setValue(['physics']);
    component.form.controls.question.setValue('Q?');
    component.form.controls.type.setValue('boolean');
    component.form.controls.correctAnswer.setValue('True');
    component.form.controls.type.setValue('multiple');

    await component.onSubmit();

    expect(addCustomQuestion).not.toHaveBeenCalled();
    expect(component.validationSummary()).toMatch(/incorrect answer/i);
  });
});

/**
 * `FEAT-022`. Both source fields are optional, and the whole feature turns on
 * that staying true: the very first version of this made `sourceTitle` invalid
 * when empty, which left the form permanently invalid for every contributor
 * who did not cite anything — a Save button that silently did nothing, the
 * exact symptom finding B4 was about.
 */
describe('AddQuestionComponent source attribution', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('submits with no source at all, writing neither key', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();

    await component.onSubmit();

    expect(addCustomQuestion).toHaveBeenCalledTimes(1);
    const written = addCustomQuestion.mock.calls[0][0];
    // Absent, not empty: `firestore.rules` refuses an empty `sourceTitle`, and
    // a missing key is the honest encoding of "no citation given".
    expect('sourceUrl' in written).toBe(false);
    expect('sourceTitle' in written).toBe(false);
  });

  it('writes both fields when both are given, trimmed', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.sourceUrl.setValue('  https://example.org/h2o  ');
    component.form.controls.sourceTitle.setValue('  Example Journal  ');

    await component.onSubmit();

    expect(addCustomQuestion.mock.calls[0][0]).toMatchObject({
      sourceUrl: 'https://example.org/h2o',
      sourceTitle: 'Example Journal',
    });
  });

  it('accepts a title with no URL — a book has no href', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.sourceTitle.setValue('Feynman Lectures, Vol. II');

    await component.onSubmit();

    const written = addCustomQuestion.mock.calls[0][0];
    expect(written.sourceTitle).toBe('Feynman Lectures, Vol. II');
    expect('sourceUrl' in written).toBe(false);
  });

  it('accepts a URL with no title', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.sourceUrl.setValue('https://example.org/h2o');

    await component.onSubmit();

    const written = addCustomQuestion.mock.calls[0][0];
    expect(written.sourceUrl).toBe('https://example.org/h2o');
    expect('sourceTitle' in written).toBe(false);
  });

  /**
   * The mirror of the `sourceTitle` case below, and not a duplicate of it:
   * `sourceUrl` carries a *validator* as well, so whitespace here has two
   * ways to go wrong — a blocked submit if `httpsUrl` treated `"  "` as a
   * malformed address, or an empty string written for a rule that refuses
   * one. Neither happens; the key is simply absent.
   */
  it('drops a whitespace-only link without blocking the submit', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.sourceUrl.setValue('   ');

    await component.onSubmit();

    expect(addCustomQuestion).toHaveBeenCalledTimes(1);
    expect('sourceUrl' in addCustomQuestion.mock.calls[0][0]).toBe(false);
    expect(component.validationSummary()).toBeNull();
  });

  it('drops a whitespace-only title rather than writing one the rules refuse', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.sourceTitle.setValue('    ');

    await component.onSubmit();

    expect(addCustomQuestion).toHaveBeenCalledTimes(1);
    expect('sourceTitle' in addCustomQuestion.mock.calls[0][0]).toBe(false);
  });

  /**
   * Caught in the form rather than by Firestore on purpose: without this the
   * contributor's only feedback is a bare `permission-denied` mapped to a
   * generic "could not save", which names no field and offers no fix.
   */
  it.each([
    ['plain http', 'http://example.org/article'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a bare scheme', 'https://'],
    ['a bare hostname', 'example.org'],
  ])('refuses %s before it reaches the rules', async (_label, url) => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.sourceUrl.setValue(url);

    await component.onSubmit();

    expect(addCustomQuestion).not.toHaveBeenCalled();
    expect(component.validationSummary()).toMatch(/source/i);
  });

  it('refuses a URL past the length the rules cap', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.sourceUrl.setValue(`https://example.org/${'a'.repeat(500)}`);

    await component.onSubmit();

    expect(addCustomQuestion).not.toHaveBeenCalled();
  });

  it('refuses a title past the length the rules cap', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.sourceTitle.setValue('t'.repeat(201));

    await component.onSubmit();

    expect(addCustomQuestion).not.toHaveBeenCalled();
  });
});

/**
 * The Justification box (`explanation`). Optional like the source fields, and
 * for the same reason: a contributor who thinks it is required will write
 * something, and reasoning invented to fill a box is worse than none.
 */
describe('AddQuestionComponent justification', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('writes no key at all when the box is left alone', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();

    await component.onSubmit();

    expect(addCustomQuestion).toHaveBeenCalledTimes(1);
    expect('explanation' in addCustomQuestion.mock.calls[0][0]).toBe(false);
  });

  it('writes the justification, trimmed, when one is given', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.explanation.setValue('  Water is two hydrogens and an oxygen.  ');

    await component.onSubmit();

    expect(addCustomQuestion.mock.calls[0][0]).toMatchObject({
      explanation: 'Water is two hydrogens and an oxygen.',
    });
  });

  it('keeps the line breaks a multi-paragraph justification was written with', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.explanation.setValue('CO2 is carbon dioxide.\nO2 is oxygen gas.');

    await component.onSubmit();

    expect(addCustomQuestion.mock.calls[0][0].explanation).toBe(
      'CO2 is carbon dioxide.\nO2 is oxygen gas.',
    );
  });

  it('drops a whitespace-only justification rather than writing one the rules refuse', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.explanation.setValue('   \n  ');

    await component.onSubmit();

    expect(addCustomQuestion).toHaveBeenCalledTimes(1);
    expect('explanation' in addCustomQuestion.mock.calls[0][0]).toBe(false);
  });

  it('accepts a justification exactly at the 1000-character cap the rules set', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.explanation.setValue('j'.repeat(1000));

    await component.onSubmit();

    expect(addCustomQuestion).toHaveBeenCalledTimes(1);
  });

  it('refuses a justification past that cap, before it reaches the rules', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.explanation.setValue('j'.repeat(1001));

    await component.onSubmit();

    expect(addCustomQuestion).not.toHaveBeenCalled();
    expect(component.validationSummary()).toMatch(/justification/i);
  });
});

/**
 * Topic tags (`FEAT-021`, `FEAT-052`). What the *selector* does with a
 * keystroke is `tag-selector.component.spec.ts`' subject; what the **submit**
 * writes is this one's, because that is the boundary `firestore.rules` sees.
 */
describe('AddQuestionComponent topic tags', () => {
  afterEach(() => TestBed.resetTestingModule());

  /**
   * The rules refuse a create with no tags, because a question the topic
   * picker can never reach is one nobody asking for a topic is served. The
   * form refuses first, so the contributor is told rather than refused.
   */
  it('does not submit without a topic', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.tags.setValue([]);

    await component.onSubmit();

    expect(addCustomQuestion).not.toHaveBeenCalled();
  });

  /** Topics replaced the category; a new question carries no category at all. */
  it('writes no category', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();

    await component.onSubmit();

    expect('category' in addCustomQuestion.mock.calls[0][0]).toBe(false);
  });

  it('writes the chosen topics', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.tags.setValue(['chemistry', 'periodic-table']);

    await component.onSubmit();

    expect(addCustomQuestion.mock.calls[0][0]).toMatchObject({
      tags: ['chemistry', 'periodic-table'],
    });
  });

  /**
   * Normalised again on the way out even though the selector already did it.
   * The control is a plain `string[]` that anything could have written, and a
   * value the rules refuse comes back as a bare `permission-denied` naming no
   * field — so the cheap re-run is what keeps "what the form submits is
   * normalised" a property of the submit rather than of every writer.
   */
  it('normalises and de-duplicates whatever is in the control', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.tags.setValue(['World War 2', 'world_war_2', '!!', 'Treaties']);

    await component.onSubmit();

    expect(addCustomQuestion.mock.calls[0][0].tags).toEqual(['world-war-2', 'treaties']);
  });

  it('never writes more than the eight tags the rules accept', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.tags.setValue(Array.from({ length: 12 }, (_, i) => `topic-${i}`));

    await component.onSubmit();

    expect(addCustomQuestion.mock.calls[0][0].tags).toHaveLength(8);
  });
});

/**
 * `FEAT-051`: the wrong answers are rows a contributor adds and removes, from
 * one to five — two to six options in all, what `firestore.rules` accepts —
 * and the statement may run to 2,000 characters.
 *
 * Rendered, because every promise here is about the page rather than the form
 * model: which buttons exist, where focus lands, what a screen reader hears.
 * Focus after a removal is the one worth the most care — the button that was
 * pressed lives in the row that has just gone, and focus asked to stay on a
 * removed element drops to `<body>` without a word (`CLAUDE.md` §4.5). jsdom
 * enforces that much, because a detached node genuinely cannot hold focus.
 */
describe('AddQuestionComponent answer rows (FEAT-051)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function rendered() {
    const harness = setup();
    harness.fixture.detectChanges();
    const host = harness.fixture.nativeElement as HTMLElement;
    const form = harness.component.form as unknown as QuestionForm;
    const rows = () =>
      Array.from(host.querySelectorAll<HTMLInputElement>('input[id^="incorrect-answer-"]'));
    const press = (selector: string) => {
      host.querySelector<HTMLButtonElement>(selector)!.click();
      harness.fixture.detectChanges();
    };
    const addButton = () => host.querySelector<HTMLButtonElement>('[data-cy="add-answer"]')!;
    const removeButtons = () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>('[data-cy^="remove-incorrect-answer-"]'));
    const status = () => host.querySelector('[data-cy="answer-rows-status"]')?.textContent?.trim();
    return { ...harness, host, form, rows, press, addButton, removeButtons, status };
  }

  it('starts on four options: the correct answer and three wrong-answer rows', () => {
    const { rows, addButton, removeButtons, host } = rendered();

    expect(rows().map((row) => row.id)).toEqual([
      'incorrect-answer-0',
      'incorrect-answer-1',
      'incorrect-answer-2',
    ]);
    expect(addButton().disabled).toBe(false);
    expect(removeButtons()).toHaveLength(3);
    // Each row is labelled, not merely hinted at by a placeholder that vanishes
    // on the first keystroke, and the rows are one named group.
    expect(host.querySelector('label[for="incorrect-answer-1"]')?.textContent?.trim()).toBe(
      'Incorrect answer 2',
    );
    const group = host.querySelector('[data-cy="incorrect-answers"]')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(host.querySelector(`#${group.getAttribute('aria-labelledby')}`)?.textContent).toContain(
      'Incorrect Answers',
    );
  });

  it('adds rows up to six options and no further', () => {
    const { rows, press, addButton, form } = rendered();

    press('[data-cy="add-answer"]');
    press('[data-cy="add-answer"]');

    expect(rows()).toHaveLength(5);
    expect(addButton().disabled).toBe(true);
    // The ceiling is the form's, not only the button's.
    expect(addIncorrectAnswer(form)).toBeNull();
    expect(form.controls.incorrectAnswers.length).toBe(5);
  });

  it('puts the cursor in the row it adds, and says how many answers there are', () => {
    const { press, status } = rendered();

    press('[data-cy="add-answer"]');

    expect(document.activeElement?.id).toBe('incorrect-answer-3');
    expect(status()).toBe('Incorrect answer 4 added. The question now has 5 answers.');

    press('[data-cy="add-answer"]');
    expect(status()).toBe(
      'Incorrect answer 5 added. The question now has 6 answers. That is the most a question can have.',
    );
  });

  it('removes rows down to two options and no further', () => {
    const { rows, press, removeButtons, form } = rendered();

    press('[data-cy="remove-incorrect-answer-2"]');
    press('[data-cy="remove-incorrect-answer-1"]');

    expect(rows()).toHaveLength(1);
    expect(removeButtons()).toHaveLength(0);
    expect(removeIncorrectAnswer(form, 0)).toBe(false);
    expect(form.controls.incorrectAnswers.length).toBe(1);
  });

  it('keeps every answer with its own row when a middle one goes', () => {
    const { rows, press, form, fillValidForm } = rendered();
    fillValidForm(); // CO2, O2, NaCl
    press('[data-cy="add-answer"]');
    form.controls.incorrectAnswers.at(3).setValue('Fe');

    press('[data-cy="remove-incorrect-answer-1"]');

    expect(form.controls.incorrectAnswers.getRawValue()).toEqual(['CO2', 'NaCl', 'Fe']);
    expect(rows().map((row) => row.value)).toEqual(['CO2', 'NaCl', 'Fe']);
    expect(rows().map((row) => row.getAttribute('placeholder'))).toEqual([
      'Incorrect answer 1',
      'Incorrect answer 2',
      'Incorrect answer 3',
    ]);
  });

  it('moves focus to the row that takes a removed row’s place', () => {
    const { press, fillValidForm, status } = rendered();
    fillValidForm();

    press('[data-cy="remove-incorrect-answer-0"]');

    const focused = document.activeElement as HTMLInputElement;
    expect(focused.id).toBe('incorrect-answer-0');
    expect(focused.value).toBe('O2');
    expect(status()).toBe('Incorrect answer 1 removed. The question now has 3 answers.');
  });

  it('moves focus to "Add an answer" when the last row goes, never to the body', () => {
    const { press, addButton, status } = rendered();

    press('[data-cy="remove-incorrect-answer-2"]');

    expect(document.activeElement).toBe(addButton());
    expect(document.activeElement).not.toBe(document.body);

    press('[data-cy="remove-incorrect-answer-1"]');
    expect(document.activeElement).toBe(addButton());
    expect(status()).toBe(
      'Incorrect answer 2 removed. The question now has 2 answers. That is the fewest a question can have.',
    );
  });

  it('names and focuses an added row left empty', async () => {
    const { component, press, fixture, fillValidForm, addCustomQuestion } = rendered();
    fillValidForm();
    press('[data-cy="add-answer"]');
    (document.activeElement as HTMLElement).blur();

    await component.onSubmit();
    fixture.detectChanges();

    expect(addCustomQuestion).not.toHaveBeenCalled();
    expect(component.validationSummary()).toBe(
      'Incorrect answer 4 needs your attention before this can be saved.',
    );
    expect(document.activeElement?.id).toBe('incorrect-answer-3');
    expect(fixture.nativeElement.querySelector('#incorrect-answer-error-3')?.textContent).toMatch(
      /Incorrect answer 4 is required/,
    );
  });

  it('submits six options as five wrong answers, in row order', async () => {
    const { component, press, form, fillValidForm, addCustomQuestion } = rendered();
    fillValidForm();
    press('[data-cy="add-answer"]');
    press('[data-cy="add-answer"]');
    form.controls.incorrectAnswers.at(3).setValue('Fe');
    form.controls.incorrectAnswers.at(4).setValue(' He ');

    await component.onSubmit();

    expect(addCustomQuestion.mock.calls[0][0].incorrect_answers).toEqual([
      'CO2',
      'O2',
      'NaCl',
      'Fe',
      'He',
    ]);
  });

  it('submits a two-option multiple-choice question', async () => {
    const { component, press, fillValidForm, addCustomQuestion } = rendered();
    fillValidForm();
    press('[data-cy="remove-incorrect-answer-2"]');
    press('[data-cy="remove-incorrect-answer-1"]');

    await component.onSubmit();

    expect(addCustomQuestion.mock.calls[0][0]).toMatchObject({
      type: 'multiple',
      incorrect_answers: ['CO2'],
    });
  });

  // The rules require exactly one wrong answer on a true/false question, and
  // the rows a contributor filled before switching are hidden, not deleted.
  it('writes exactly one wrong answer for true/false, whatever rows were left behind', async () => {
    const { component, press, form, fillValidForm, addCustomQuestion } = rendered();
    fillValidForm();
    press('[data-cy="add-answer"]');
    form.controls.incorrectAnswers.at(3).setValue('Fe');
    component.form.controls.type.setValue('boolean');
    component.form.controls.correctAnswer.setValue('True');

    await component.onSubmit();

    expect(addCustomQuestion.mock.calls[0][0].incorrect_answers).toEqual(['False']);
  });

  it('starts the next question on four options again after "Add another"', async () => {
    const { component, press, form, fillValidForm, rows, fixture } = rendered();
    fillValidForm();
    press('[data-cy="add-answer"]');
    form.controls.incorrectAnswers.at(3).setValue('Fe');
    await component.onSubmit();
    fixture.detectChanges();

    (component as unknown as { addAnother(): void }).addAnother();
    fixture.detectChanges();

    expect(rows().map((row) => row.value)).toEqual(['', '', '']);
    expect(form.controls.incorrectAnswers.length).toBe(3);
    // Required again, like the three it started with — not silently optional.
    expect(form.controls.incorrectAnswers.at(2).hasError('required')).toBe(true);
  });
});

/**
 * `FEAT-051`: a statement may run to 2,000 characters — `question` in
 * `firestore.rules` — and the counter under the field says how much of that is
 * used, from first paint.
 */
describe('AddQuestionComponent question length (FEAT-051)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('accepts a 2,000-character question', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();
    component.form.controls.question.setValue('q'.repeat(2000));

    await component.onSubmit();

    expect(addCustomQuestion.mock.calls[0][0].question).toHaveLength(2000);
  });

  it('refuses 2,001 characters before the rules do, naming the limit', async () => {
    const { component, addCustomQuestion, fillValidForm, fixture } = setup();
    fixture.detectChanges();
    fillValidForm();
    component.form.controls.question.setValue('q'.repeat(2001));

    await component.onSubmit();
    fixture.detectChanges();

    expect(addCustomQuestion).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('#question-error')?.textContent).toMatch(
      /Question must be 2000 characters or fewer/,
    );
    expect(document.activeElement?.id).toBe('question');
  });

  it('counts the characters used against the limit, and describes the field with it', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    const counter = () =>
      fixture.nativeElement.querySelector('[data-cy="question-count"]')?.textContent?.trim();
    const field: HTMLElement = fixture.nativeElement.querySelector('#question');

    expect(counter()).toBe('0 of 2000 characters');
    expect(field.getAttribute('aria-describedby')).toBe('question-count');

    // Typed into the real element rather than set on the control: the input
    // event is what a person produces, and what the counter has to follow.
    (field as HTMLTextAreaElement).value = 'Which planet?';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(counter()).toBe('13 of 2000 characters');
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
    component.form.controls.question.setValue('');

    await component.onSubmit();
    fixture.detectChanges();

    const error: HTMLElement | null = fixture.nativeElement.querySelector('#question-error');
    expect(error?.textContent).toMatch(/Question is required/i);

    const input: HTMLElement | null = fixture.nativeElement.querySelector('#question');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    // The error first, then the character counter the field always carries
    // (`FEAT-051`): the error is the part a screen-reader user needs.
    expect(input?.getAttribute('aria-describedby')).toBe('question-error question-count');
  });

  /**
   * The topic picker is a component of its own, and the same contract has to
   * reach through it: the error under the input, `aria-invalid` on it, and the
   * error first in its description.
   */
  it('renders the missing-topic error through the picker, linked for assistive tech', async () => {
    const { fixture, component, fillValidForm } = setup();
    fixture.detectChanges();
    fillValidForm();
    component.form.controls.tags.setValue([]);

    await component.onSubmit();
    fixture.detectChanges();

    const error: HTMLElement | null = fixture.nativeElement.querySelector('#tag-error');
    expect(error?.textContent).toMatch(/Add at least one topic/);

    const input: HTMLElement | null = fixture.nativeElement.querySelector('#tag-input');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.getAttribute('aria-required')).toBe('true');
    expect(input?.getAttribute('aria-describedby')).toBe('tag-error tag-feedback');
  });

  /**
   * The regression this pins: `fieldLabels` is what the summary and the focus
   * move are built from, and the two source controls were not in it. A bad
   * link therefore blocked the submit while naming nothing and focusing
   * nothing — the same "Save does nothing" experience the whole error-handling
   * path in this component exists to prevent.
   */
  /**
   * WCAG 1.3.5's neighbour: guidance that only sits next to a control is
   * guidance a screen-reader user never hears, because the control announces
   * its label and its *description*. Both hinted fields carry their hint id
   * from first paint, not only once something is wrong.
   */
  it('describes the hinted controls by their help text before anything is wrong', () => {
    const { fixture } = setup();
    fixture.detectChanges();

    const url: HTMLElement | null = fixture.nativeElement.querySelector('#sourceUrl');
    expect(url?.getAttribute('aria-describedby')).toBe('sourceUrl-hint');
    expect(fixture.nativeElement.querySelector('#sourceUrl-hint')?.textContent).toMatch(
      /where the answer comes from/i,
    );

    const justification: HTMLElement | null = fixture.nativeElement.querySelector('#explanation');
    expect(justification?.getAttribute('aria-describedby')).toBe('explanation-hint');
    expect(fixture.nativeElement.querySelector('#explanation-hint')?.textContent).toMatch(
      /tricky question/i,
    );
  });

  it('names and focuses a malformed source link, rather than failing silently', async () => {
    const { fixture, component, fillValidForm } = setup();
    fixture.detectChanges();
    fillValidForm();
    component.form.controls.sourceUrl.setValue('example.org');

    await component.onSubmit();
    fixture.detectChanges();

    expect(component.validationSummary()).toMatch(/source link/i);
    expect(document.activeElement?.id).toBe('sourceUrl');

    const error: HTMLElement | null = fixture.nativeElement.querySelector('#sourceUrl-error');
    expect(error?.textContent).toMatch(/https:\/\//);
    const input: HTMLElement | null = fixture.nativeElement.querySelector('#sourceUrl');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    // The error **and** the standing hint, error first: the description a
    // screen reader reads out is the whole list, and the hint has to stay in
    // it or the guidance disappears at the moment it is most needed.
    expect(input?.getAttribute('aria-describedby')).toBe('sourceUrl-error sourceUrl-hint');
  });

  /**
   * Same regression as the source controls, one field along: a control missing
   * from `fieldLabels` is invisible to both the summary and the focus move, so
   * an over-long justification would block the submit while naming nothing.
   * The box is the last control on the form and the easiest to have scrolled
   * past, which is exactly when "nothing happened" is least diagnosable.
   */
  it('names and focuses an over-long justification', async () => {
    const { fixture, component, fillValidForm } = setup();
    fixture.detectChanges();
    fillValidForm();
    component.form.controls.explanation.setValue('j'.repeat(1001));

    await component.onSubmit();
    fixture.detectChanges();

    expect(component.validationSummary()).toMatch(/justification/i);
    expect(document.activeElement?.id).toBe('explanation');

    const error: HTMLElement | null = fixture.nativeElement.querySelector('#explanation-error');
    expect(error?.textContent).toMatch(/1000 characters or fewer/);
    const box: HTMLElement | null = fixture.nativeElement.querySelector('#explanation');
    expect(box?.tagName).toBe('TEXTAREA');
    expect(box?.getAttribute('aria-invalid')).toBe('true');
    expect(box?.getAttribute('aria-describedby')).toBe('explanation-error explanation-hint');
  });

  it('moves focus to the first invalid field so the problem is unmissable', async () => {
    const { fixture, component, fillValidForm } = setup();
    fixture.detectChanges();
    fillValidForm();
    component.form.controls.tags.setValue([]);

    await component.onSubmit();
    fixture.detectChanges();

    expect(document.activeElement?.id).toBe('tag-input');
  });

  // Control for the test above: focus is only claimed when something is
  // actually wrong, so a passing submit doesn't yank the cursor around.
  it('leaves focus alone when the form is valid', async () => {
    const { fixture, component, fillValidForm } = setup();
    fixture.detectChanges();
    fillValidForm();

    await component.onSubmit();
    fixture.detectChanges();

    expect(document.activeElement?.id).not.toBe('tag-input');
  });
});
