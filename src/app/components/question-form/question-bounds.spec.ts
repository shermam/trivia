import { FormBuilder } from '@angular/forms';
import { describe, expect, it } from 'vitest';
// The bounds `firestore.rules` holds, as the repository publishes them for the
// question-generation pipeline. Read by this spec and nothing else: no file
// under `src/app` imports it, so it never reaches a bundle. The app keeps its
// own copies of the bounds, written where they are used, and this is what
// holds each copy to the published one — which
// `firestore-tests/question-bounds.rules.spec.ts` holds to the rules.
import bounds from '../../../../question-bounds.json';
import type { Difficulty, QuestionFormat, QuestionType } from '../../models/question.model';
import {
  MAX_TAGS_PER_QUESTION,
  MAX_TAG_LENGTH,
  MIN_TAG_LENGTH,
  isNormalizedTag,
} from '../../utils/normalize-tag.util';
import {
  MAX_ANSWER_LENGTH,
  MAX_INCORRECT_ANSWERS,
  MAX_QUESTION_LENGTH,
  MIN_INCORRECT_ANSWERS,
  applyIncorrectAnswerValidators,
  createQuestionForm,
  toQuestionContent,
} from './question-form';

/**
 * The contribute form restates the bounds `firestore.rules` enforces, so that
 * a contributor meets a field error rather than a `permission-denied` naming
 * nothing — and a restatement that drifts is exactly that failure, or the
 * opposite one, a form refusing what the rules would take. Each copy is pinned
 * to `question-bounds.json` here: the named constants by value, the validators
 * by driving the controls at each bound and one past it, and the model's unions
 * by an exhaustive record the compiler checks against the type.
 *
 * Lengths are UTF-16 code units in the rules, and `Validators.maxLength`
 * counts `.length`, which is the same unit; the strings past a maximum are
 * built from surrogate pairs so that a validator counting code points instead
 * would be seen to accept them.
 */

/** One UTF-16 code unit. */
const ONE_UNIT = '\u00e9';
/** Two UTF-16 code units, one code point. */
const TWO_UNITS = '\u{1F600}';
const textOf = (units: number) => ONE_UNIT.repeat(units);
const textPast = (units: number) =>
  TWO_UNITS.repeat(Math.floor(units / 2)) + ONE_UNIT.repeat(units % 2);

const newForm = () => createQuestionForm(new FormBuilder());

