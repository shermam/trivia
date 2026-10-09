import {
  AbstractControl,
  FormBuilder,
  FormControl,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import {
  CustomQuestionContent,
  CustomQuestionDoc,
  Difficulty,
  QuestionFormat,
  QuestionType,
} from '../../models/question.model';
import { msg, type Message } from '../../i18n/message';
import { topicTagsOf } from '../../utils/category-tags';
import { normalizeTags } from '../../utils/normalize-tag.util';

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
 * The longest a question may be: `question` in `firestore.rules`. Long enough
 * for a public-exam statement with a paragraph of setup (`FEAT-051`).
 */
export const MAX_QUESTION_LENGTH = 2000;

/** The longest an answer may be — the correct one and every wrong one alike. */
export const MAX_ANSWER_LENGTH = 200;

/**
 * The fewest wrong-answer rows a multiple-choice question keeps: one, so it has
 * two options in all (`FEAT-051`). `firestore.rules` refuses an empty list.
 */
export const MIN_INCORRECT_ANSWERS = 1;

/**
 * The most: five, so six options in all — `maxIncorrectAnswers()` in
 * `firestore.rules`. The two numbers move together, which is the principle
 * finding B2 set: the rule accepts exactly what the form can produce.
 */
export const MAX_INCORRECT_ANSWERS = 5;

/** What a new question starts on: three wrong answers, four options — the usual shape. */
export const DEFAULT_INCORRECT_ANSWERS = 3;

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
    // The question's topics (`FEAT-021`), and since `FEAT-052` its only topic:
    // the category field went, and a create must carry at least one tag.
    //
    // **Required, mirroring the rule.** `firestore.rules` refuses a new
    // question with no tags, so without this the contributor's only feedback
    // would be a `permission-denied` naming nothing. `Validators.required`
    // reads an empty array as empty, which is exactly the case.
    //
    // **No validator on the tags themselves**, and that is not an oversight:
    // the selector cannot put an invalid tag in here — every route in goes
    // through `normalizeTag`, which returns the stored shape or nothing — and
    // it stops at `MAX_TAGS_PER_QUESTION`. A validator would be an unreachable
    // branch, like `format`'s. What makes that safe is the same thing:
    // `firestore.rules` checks the whole list anyway, which is where a check
    // belongs for a value the server has to be sure of.
    tags: fb.nonNullable.control<string[]>([], Validators.required),
    difficulty: ['medium' as Difficulty, Validators.required],
    type: ['multiple' as QuestionType, Validators.required],
    question: ['', [Validators.required, nonBlank, Validators.maxLength(MAX_QUESTION_LENGTH)]],
    // How the text above, the answers and the justification are meant to be
    // read (`FEAT-019`). Defaults to plain, so nothing about the existing flow
    // changes for a contributor who does not want Markdown — and so the field
    // is written only by somebody who asked for it.
    //
    // No validator: the control holds one of two literals and the template
    // offers no third, so a validator would be an unreachable branch. What
    // makes that safe is that `firestore.rules` checks it anyway, which is
    // where the check belongs for a value the server has to be sure of.
    format: ['plain' as QuestionFormat],
    correctAnswer: ['', [Validators.required, nonBlank, Validators.maxLength(MAX_ANSWER_LENGTH)]],
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
    // above are, and bounded at 1000 to match `firestore.rules`: it says why
    // the right answer is right and the wrong ones wrong, and a longer
    // statement does not lengthen that — so it stays at 1000 while the
    // question itself may run to 2000 (`FEAT-051`).
    explanation: ['', [Validators.maxLength(1000)]],
    // The wrong answers, one row each (`FEAT-051`): three to start with — four
    // options, the usual shape — and anywhere from one to five as the
    // contributor adds and removes rows, so a question has two to six options
    // in all. The rows are built and torn down by `addIncorrectAnswer`,
    // `removeIncorrectAnswer` and `patchQuestionForm` below, never by a
    // caller reaching into the array, so the bounds live in one place.
    //
    // Required only for a "multiple" question — for a boolean one the rows are
    // irrelevant and hidden, and the opposite value is derived instead. The
    // validators are therefore applied and cleared as `type` changes rather
    // than checked by hand at submit time: that keeps `form.invalid` the single
    // source of truth, which is what lets the template render per-field errors
    // and the submit handler focus the first offending control.
    incorrectAnswers: fb.nonNullable.array(
      Array.from({ length: DEFAULT_INCORRECT_ANSWERS }, () => fb.nonNullable.control('')),
    ),
  });
}

