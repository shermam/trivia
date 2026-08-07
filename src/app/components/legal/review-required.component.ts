import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IconComponent } from '../icon/icon.component';

/**
 * Marks a passage that could not be written from the source code because it
 * needs a legal or business decision. Deliberately loud: an unreviewed
 * placeholder that blends into the surrounding prose is exactly how a
 * fake-authoritative policy ships by accident.
 *
 * Grep for `app-review-required` to find every outstanding item.
 */
@Component({
  selector: 'app-review-required',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div
      role="note"
      aria-label="Review required before publication"
      class="my-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/10"
    >
      <app-icon
        name="triangle-alert"
        [size]="16"
        class="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300"
      />
      <div class="min-w-0">
        <p
          class="mb-1 text-[11px] font-bold tracking-wide text-amber-800 uppercase dark:text-amber-300"
        >
          Review required
        </p>
        <div class="text-sm text-amber-900 dark:text-amber-200/90"><ng-content /></div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewRequiredComponent {}
