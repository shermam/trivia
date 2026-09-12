import { AbstractControl, FormBuilder, ValidationErrors, Validators } from '@angular/forms';
import {
  CustomQuestionContent,
  CustomQuestionDoc,
  Difficulty,
  QuestionType,
} from '../../models/question.model';

/**
 * The one question form, shared by `/add-question` and by `/my-questions`'
 * edit dialog (`FEAT-007`).
 *
 * **Extracted rather than copied**, and the reason is what the form already
 * knows: the validators mirror `firestore.rules`' bounds field by field, and
 * the label table below is what makes an invalid submit name the offending
 * field and move focus to it. A second copy would be a second set of bounds to
 * keep in step with the rules, and the way it would fail is the way it failed
 * once already — a control missing from the table blocked the submit while
 * naming nothing and focusing nothing (finding B4's symptom by another route).
 */

/**
 * Optional, but `https://` when present — the same rule `firestore.rules`
 * enforces, checked here so the contributor gets a field error instead of a
 * `permission-denied` they cannot act on.
 *
 * Deliberately not a full URL regex. The rule this mirrors is a prefix check,
 * and a client validator stricter than the server's would refuse writes the
 * backend would have accepted. An empty or whitespace-only value passes: the
 * field is optional, and the submit drops it rather than writing one.
 */
export function httpsUrl(control: AbstractControl): ValidationErrors | null {
  const value = typeof control.value === 'string' ? control.value.trim() : '';
  if (value.length === 0) {
    return null;
  }
  return value.startsWith('https://') && value.length > 'https://'.length
    ? null
    : { httpsUrl: true };
}

/**
 * `Validators.required` accepts `"   "`, and `firestore.rules` does not: it
 * checks `size() > 0` on the *trimmed* value this form sends. Without a
 * trim-aware check the form would happily submit whitespace and the write
 * would come back as a bare `permission-denied` — a rejection the user cannot
 * act on, for a rule the client already knows about.
 */
export function nonBlank(control: AbstractControl): ValidationErrors | null {
  return typeof control.value === 'string' && control.value.trim().length === 0
    ? { required: true }
    : null;
}

export type QuestionForm = ReturnType<typeof createQuestionForm>;

/**
 * Every bound here mirrors one in `isValidQuestionShape()`. If the two drift,
 * the form accepts something the write is refused for, and the contributor sees
 * a `permission-denied` naming no field.
 */
export function createQuestionForm(fb: FormBuilder) {
  return fb.nonNullable.group({
    category: ['', [Validators.required, nonBlank, Validators.maxLength(100)]],
    difficulty: ['medium' as Difficulty, Validators.required],
    type: ['multiple' as QuestionType, Validators.required],
    question: ['', [Validators.required, nonBlank, Validators.maxLength(500)]],
    correctAnswer: ['', [Validators.required, nonBlank, Validators.maxLength(200)]],
    // Optional on purpose. Requiring a citation would push contributors toward
    // pasting *something*, and a bad citation is worse than none because it
    // looks checked. `https` only, matching `firestore.rules` — the CSP would
    // not load an `http` page, so the rule refuses what the reader could not
    // open anyway, and catching it here turns a bare `permission-denied` into
    // a field error the contributor can act on.
    sourceUrl: ['', [httpsUrl, Validators.maxLength(500)]],
    // No `nonBlank` here, unlike every required field above: `nonBlank`
    // rejects the empty string too, which is exactly right for a control that
    // must be filled in and exactly wrong for one that may be left alone — it
    // made the whole form invalid for every contributor who did not cite a
    // source, i.e. almost all of them, and the symptom was a submit button
    // that silently did nothing. Whitespace-only needs no validator of its
    // own: it trims to '' and is omitted from the write.
    sourceTitle: ['', [Validators.maxLength(200)]],
    // The "Justification" box, for a question whose answer is not obvious even
    // to somebody who knows the subject. Optional for the same reason the two
    // above are, and bounded at 1000 to match `firestore.rules` — twice the
    // question's own cap, because it has to explain the question, the right
    // answer and the wrong ones.
    explanation: ['', [Validators.maxLength(1000)]],
    // Required only for a "multiple" question — for a boolean one these three
    // are irrelevant and hidden, and the opposite value is derived instead.
    // The validators are therefore applied and cleared as `type` changes
    // rather than checked by hand at submit time: that keeps `form.invalid` the
    // single source of truth, which is what lets the template render per-field
    // errors and the submit handler focus the first offending control.
    incorrectAnswers: fb.nonNullable.array([
      fb.nonNullable.control(''),
      fb.nonNullable.control(''),
      fb.nonNullable.control(''),
    ]),
  });
}

