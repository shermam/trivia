import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DonationDialogStateService } from '../../services/donation-dialog-state.service';
import { DonationService } from '../../services/donation.service';
import { subscriptionFailureMessage } from '../../services/session-handshake.service';
import { formatUnitAmount } from '../../utils/money.util';
import { CurrencySwitchComponent } from '../currency-switch/currency-switch.component';
import { IconComponent } from '../icon/icon.component';

/**
 * The "Buy me a coffee" dialog: three preset amounts priced from the Stripe
 * catalog, a currency switch when the catalog carries more than one, and a
 * button that hands the reader to Stripe Checkout.
 *
 * Mounted once, by `FooterComponent`, and opened from either the footer's own
 * CTA or the auth menu (`DonationDialogStateService`).
 *
 * **Its accessibility is copied from the report dialog in `GameOverComponent`,
 * including the three traps `CLAUDE.md` §4.5 records**, because every one of
 * them applies here identically:
 *
 * - Tab is trapped in **both** directions by a plain `(keydown)` handler, not
 *   Angular's `keydown.tab` — that binding does not fire while Shift is held,
 *   which is the direction that escapes backwards past the first control.
 * - The focusable list is **not** filtered on `offsetParent !== null`. That is
 *   `null` for any `position: fixed` element, which this dialog is, and jsdom
 *   does not implement it at all — either way the list empties and the trap
 *   silently degrades to "bounce back to the dialog".
 * - Focus is restored to a **captured element**, not to whatever
 *   `document.activeElement` was at open time: a click does not focus a
 *   `<button>` on Safari/macOS, so that capture reads `<body>`, which is
 *   connected, so the restore "succeeds" into nothing.
 *
 * The captured element is the footer CTA rather than "whichever control opened
 * this", and that is a deliberate difference from the auth menu. The dialog
 * has two openers, but one of them — the auth-menu entry — closes its own
 * panel on the way, so by the time this dialog closes that button no longer
 * exists. Returning focus to the CTA beside the dialog is the honest answer
 * for both: it is always present whenever the dialog could be opened at all,
 * because the auth-menu entry is hidden on exactly the one route where the CTA
 * is (`/play`).
 */