export function applyIncorrectAnswerValidators(form: QuestionForm, type: QuestionType): void {
  for (const control of form.controls.incorrectAnswers.controls) {
    if (type === 'multiple') {
      control.setValidators([
        Validators.required,
        nonBlank,
        Validators.maxLength(MAX_ANSWER_LENGTH),
      ]);
    } else {
      control.clearValidators();
    }
    // `emitEvent: false` — this runs inside a `valueChanges` subscription on
    // the same form, and re-emitting from here would re-enter it.
    control.updateValueAndValidity({ emitEvent: false });
  }
}

/** How many options the form's question has: the correct answer and every wrong-answer row. */
export function optionCount(form: QuestionForm): number {
  return form.controls.incorrectAnswers.length + 1;
}

/** Whether another wrong-answer row fits under the ceiling the rules set. */
export function canAddIncorrectAnswer(form: QuestionForm): boolean {
  return form.controls.incorrectAnswers.length < MAX_INCORRECT_ANSWERS;
}

/** Whether a row can go without leaving the question with a single option. */
export function canRemoveIncorrectAnswer(form: QuestionForm): boolean {
  return form.controls.incorrectAnswers.length > MIN_INCORRECT_ANSWERS;
}

/**
 * Appends an empty wrong-answer row, and returns its index — or `null` when the
 * question already has the six options the rules allow.
 *
 * The row takes the validators the current type calls for, so a row added to a
 * multiple-choice question is as required as the ones that were already there.
 */
export function addIncorrectAnswer(form: QuestionForm): number | null {
  if (!canAddIncorrectAnswer(form)) {
    return null;
  }
  form.controls.incorrectAnswers.push(new FormControl('', { nonNullable: true }));
  applyIncorrectAnswerValidators(form, form.controls.type.value);
  return form.controls.incorrectAnswers.length - 1;
}

/**
 * Removes one wrong-answer row, and reports whether it did — never below the one
 * row that keeps a question at two options.
 */
export function removeIncorrectAnswer(form: QuestionForm, index: number): boolean {
  const rows = form.controls.incorrectAnswers;
  if (!canRemoveIncorrectAnswer(form) || index < 0 || index >= rows.length) {
    return false;
  }
  rows.removeAt(index);
  return true;
}

/**
 * Replaces every wrong-answer row with one per value, validators included.
 *
 * Rebuilt rather than reset in place: `FormArray.reset()` keeps however many
 * controls the array already has, and the whole point of the rows is that the
 * count changes.
 */
function setIncorrectAnswerRows(form: QuestionForm, values: readonly string[]): void {
  const rows = form.controls.incorrectAnswers;
  rows.clear({ emitEvent: false });
  for (const value of values) {
    rows.push(new FormControl(value, { nonNullable: true }), { emitEvent: false });
  }
  applyIncorrectAnswerValidators(form, form.controls.type.value);
}

/**
 * Puts the form back to a new question's shape, for "Add another": the
 * defaults, and three empty wrong-answer rows however many the last question
 * had.
 */
export function resetQuestionForm(form: QuestionForm): void {
  form.reset({ difficulty: 'medium', type: 'multiple' });
  setIncorrectAnswerRows(
    form,
    Array.from({ length: DEFAULT_INCORRECT_ANSWERS }, () => ''),
  );
}

export interface QuestionField {
  control: AbstractControl;
  /** The DOM id, already carrying the host's prefix. */
  id: string;
  /** The field's name inside a list of fields — "source link". */
  name: Message;
  /** The summary when it is the only field in the wrong — a sentence of its own, not a name in a frame. */
  attention: Message;
}

/**
 * What one field's errors say. A sentence per field and error rather than
 * `${label} is required.`, because the field's name is the sentence's subject
 * and decides its grammar in a language with gender; a field carries only the
 * errors its validators can raise.
 */
export interface FieldMessages {
  readonly required?: Message;
  readonly tooLong?: (max: number) => Message;
  readonly https?: Message;
}

/** The contribute form's field errors, by field. */
export const FIELD_MESSAGES = {
  question: {
    required: msg('form.questionRequired', 'Question is required.'),
    tooLong: (max: number) =>
      msg('form.questionTooLong', 'Question must be {max} characters or fewer.', { max }),
  },
  correctAnswer: {
    required: msg('form.correctRequired', 'Correct answer is required.'),
    tooLong: (max: number) =>
      msg('form.correctTooLong', 'Correct answer must be {max} characters or fewer.', { max }),
  },
  sourceUrl: {
    https: msg(
      'form.sourceUrlHttps',
      'Source link has to be a full address starting with https://.',
    ),
    tooLong: (max: number) =>
      msg('form.sourceUrlTooLong', 'Source link must be {max} characters or fewer.', { max }),
  },
  sourceTitle: {
    tooLong: (max: number) =>
      msg('form.sourceTitleTooLong', 'Source name must be {max} characters or fewer.', { max }),
  },
  explanation: {
    tooLong: (max: number) =>
      msg('form.explanationTooLong', 'Justification must be {max} characters or fewer.', { max }),
  },
} satisfies Record<string, FieldMessages>;

