import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  afterNextRender,
  inject,
  input,
  signal,
} from '@angular/core';
import { AbstractControl, ReactiveFormsModule } from '@angular/forms';
import { IconComponent } from '../icon/icon.component';
import { RenderedTextComponent } from '../rendered-text/rendered-text.component';
import { TagSelectorComponent } from '../tag-selector/tag-selector.component';
import { msg, type Message } from '../../i18n/message';
import { RichTextComponent } from '../../i18n/rich-text.component';
import { TPipe } from '../../i18n/t.pipe';
import {
  FIELD_MESSAGES,
  MAX_ANSWER_LENGTH,
  MAX_INCORRECT_ANSWERS,
  MAX_QUESTION_LENGTH,
  MIN_INCORRECT_ANSWERS,
  QuestionForm,
  addIncorrectAnswer,
  canAddIncorrectAnswer,
  canRemoveIncorrectAnswer,
  fieldErrorFor,
  incorrectAnswerMessages,
  optionCount,
  removeIncorrectAnswer,
  showsFieldError,
} from './question-form';

/**
 * The fields of a contributed question, rendered identically wherever one is
 * written: `/add-question` and `/my-questions`' edit dialog (`FEAT-007`).
 *
 * **One component rather than two templates**, for the reason the two report
 * rows on game-over share one: a second copy is how the two grow different
 * accessibility contracts. Every field here carries `aria-invalid` and an
 * `aria-describedby` that names its error and its hint, and every one of those
 * is a thing to forget in a copy and impossible to notice afterwards.
 *
 * **`idPrefix` exists because a DOM id is global.** It defaults to empty, so
 * `/add-question` renders exactly the ids and `data-cy` values it always has;
 * the dialog passes a prefix so a page that ever showed both would still have
 * one `<label for>` per control. The prefix has to reach the label table in
 * `question-form.ts` too, or the focus-the-first-invalid-control behaviour
 * looks up ids that are not there.
 *
 * **The wrong answers are rows the contributor adds and removes** (`FEAT-051`),
 * from one to five — two to six options in all. The rows themselves are the
 * form's (`addIncorrectAnswer`, `removeIncorrectAnswer`); what lives here is
 * what a person using them needs: focus that follows the row they acted on,
 * and a sentence saying how many answers the question now has.
 */