@Component({
  selector: 'app-donation-dialog',
  standalone: true,
  imports: [CurrencySwitchComponent, IconComponent],
  templateUrl: './donation-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DonationDialogComponent {
  protected readonly donationService = inject(DonationService);
  private readonly dialogState = inject(DonationDialogStateService);

  /**
   * Where focus goes when the dialog closes — the footer's CTA, handed in by
   * the component that owns both.
   */
  readonly returnFocusTo = input<HTMLElement | null>(null);

  protected readonly isOpen = this.dialogState.isOpen;
  protected readonly presets = this.donationService.presets;
  protected readonly currencies = this.donationService.currencies;
  protected readonly selectedCurrency = this.donationService.selectedCurrency;
  protected readonly selectedPriceId = this.donationService.selectedPriceId;
  protected readonly isGuest = this.donationService.isGuest;
  protected readonly isUnavailable = this.donationService.isUnavailable;
  protected readonly catalogResolved = this.donationService.catalogResolved;

  protected readonly isDonating = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  /** Whether there is a currency choice to offer. One currency is not a choice. */
  protected readonly hasCurrencyChoice = computed(() => this.currencies().length > 1);

  /**
   * The Donate button's label, which names the amount once there is one.
   *
   * It drops to a bare "Donate" rather than quoting a placeholder: a button
   * offering to charge you "—" is worse than one that just says what it does.
   */
  protected readonly donateLabel = computed(() => {
    const amount = this.selectedAmount();
    return amount ? `Donate ${amount}` : 'Donate';
  });

  private readonly dialog = viewChild<ElementRef<HTMLElement>>('donationDialog');
  private wasOpen = false;

  constructor() {
    /*
     * The catalog is read when the dialog is opened, not on page load. The tip
     * jar renders nothing until somebody asks for it, and two public reads on
     * every page load for a dialog most readers never open is the cost
     * `/pricing` already refuses to pay for a page they are not on.
     *
     * **Every open, not only the first.** A flag here would be a cache of the
     * failure as much as of the success (`CLAUDE.md` §4.4): a read that fell
     * over — one blocked request, one offline moment — would leave the dialog
     * on `catalogResolved` with no presets and no way back for the life of the
     * tab, telling every subsequent open that donations are unavailable when
     * they are not. Re-entering costs nothing when the read worked, because
     * `DonationService.getPresets()` stores the promise synchronously and so
     * dedupes a second open mid-flight as well as one after the fact; it is
     * only the failed lookup that it deliberately does not keep.
     */
    effect(() => {
      if (this.isOpen()) {
        // `untracked`, so this effect depends on the dialog being open and not
        // on whatever the catalog read happens to touch before its first await.
        untracked(() => void this.donationService.loadPresets());
      }
    });

    /*
     * `afterRenderEffect`, not `effect` — a plain effect runs before the
     * bindings it reads have reached the DOM, so `focus()` would be called on
     * a dialog the browser has not been told about yet and would silently do
     * nothing (`CLAUDE.md` §4.4).
     */
    afterRenderEffect(() => {
      const isOpen = this.isOpen();
      const dialog = this.dialog();

      if (isOpen && dialog) {
        // The dialog itself rather than its first control, so it is announced
        // with its title and Tab then reaches the close button first.
        dialog.nativeElement.focus();
      }

      if (!isOpen && this.wasOpen) {
        const trigger = this.returnFocusTo();
        if (trigger?.isConnected) {
          trigger.focus();
        }
      }

      this.wasOpen = isOpen;
    });
  }

  /** The chosen preset's amount, formatted in the currency's own locale. */
  protected readonly selectedAmount = computed(() => {
    const preset = this.presets().find((option) => option.priceId === this.selectedPriceId());
    return preset ? formatUnitAmount(preset.unitAmount, preset.currency) : null;
  });

  protected amountLabel(unitAmount: number, currency: string): string {
    return formatUnitAmount(unitAmount, currency) ?? '—';
  }

  protected close(): void {
    this.dialogState.close();
  }

  protected selectCurrency(currency: string): void {
    this.errorMessage.set(null);
    this.donationService.selectCurrency(currency);
  }

  protected selectPreset(priceId: string): void {
    this.errorMessage.set(null);
    this.donationService.selectPreset(priceId);
  }

  protected async donate(): Promise<void> {
    if (this.isDonating()) {
      return;
    }
    this.errorMessage.set(null);
    this.isDonating.set(true);
    try {
      // Redirects the page to Stripe Checkout on success, so there is nothing
      // further to do here in the happy path.
      await this.donationService.startDonation();
    } catch (error) {
      // The service names every cause it can verify — nothing on sale, the
      // volume cap, an error the function wrote back, a handshake that timed
      // out — and that message is shown as is. Only a failure it could not
      // explain gets the generic line (`CLAUDE.md` §4.4).
      this.errorMessage.set(
        subscriptionFailureMessage(error, 'Could not start the donation. Please try again.'),
      );
      this.isDonating.set(false);
    }
  }

  /**
   * Keeps Tab inside the dialog while it is open. `aria-modal="true"` is a
   * promise to assistive tech, not an implementation — without this, Tab walks
   * straight out into the page behind, which is still fully rendered.
   *
   * Handled on a plain `keydown` rather than Angular's `keydown.tab`, because
   * that binding does not fire for Shift+Tab.
   */
  protected keepFocusInDialog(event: KeyboardEvent): void {
    if (event.key !== 'Tab') {
      return;
    }
    const dialog = this.dialog()?.nativeElement;
    if (!dialog) {
      return;
    }

    // No visibility filter on top of the selector: `offsetParent !== null` is
    // null for a `position: fixed` element and unimplemented in jsdom, and the
    // template removes controls with `@if` rather than hiding them, so
    // `:not([disabled])` covers the rest.
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );

    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
