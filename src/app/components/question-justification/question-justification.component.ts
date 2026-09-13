import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { QuestionFormat } from '../../models/question.model';
import { RenderedTextComponent } from '../rendered-text/rendered-text.component';

/**
 * Renders a question's optional **Justification** — the contributor's own
 * account of why the correct answer is correct and the distractors are not
 * (`explanation`, `FEAT-006`'s field name; `data-model.md` §3).
 *
 * It exists as a component for the same reason `SourceLinkComponent` does:
 * two callers (the reviewer's queue card and game-over's recap) need identical
 * behaviour, and the behaviour is not the markup.
 *
 * 1. **Nothing renders when there is nothing to say.** Almost no question
 *    carries a justification — Open Trivia DB has no such field, and most
 *    contributions will not need one — so a heading over an empty box, or a
 *    reserved blank line, would appear on nearly every question in the app to
 *    report an absence. An absent optional field is not a defect to announce.
 * 2. **The text is rendered by whatever the question's own `format` says.**
 *    On a plain question — every question in the bank today — it goes through
 *    `RenderedTextComponent`'s plain branch, which is Angular interpolation
 *    into a `white-space: pre-line` box: the paragraphing of a multi-line
 *    justification survives, the runs of spaces a paste brings with it
 *    collapse, and the text is escaped rather than parsed. On a Markdown
 *    question the same component parses and sanitises it, so a justification
 *    can carry the same code and formulas the question does — which is the
 *    kind of question that needs one (`FEAT-019`).
 *
 * No layout-stability concern (`CLAUDE.md` §4.4): both callers render this from
 * data that has already resolved, so the block does not appear or disappear
 * under a reader mid-view.
 */
@Component({
  selector: 'app-question-justification',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RenderedTextComponent],
  template: `
    @if (body(); as text) {
      <div
        class="mt-2 rounded-lg bg-slate-100/70 dark:bg-white/5 px-3 py-2 text-xs text-slate-600 dark:text-slate-300"
        data-cy="question-justification"
      >
        <p class="font-semibold text-slate-500 dark:text-slate-400 mb-0.5">Justification</p>
        <app-rendered-text [text]="text" [format]="format()" />
      </div>
    }
  `,
})
export class QuestionJustificationComponent {
  readonly text = input<string | undefined>(undefined);

  /**
   * The owning question's `format`, passed straight through: a justification is
   * written in the same box as the question it explains, so it is written in
   * the same syntax. Absent means plain, here as everywhere.
   */
  readonly format = input<QuestionFormat | undefined>(undefined);

  /**
   * The justification with its surrounding whitespace removed, or `undefined`
   * when there is none to show.
   *
   * Trimmed here rather than trusted from Firestore. The rule refuses an empty
   * string but cannot refuse `"   "` — `size()` counts characters, not
   * non-space ones — so a whitespace-only value is a document a writer is free
   * to produce and the reader has to cope with (`CLAUDE.md` §4.4: be right
   * regardless of the writer). Without this it would render a labelled empty
   * box.
   */
  readonly body = computed(() => this.text()?.trim() || undefined);
}