/** The errors of wrong-answer row `n`, counted from one. */
export function incorrectAnswerMessages(n: number): FieldMessages {
  return {
    required: msg('form.incorrectRequired', 'Incorrect answer {n} is required.', { n }),
    tooLong: (max: number) =>
      msg('form.incorrectTooLong', 'Incorrect answer {n} must be {max} characters or fewer.', {
        n,
        max,
      }),
  };
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
    // The picker's text box, which is where a contributor adds a topic — and
    // first, because the picker is the first field on the form.
    {
      control: form.controls.tags,
      id: `${idPrefix}tag-input`,
      name: msg('form.nameTopics', 'topics'),
      attention: msg('form.attnTopics', 'Topics needs your attention before this can be saved.'),
    },
    {
      control: form.controls.question,
      id: `${idPrefix}question`,
      name: msg('form.nameQuestion', 'question'),
      attention: msg(
        'form.attnQuestion',
        'Question needs your attention before this can be saved.',
      ),
    },
    {
      control: form.controls.correctAnswer,
      id: `${idPrefix}correctAnswer`,
      name: msg('form.nameCorrect', 'correct answer'),
      attention: msg(
        'form.attnCorrect',
        'Correct answer needs your attention before this can be saved.',
      ),
    },
    ...form.controls.incorrectAnswers.controls.map((control, index) => ({
      control,
      id: `${idPrefix}incorrect-answer-${index}`,
      name: msg('form.nameIncorrect', 'incorrect answer {n}', { n: index + 1 }),
      attention: msg(
        'form.attnIncorrect',
        'Incorrect answer {n} needs your attention before this can be saved.',
        { n: index + 1 },
      ),
    })),
    {
      control: form.controls.sourceUrl,
      id: `${idPrefix}sourceUrl`,
      name: msg('form.nameSourceUrl', 'source link'),
      attention: msg(
        'form.attnSourceUrl',
        'Source link needs your attention before this can be saved.',
      ),
    },
    {
      control: form.controls.sourceTitle,
      id: `${idPrefix}sourceTitle`,
      name: msg('form.nameSourceTitle', 'source name'),
      attention: msg(
        'form.attnSourceTitle',
        'Source name needs your attention before this can be saved.',
      ),
    },
    {
      control: form.controls.explanation,
      id: `${idPrefix}explanation`,
      name: msg('form.nameExplanation', 'justification'),
      attention: msg(
        'form.attnExplanation',
        'Justification needs your attention before this can be saved.',
      ),
    },
  ];
}

