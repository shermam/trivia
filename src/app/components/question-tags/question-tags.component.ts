import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { readTags } from '../../utils/normalize-tag.util';

/**
 * A question's topic tags, as read-only chips (`FEAT-021`).
 *
 * A component rather than repeated markup for the reason `SourceLinkComponent`
 * and `QuestionJustificationComponent` are: three callers need identical
 * behaviour — the reviewer's queue card, the game-over recap and the author's
 * own list on `/my-questions` — and the behaviour is not the markup.
 *
 * 1. **Chips are text, and only text.** A tag never goes through
 *    `RenderedTextComponent`, whatever the question's `format` says. It is a
 *    key the filter compares, not prose, and the moment a tag could be Markdown
 *    it could be a link — which is a very short step from a public collection to
 *    an advertising surface. Angular interpolation escapes it; nothing here
 *    touches `innerHTML`.
 * 2. **The stored value is re-checked, not trusted.** `readTags` drops anything
 *    that is not a tag the rules would have accepted — a non-string, an
 *    over-long string, a duplicate, anything past the eighth.
 *    `firestore.rules` refuses all of those on any write the app can make, and
 *    every one of them is writable straight into the collection from the
 *    Firebase console, which the rules do not govern (`CLAUDE.md` §4.4: the
 *    reader has to be right regardless of the writer).
 * 3. **Nothing renders when there is nothing to say.** Almost every question in
 *    the bank has no tags and every Open Trivia DB question has none by
 *    construction, so a heading over an empty row would appear on nearly every
 *    question in the app to report an absence.
 *
 * A `<ul>` with an accessible name, not a run of `<span>`s: it is a list, a
 * screen reader announces how many there are, and the name says what they are
 * — which a bare row of words does not.
 *
 * No layout-stability concern (`CLAUDE.md` §4.4): all three callers render this
 * from data that has already resolved, so the row does not appear under a
 * reader mid-view. The setup screen's *filter* is a different component with a
 * reserved box, for exactly that reason.
 */
@Component({
  selector: 'app-question-tags',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible(); as tags) {
      <ul class="mt-2 flex flex-wrap gap-1.5" [attr.aria-label]="label()" [attr.data-cy]="testId()">
        @for (tag of tags; track tag) {
          <li
            class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-white/10 dark:text-slate-300"
            data-cy="question-tag"
          >
            #{{ tag }}
          </li>
        }
      </ul>
    }
  `,
})
export class QuestionTagsComponent {
  readonly tags = input<readonly string[] | undefined>(undefined);

  /** The list's accessible name. */
  readonly label = input('Tags');

  /** A `data-cy` for the list itself, so a spec can scope to one card's chips. */
  readonly testId = input('question-tags');

  /**
   * The tags worth rendering, or `undefined` when there are none — which is
   * what lets the template render nothing at all rather than an empty list.
   */
  readonly visible = computed(() => readTags(this.tags()));
}
