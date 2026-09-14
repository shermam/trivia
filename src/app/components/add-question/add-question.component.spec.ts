import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { FirestoreRestError } from '../../services/firestore-rest/firestore-rest.client';
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
 * Topic tags (`FEAT-021`). What the *selector* does with a keystroke is
 * `tag-selector.component.spec.ts`' subject; what the **submit** writes is
 * this one's, because that is the boundary `firestore.rules` sees.
 */
describe('AddQuestionComponent topic tags', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('writes no key at all when no topic was chosen', async () => {
    const { component, addCustomQuestion, fillValidForm } = setup();
    fillValidForm();

    await component.onSubmit();

    // An empty array is accepted by the rules and says exactly what an absent
    // key says, so writing one would put a field on every untagged question to
    // report that it has none.
    expect('tags' in addCustomQuestion.mock.calls[0][0]).toBe(false);
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