export function describeInvalidFields(fields: QuestionField[]): Message {
  const invalid = fields.filter((field) => field.control.invalid);
  if (invalid.length === 0) {
    return msg('form.checkForm', 'Please check the form and try again.');
  }
  if (invalid.length === 1) {
    return invalid[0].attention;
  }
  return msg('form.attnMany', '{count} fields need your attention: {fields}.', {
    count: invalid.length,
    fields: invalid.map((field) => field.name),
  });
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

export function fieldErrorFor(
  control: AbstractControl,
  messages: FieldMessages,
  maxLength: number,
): Message | null {
  if (control.hasError('required')) {
    return messages.required ?? null;
  }
  if (control.hasError('maxlength')) {
    return messages.tooLong?.(maxLength) ?? null;
  }
  if (control.hasError('httpsUrl')) {
    return messages.https ?? null;
  }
  return null;
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

/** A true/false question submitted with neither picked. */
export const TRUE_FALSE_REQUIRED = msg(
  'form.chooseTrueFalse',
  'Choose whether the statement is true or false.',
);

export function duplicateAnswerMessage(duplicate: string): Message {
  return msg(
    'form.duplicate',
    '"{answer}" is listed more than once. Every answer has to be different, or the question would have two right answers.',
    { answer: duplicate },
  );
}

/**
 * The form's values as `custom_questions` stores them.
 *
 * A boolean question's incorrect answer is *derived* — the opposite literal —
 * rather than typed, which is the one thing the wrong-answer rows do not cover:
 * however many rows a contributor left behind on switching to true/false, the
 * question is written with exactly the one wrong answer the rules require.
 * Optional fields are omitted entirely when blank rather than written as an
 * empty string: `firestore.rules` refuses an empty `sourceTitle` or
 * `explanation`, and an absent key is the honest representation of "not
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
    ? // i18n-exempt: the stored values a true/false question carries; the picker's labels are translated
      [correctAnswer === 'True' ? 'False' : 'True']
    : raw.incorrectAnswers.map((answer) => answer.trim());

  const duplicate = findDuplicateAnswer(correctAnswer, incorrectAnswers);
  if (duplicate) {
    return { duplicate };
  }

  const sourceUrl = raw.sourceUrl.trim();
  const sourceTitle = raw.sourceTitle.trim();
  const explanation = raw.explanation.trim();
  // Normalised again on the way out, even though the selector already did it.
  // The control is a plain `string[]` that anything could have written — a
  // `patchValue` from a stored document, a future caller — and the cheap
  // re-run is what keeps "what the form submits is normalised" a property of
  // the submit rather than of every writer remembering.
  const tags = normalizeTags(raw.tags);

  return {
    // No `category`: the topics are the question's topic now (`FEAT-052`), and
    // an owner edit's write deletes the key from a document that still holds one.
    content: {
      type: raw.type,
      difficulty: raw.difficulty,
      question: raw.question.trim(),
      correct_answer: correctAnswer,
      incorrect_answers: incorrectAnswers,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(sourceTitle ? { sourceTitle } : {}),
      ...(explanation ? { explanation } : {}),
      // Omitted when empty, like every optional field beside it — which the
      // form's own `required` makes unreachable on a submit, and which the
      // rules would refuse on a create anyway. Kept rather than written as
      // `tags` unconditionally, so an empty list never reaches a document as a
      // field that reports it has no tags.
      ...(tags.length > 0 ? { tags } : {}),
      // Written only when the toggle is on Markdown (`FEAT-019`). An absent
      // field already means plain, so writing `'plain'` would add a key to
      // every future document that says exactly what its absence says — and
      // it would make "this contributor chose plain" indistinguishable from
      // "this document predates the toggle", which is the distinction the
      // absent state is for.
      ...(raw.format === 'markdown' ? { format: raw.format } : {}),
    },
  };
}

/**
 * Fills the form from a stored question, for the edit dialog.
 *
 * **The rows are built from the stored count** (`FEAT-051`): a five-option
 * question opens on four wrong-answer rows, not on three padded or truncated
 * ones. A boolean question stores its one derived wrong answer, which the form
 * never shows, so it opens on a new question's three empty rows — what the
 * author meets if they switch it to multiple choice.
 *
 * Every stored row is kept, even past the five the rules allow — a document
 * written from the console could carry more — because silently dropping an
 * answer the author wrote is worse than showing it: the remove buttons are
 * right there, and the rules refuse the save until the count is back inside
 * the bound.
 */
export function patchQuestionForm(form: QuestionForm, question: CustomQuestionDoc): void {
  const stored = Array.isArray(question.incorrect_answers) ? question.incorrect_answers : [];
  const rows =
    question.type === 'boolean'
      ? Array.from({ length: DEFAULT_INCORRECT_ANSWERS }, () => '')
      : stored.map((answer) => (typeof answer === 'string' ? answer : ''));
  while (rows.length < MIN_INCORRECT_ANSWERS) {
    rows.push('');
  }
  form.reset({
    difficulty: question.difficulty,
    type: question.type,
    question: question.question,
    // The stored value or the default, so a resubmit keeps the formatting the
    // contributor chose (`FEAT-007` keeps every other field the same way).
    // Anything that is not `'markdown'` — including a value a widened rule let
    // through — patches to plain, which is what the renderer does with it too.
    format: question.format === 'markdown' ? 'markdown' : 'plain',
    correctAnswer: question.correct_answer,
    sourceUrl: question.sourceUrl ?? '',
    sourceTitle: question.sourceTitle ?? '',
    explanation: question.explanation ?? '',
    // Through `topicTagsOf` rather than straight across (`FEAT-052`): the
    // stored tags, re-checked, or — for a question written before topics
    // replaced categories — the tag its category derives. So the dialog opens
    // on what the app would render and what the rules would accept, an author
    // resubmitting a question **keeps** its tags instead of dropping them
    // (the update re-validates the whole payload, so a field the form never
    // loaded is a field the write deletes), and a legacy question's topic moves
    // from its category to its tags on the first save.
    tags: topicTagsOf(question),
  });
  // After the reset rather than through it: `reset()` fills the controls the
  // array already has, and the count is what changes here.
  setIncorrectAnswerRows(form, rows);
}
