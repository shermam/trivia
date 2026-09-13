import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { AbstractControl, ReactiveFormsModule } from '@angular/forms';
import { TriviaCategory } from '../../services/trivia.service';
import { IconComponent } from '../icon/icon.component';
import { RenderedTextComponent } from '../rendered-text/rendered-text.component';
import { QuestionForm, fieldErrorFor, showsFieldError } from './question-form';

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
 */
@Component({
  selector: 'app-question-fields',
  standalone: true,
  imports: [ReactiveFormsModule, IconComponent, RenderedTextComponent],
  templateUrl: './question-fields.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuestionFieldsComponent {
  readonly form = input.required<QuestionForm>();
  readonly idPrefix = input('');
  /** `<datalist>` suggestions; an empty list simply offers none. */
  readonly categories = input<TriviaCategory[]>([]);
  /**
   * What was wrong with the last submit, or `null`. Rendered here rather than
   * by the host because it is announced from a live region that has to exist
   * before it has anything to say (finding G3).
   */
  readonly validationSummary = input<string | null>(null);

  protected id(name: string): string {
    return `${this.idPrefix()}${name}`;
  }

  protected showsError(control: AbstractControl): boolean {
    return showsFieldError(control);
  }

  protected errorFor(control: AbstractControl, label: string, maxLength: number): string {
    return fieldErrorFor(control, label, maxLength);
  }
}