@Component({
  selector: 'app-question-fields',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    IconComponent,
    RenderedTextComponent,
    TagSelectorComponent,
    RichTextComponent,
    TPipe,
  ],
  templateUrl: './question-fields.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuestionFieldsComponent {
  private readonly injector = inject(Injector);

  readonly form = input.required<QuestionForm>();
  readonly idPrefix = input('');
  /**
   * What was wrong with the last submit, or `null`. Rendered here rather than
   * by the host because it is announced from a live region that has to exist
   * before it has anything to say (finding G3).
   */
  readonly validationSummary = input<Message | null>(null);

  protected readonly maxQuestionLength = MAX_QUESTION_LENGTH;
  protected readonly maxAnswerLength = MAX_ANSWER_LENGTH;

  /**
   * What adding or removing a row did, for the permanent `role="status"`
   * region under the rows. A row appearing or vanishing is otherwise silent to
   * a screen reader — and so is the "Add an answer" button going unavailable
   * at six, which this says in words when it happens.
   */
  protected readonly rowsAnnouncement = signal<Message | null>(null);

  protected readonly topicsHint = msg(
    'form.topicsHint',
    'A few words for what this question is about, so players can ask for exactly this subject. Reviewers see them too.',
  );

  protected readonly markdownHelp = msg(
    'form.markdownHelp',
    'Paragraphs and line breaks, bold, italics, strikethrough, lists, quotes, links, inline code and code blocks, plus LaTeX between <code>$…$</code> and <code>$$…$$</code>. Anything else is removed rather than shown.',
  );

  protected id(name: string): string {
    return `${this.idPrefix()}${name}`;
  }

  protected showsError(control: AbstractControl): boolean {
    return showsFieldError(control);
  }

  /** A field's error, by the field's name in {@link FIELD_MESSAGES} — or row `n`'s, counted from one. */
  protected errorFor(
    control: AbstractControl,
    field: keyof typeof FIELD_MESSAGES | number,
    maxLength: number,
  ): Message | null {
    const messages =
      typeof field === 'number' ? incorrectAnswerMessages(field) : FIELD_MESSAGES[field];
    return fieldErrorFor(control, messages, maxLength);
  }

  /**
   * The topic picker's error, once the contributor has engaged with the form.
   * Its own sentence rather than `fieldErrorFor`'s "Topics is required.": the
   * fix is to add one, and saying so is what makes the message actionable.
   */
  protected topicsError(): Message | null {
    return showsFieldError(this.form().controls.tags)
      ? msg('form.topicsRequired', 'Add at least one topic.')
      : null;
  }

  protected canAddAnswer(): boolean {
    return canAddIncorrectAnswer(this.form());
  }

  protected canRemoveAnswer(): boolean {
    return canRemoveIncorrectAnswer(this.form());
  }

  /**
   * The question field's description: its counter, and its error first when
   * there is one — the error is the part a screen-reader user needs, and the
   * counter says how far over the limit the text is.
   */
  protected questionDescribedBy(): string {
    const counter = this.id('question-count');
    return this.showsError(this.form().controls.question)
      ? `${this.id('question-error')} ${counter}`
      : counter;
  }

  /** Adds a wrong-answer row, puts the cursor in it, and says so. */
  protected addAnswer(): void {
    const form = this.form();
    const index = addIncorrectAnswer(form);
    if (index === null) {
      return;
    }
    this.rowsAnnouncement.set(
      msg('form.answerAdded', 'Incorrect answer {n} added. {status}', {
        n: index + 1,
        status: this.countSentence(),
      }),
    );
    this.focusAfterRender(this.id(`incorrect-answer-${index}`));
  }

  /**
   * Removes a wrong-answer row, and moves focus to whatever now stands where it
   * was: the row that took its place, or — when it was the last row — "Add an
   * answer", which is the next thing below it. Never to the document body,
   * which is where a removed control leaves focus when nothing catches it
   * (`CLAUDE.md` §4.5): the button that was pressed lives in the row that has
   * just gone.
   */
  protected removeAnswer(index: number): void {
    const form = this.form();
    if (!removeIncorrectAnswer(form, index)) {
      return;
    }
    this.rowsAnnouncement.set(
      msg('form.answerRemoved', 'Incorrect answer {n} removed. {status}', {
        n: index + 1,
        status: this.countSentence(),
      }),
    );
    const remaining = form.controls.incorrectAnswers.length;
    this.focusAfterRender(
      index < remaining ? this.id(`incorrect-answer-${index}`) : this.id('add-answer'),
    );
  }

  private countSentence(): Message {
    const count = optionCount(this.form());
    if (count >= MAX_INCORRECT_ANSWERS + 1) {
      return msg(
        'form.answersMost',
        '{count, plural, one {The question now has # answer. That is the most a question can have.} other {The question now has # answers. That is the most a question can have.}}',
        { count },
      );
    }
    if (count <= MIN_INCORRECT_ANSWERS + 1) {
      return msg(
        'form.answersFewest',
        '{count, plural, one {The question now has # answer. That is the fewest a question can have.} other {The question now has # answers. That is the fewest a question can have.}}',
        { count },
      );
    }
    return msg(
      'form.answers',
      '{count, plural, one {The question now has # answer.} other {The question now has # answers.}}',
      { count },
    );
  }

  /**
   * Focus after the next render, not now: a row being added does not exist in
   * the DOM until the template has run, and a row being removed is still there
   * — so a `focus()` made here would land on nothing, or on the row on its way
   * out (`CLAUDE.md` §4.4, DOM work that depends on a binding).
   */
  private focusAfterRender(id: string): void {
    afterNextRender(() => document.getElementById(id)?.focus(), { injector: this.injector });
  }
}