export function applyIncorrectAnswerValidators(form: QuestionForm, type: QuestionType): void {
  for (const control of form.controls.incorrectAnswers.controls) {
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

export interface QuestionField {
  control: AbstractControl;
  /** The DOM id, already carrying the host's prefix. */
  id: string;
  label: string;
}

/**
 * Field labels in form order, for the validation summary and the focus target.
 *
 * Optional fields belong here too. This table is not "the required fields" — it
 * is what {@link describeInvalidFields} and {@link focusFirstInvalidControl}
 * can *see*, and a control missing from it is invisible to both.
 */
export function questionFields(form: QuestionForm, idPrefix = ''): QuestionField[] {
  return [
    { control: form.controls.category, id: `${idPrefix}category`, label: 'Category' },
    { control: form.controls.question, id: `${idPrefix}question`, label: 'Question' },
    {
      control: form.controls.correctAnswer,
      id: `${idPrefix}correctAnswer`,
      label: 'Correct answer',
    },
    ...form.controls.incorrectAnswers.controls.map((control, index) => ({
      control,
      id: `${idPrefix}incorrect-answer-${index}`,
      label: `Incorrect answer ${index + 1}`,
    })),
    { control: form.controls.sourceUrl, id: `${idPrefix}sourceUrl`, label: 'Source link' },
    { control: form.controls.sourceTitle, id: `${idPrefix}sourceTitle`, label: 'Source name' },
    { control: form.controls.explanation, id: `${idPrefix}explanation`, label: 'Justification' },
  ];
}

export function describeInvalidFields(fields: QuestionField[]): string {
  const invalid = fields.filter((field) => field.control.invalid);
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
 * Puts the cursor on the first thing that's wrong. Without it, a long form can
 * report an error that is scrolled off screen — the same "nothing happened"
 * experience in a different costume.
 */
export function focusFirstInvalidControl(fields: QuestionField[]): void {
  const first = fields.find((field) => field.control.invalid);
  if (first) {
    document.getElementById(first.id)?.focus();
  }
}

/** Whether to show a field's error — only once the user has engaged with it. */
export function showsFieldError(control: AbstractControl): boolean {
  return control.invalid && (control.touched || control.dirty);
}

export function fieldErrorFor(control: AbstractControl, label: string, maxLength: number): string {
  if (control.hasError('required')) {
    return `${label} is required.`;
  }
  if (control.hasError('maxlength')) {
    return `${label} must be ${maxLength} characters or fewer.`;
  }
  if (control.hasError('httpsUrl')) {
    return `${label} has to be a full address starting with https://.`;
  }
  return '';
}

/**
 * The repeated answer, if any, comparing trimmed text case-insensitively.
 *
 * `firestore.rules` rejects a question whose correct answer also appears among
 * the incorrect ones (finding B1), so without a check here the submitter's only
 * feedback would be a raw `permission-denied` that names nothing. Returns the
 * offending text rather than a boolean so the message can name it — "one of
 * your answers is duplicated" leaves the submitter hunting through four fields.
 *
 * Case-insensitive on trimmed text: "Paris" and "paris " are the same answer to
 * a player, and a question offering both is broken whatever the rules make of
 * it.
 */
export function findDuplicateAnswer(
  correctAnswer: string,
  incorrectAnswers: string[],
): string | null {
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

export function duplicateAnswerMessage(duplicate: string): string {
  return (
    `"${duplicate}" is listed more than once. Every answer has to be different, ` +
    `or the question would have two right answers.`
  );
}

/**
 * The form's values as `custom_questions` stores them.
 *
 * A boolean question's incorrect answer is *derived* — the opposite literal —
 * rather than typed, which is the one thing the three incorrect-answer controls
 * do not cover. Optional fields are omitted entirely when blank rather than
 * written as an empty string: `firestore.rules` refuses an empty `sourceTitle`
 * or `explanation`, and an absent key is the honest representation of "not
 * given".
 */
export function toQuestionContent(raw: ReturnType<QuestionForm['getRawValue']>): {
  content?: CustomQuestionContent;
  duplicate?: string;
  invalidBoolean?: true;
} {
  const isBoolean = raw.type === 'boolean';
  if (isBoolean && raw.correctAnswer !== 'True' && raw.correctAnswer !== 'False') {
    return { invalidBoolean: true };
  }

  const correctAnswer = raw.correctAnswer.trim();
  const incorrectAnswers = isBoolean
    ? [correctAnswer === 'True' ? 'False' : 'True']
    : raw.incorrectAnswers.map((answer) => answer.trim());

  const duplicate = findDuplicateAnswer(correctAnswer, incorrectAnswers);
  if (duplicate) {
    return { duplicate };
  }

  const sourceUrl = raw.sourceUrl.trim();
  const sourceTitle = raw.sourceTitle.trim();
  const explanation = raw.explanation.trim();

  return {
    content: {
      category: raw.category.trim(),
      type: raw.type,
      difficulty: raw.difficulty,
      question: raw.question.trim(),
      correct_answer: correctAnswer,
      incorrect_answers: incorrectAnswers,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(sourceTitle ? { sourceTitle } : {}),
      ...(explanation ? { explanation } : {}),
    },
  };
}

/**
 * Fills the form from a stored question, for the edit dialog.
 *
 * The three incorrect-answer controls are filled positionally and padded with
 * empty strings, because the stored list holds one entry for a boolean question
 * and up to three for a multiple-choice one. Padding rather than resizing keeps
 * the control array a fixed shape, which is what the label table and the
 * template's `@for` both assume.
 */
export function patchQuestionForm(form: QuestionForm, question: CustomQuestionDoc): void {
  const incorrect = question.type === 'boolean' ? [] : question.incorrect_answers;
  form.reset({
    category: question.category,
    difficulty: question.difficulty,
    type: question.type,
    question: question.question,
    correctAnswer: question.correct_answer,
    sourceUrl: question.sourceUrl ?? '',
    sourceTitle: question.sourceTitle ?? '',
    explanation: question.explanation ?? '',
    incorrectAnswers: [0, 1, 2].map((index) => incorrect[index] ?? ''),
  });
  applyIncorrectAnswerValidators(form, question.type);
}
