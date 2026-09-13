import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * The segmented control that chooses which currency an amount is quoted in —
 * shared by the Pro card on `/pricing` and by the donation dialog, so there is
 * one control to reason about rather than two that can disagree about what a
 * currency choice looks like or how it is announced.
 *
 * **The host element _is_ the control.** Its classes, its `role` and its label
 * are declared here rather than wrapped in one, so dropping the component into
 * a layout produces exactly the box the markup used to: no extra element, no
 * extra line box, and therefore no change to the height of whatever row it
 * sits in (`CLAUDE.md` §4.4, and the Pro card's height is pinned in
 * `pricing.spec.ts`).
 *
 * **`role="radiogroup"` with `aria-labelledby`** because a group of radios
 * whose label lives in a sibling element conveys nothing without it
 * (`CLAUDE.md` §4.5). The radios themselves are real `<input type="radio">`
 * elements kept `sr-only` behind their labels, so keyboard behaviour, the
 * checked state and the accessible name are the platform's rather than
 * reimplemented.
 *
 * **The test-id prefix is an input, not a constant.** Both the pricing page
 * and the dialog can be on screen at once — the footer is on `/pricing` too —
 * and two elements answering to `currency-brl` is a strict-mode failure at
 * best and, in a runner that is not strict, a click on the wrong one
 * (`CLAUDE.md` §4.6).
 */
@Component({
  selector: 'app-currency-switch',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'radiogroup',
    class: 'flex gap-0.5 rounded-xl bg-slate-100 dark:bg-slate-800 p-1',
    '[attr.aria-labelledby]': 'labelledBy()',
    '[attr.data-cy]': 'testIdPrefix() + "-choice"',
  },
  template: `
    @for (currency of currencies(); track currency) {
      <label
        class="flex items-center justify-center rounded-lg px-3 py-1 text-sm font-semibold cursor-pointer transition-colors"
        [class.bg-emerald-100]="selected() === currency"
        [class.dark:bg-emerald-500/20]="selected() === currency"
        [class.text-emerald-700]="selected() === currency"
        [class.dark:text-emerald-400]="selected() === currency"
        [class.text-slate-600]="selected() !== currency"
        [class.dark:text-slate-400]="selected() !== currency"
      >
        <input
          type="radio"
          class="sr-only"
          [attr.name]="name()"
          [attr.data-cy]="testIdPrefix() + '-' + currency"
          [attr.value]="currency"
          [checked]="selected() === currency"
          (change)="currencySelected.emit(currency)"
        />
        {{ currency.toUpperCase() }}
      </label>
    }
  `,
})
export class CurrencySwitchComponent {
  /** Lowercase ISO 4217 codes, in the order they should be offered. */
  readonly currencies = input.required<readonly string[]>();

  /** Which one is checked, or `null` before anything has been resolved. */
  readonly selected = input<string | null>(null);

  /** The radios' shared `name`, so two switches on one page stay separate groups. */
  readonly name = input.required<string>();

  /** The id of the element that labels the group. */
  readonly labelledBy = input.required<string>();

  /** `currency` yields `currency-choice` on the group and `currency-brl` on a radio. */
  readonly testIdPrefix = input.required<string>();

  readonly currencySelected = output<string>();
}
