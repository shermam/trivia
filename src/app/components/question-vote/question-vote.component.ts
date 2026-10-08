import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { DISLIKE, LIKE, VoteValue } from '../../models/question-vote';
import { QuestionVoteService } from '../../services/question-vote.service';
import { IconComponent } from '../icon/icon.component';

/** Makes each instance's caption id unique — the recap renders one of these per question. */
let nextCaptionId = 0;

/**
 * The like and dislike buttons for one community question (`FEAT-027`): two
 * toggle buttons beside a visible caption, in a group that caption labels.
 *
 * **One component for both places that offer the vote** — after the answer is
 * revealed on `/play`, and on each community question of the recap on
 * `/game-over` — so the two cannot drift into different accessibility
 * contracts, which is how a second copy of a control usually goes wrong.
 *
 * **It shows the vote and says which button was pressed; it does not write.**
 * The host writes, through `QuestionVoteService.toggle`, and announces the
 * outcome in a live region of its own. That split is deliberate: the write can
 * settle after this component has gone — the quiz moves on two seconds after
 * the reveal — and an announcement owned by something that no longer exists is
 * one nobody hears.
 *
 * **Visibly not a report.** A dislike is a matter of taste and a report is a
 * complaint a reviewer acts on (`FEAT-026`), so the two differ in every way a
 * reader can see: a thumb rather than a flag, under the answers rather than
 * beside the question, and "Rate this question" rather than "Report this
 * question".
 *
 * **The same size in every state** (`CLAUDE.md` §4.4): pressed or not, both
 * buttons are the same fixed box holding the same 18px glyph, so voting moves
 * nothing. State is carried three ways at once — `aria-pressed`, a filled
 * glyph, and colour — so it never rests on colour alone (WCAG 1.4.1). The
 * accessible names do not change with it: a toggle button's name is what it
 * does, and `aria-pressed` is what it is.
 */
@Component({
  selector: 'app-question-vote',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex items-center justify-between gap-3"
      role="group"
      [attr.aria-labelledby]="captionId"
      data-cy="question-vote"
    >
      <span [id]="captionId" class="text-sm font-semibold text-slate-500 dark:text-slate-400">
        Rate this question
      </span>
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          data-cy="vote-like"
          aria-label="Like this question"
          [attr.aria-pressed]="value() === like"
          (click)="voted.emit(like)"
          [class]="buttonClass(value() === like, 'like')"
        >
          <app-icon [name]="value() === like ? 'thumbs-up-filled' : 'thumbs-up'" [size]="18" />
        </button>
        <button
          type="button"
          data-cy="vote-dislike"
          aria-label="Dislike this question"
          [attr.aria-pressed]="value() === dislike"
          (click)="voted.emit(dislike)"
          [class]="buttonClass(value() === dislike, 'dislike')"
        >
          <app-icon
            [name]="value() === dislike ? 'thumbs-down-filled' : 'thumbs-down'"
            [size]="18"
          />
        </button>
      </div>
    </div>
  `,
})
export class QuestionVoteComponent {
  private readonly questionVotes = inject(QuestionVoteService);

  /** The `custom_questions` document id the vote is about. */
  readonly questionId = input.required<string>();

  /** Which button was pressed. The host writes it and says what happened. */
  readonly voted = output<VoteValue>();

  protected readonly like = LIKE;
  protected readonly dislike = DISLIKE;
  protected readonly captionId = `question-vote-caption-${nextCaptionId++}`;

  /** The vote as the player sees it: `LIKE`, `DISLIKE`, or `null` for none. */
  protected readonly value = computed(() => this.questionVotes.valueFor(this.questionId()));

  /** One box in every state, so pressing a button moves nothing around it. */
  protected buttonClass(pressed: boolean, kind: 'like' | 'dislike'): string {
    const base =
      'flex h-10 w-10 items-center justify-center rounded-xl border-[1.5px] transition-colors';
    if (!pressed) {
      return `${base} border-slate-900/15 dark:border-white/15 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:border-slate-900/30 dark:hover:border-white/30 hover:text-slate-700 dark:hover:text-slate-200`;
    }
    return kind === 'like'
      ? `${base} border-emerald-600 dark:border-emerald-400 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300`
      : `${base} border-slate-600 dark:border-slate-300 bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-slate-100`;
  }
}