describe('question-bounds.json: the contribute form’s copies', () => {
  it('names the published lengths and counts in its constants', () => {
    expect(MAX_QUESTION_LENGTH).toBe(bounds.question.maxLength);
    expect(MAX_ANSWER_LENGTH).toBe(bounds.correct_answer.maxLength);
    expect(MAX_ANSWER_LENGTH).toBe(bounds.incorrect_answers.maxLength);
    expect(MIN_INCORRECT_ANSWERS).toBe(bounds.incorrect_answers.minCount);
    expect(MAX_INCORRECT_ANSWERS).toBe(bounds.incorrect_answers.maxCount);
  });

  it('holds the question and the correct answer to the published lengths', () => {
    const form = newForm();
    for (const [control, { minLength, maxLength }] of [
      [form.controls.question, bounds.question],
      [form.controls.correctAnswer, bounds.correct_answer],
    ] as const) {
      control.setValue(textOf(minLength));
      expect(control.valid).toBe(true);
      control.setValue(textOf(minLength - 1));
      expect(control.valid).toBe(false);
      control.setValue(textOf(maxLength));
      expect(control.valid).toBe(true);
      control.setValue(textPast(maxLength + 1));
      expect(control.hasError('maxlength')).toBe(true);
    }
  });

  it('holds every wrong-answer row of a multiple-choice question to the published lengths', () => {
    const form = newForm();
    applyIncorrectAnswerValidators(form, 'multiple');
    const { minLength, maxLength } = bounds.incorrect_answers;
    for (const row of form.controls.incorrectAnswers.controls) {
      row.setValue(textOf(minLength));
      expect(row.valid).toBe(true);
      row.setValue(textOf(minLength - 1));
      expect(row.valid).toBe(false);
      row.setValue(textOf(maxLength));
      expect(row.valid).toBe(true);
      row.setValue(textPast(maxLength + 1));
      expect(row.hasError('maxlength')).toBe(true);
    }
  });

  // Optional, so the floor is kept by omission rather than by a validator: a
  // blank field is left out of the write, and the published minimum is never
  // undercut by a present-but-empty value.
  it('holds the justification and the source name to the published lengths', () => {
    const form = newForm();
    for (const [control, { maxLength }] of [
      [form.controls.explanation, bounds.explanation],
      [form.controls.sourceTitle, bounds.sourceTitle],
    ] as const) {
      control.setValue(textOf(maxLength));
      expect(control.valid).toBe(true);
      control.setValue(textPast(maxLength + 1));
      expect(control.hasError('maxlength')).toBe(true);
    }
    expect(bounds.explanation.minLength).toBe(1);
    expect(bounds.sourceTitle.minLength).toBe(1);
    form.patchValue({ question: 'Q?', correctAnswer: 'A', explanation: ' ', sourceTitle: ' ' });
    form.controls.incorrectAnswers.controls.forEach((row, i) => row.setValue(`W${i}`));
    const { content } = toQuestionContent(form.getRawValue());
    expect(content).toBeDefined();
    expect(content).not.toHaveProperty('explanation');
    expect(content).not.toHaveProperty('sourceTitle');
  });

  it('holds the source link to the published prefix and lengths', () => {
    const control = newForm().controls.sourceUrl;
    const { prefix, minLength, maxLength } = bounds.sourceUrl;
    const url = (units: number, fill = textOf) => prefix + fill(units - prefix.length);
    control.setValue(url(minLength));
    expect(control.valid).toBe(true);
    control.setValue(url(minLength - 1));
    expect(control.valid).toBe(false);
    control.setValue(url(maxLength));
    expect(control.valid).toBe(true);
    control.setValue(url(maxLength + 1, textPast));
    expect(control.hasError('maxlength')).toBe(true);
    for (const candidate of [
      'https://en.wikipedia.org/wiki/Water',
      'http://en.wikipedia.org/wiki/Water',
      'HTTPS://en.wikipedia.org/wiki/Water',
      'ftp://example.org/water.txt',
    ]) {
      control.setValue(candidate);
      expect(control.valid, candidate).toBe(candidate.startsWith(prefix));
    }
  });

  it('asks for at least the published number of topics', () => {
    const control = newForm().controls.tags;
    expect(bounds.tags.minCount).toBe(1);
    control.setValue([]);
    expect(control.valid).toBe(false);
    control.setValue(['history']);
    expect(control.valid).toBe(true);
  });

  it('writes a true-or-false question with the published number of wrong answers', () => {
    const form = newForm();
    form.patchValue({ type: 'boolean', question: 'Water boils at 100 °C at sea level.' });
    form.controls.correctAnswer.setValue('True');
    const { content } = toQuestionContent(form.getRawValue());
    expect(content?.incorrect_answers).toHaveLength(bounds.type.booleanIncorrectAnswers);
  });
});

describe('question-bounds.json: the tag normaliser’s copy', () => {
  it('names the published count and lengths in its constants', () => {
    expect(MAX_TAGS_PER_QUESTION).toBe(bounds.tags.maxCount);
    expect(MIN_TAG_LENGTH).toBe(bounds.tags.minLength);
    expect(MAX_TAG_LENGTH).toBe(bounds.tags.maxLength);
  });

  it('accepts exactly the tags the published pattern and lengths accept', () => {
    // Applied as a full match, the way the rules' `matches()` applies it.
    const shape = new RegExp(`^(?:${bounds.tags.pattern})$`);
    const { minLength, maxLength } = bounds.tags;
    for (const tag of [
      'history',
      'world-war-2',
      'a1',
      'History',
      'world_war_2',
      'world war 2',
      '-history',
      'history-',
      'world--war',
      'café',
      'history\n',
      'a',
      'a'.repeat(maxLength),
      'a'.repeat(maxLength + 1),
    ]) {
      const published = shape.test(tag) && tag.length >= minLength && tag.length <= maxLength;
      expect(isNormalizedTag(tag), JSON.stringify(tag)).toBe(published);
    }
  });
});

describe('question-bounds.json: the model’s unions', () => {
  /**
   * `Record<Union, true>` will not compile with a member missing or one too
   * many, so the compiler holds each list to its type and the assertions hold
   * it to the file — a value added to either side without the other fails here.
   */
  const TYPES: Record<QuestionType, true> = { multiple: true, boolean: true };
  const DIFFICULTIES: Record<Difficulty, true> = { easy: true, medium: true, hard: true };
  const FORMATS: Record<QuestionFormat, true> = { plain: true, markdown: true };
  const sorted = (values: readonly string[]) => [...values].sort();

  it('types a question with exactly the published values', () => {
    expect(sorted(Object.keys(TYPES))).toEqual(sorted(bounds.type.values));
    expect(sorted(Object.keys(DIFFICULTIES))).toEqual(sorted(bounds.difficulty.values));
    expect(sorted(Object.keys(FORMATS))).toEqual(sorted(bounds.format.values));
  });
});
