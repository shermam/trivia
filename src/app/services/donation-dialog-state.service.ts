import { Injectable, signal } from '@angular/core';

/**
 * Lets anything open the donation dialog without a component reference to it —
 * the footer's "Buy me a coffee" button is beside it, and the auth menu's
 * entry is in the top bar at the other end of the page.
 *
 * Same shape and same reason as `AuthMenuStateService`: the dialog is mounted
 * once, by `FooterComponent`, and stays a self-contained sibling rather than
 * something two unrelated components each reach into.
 */
@Injectable({ providedIn: 'root' })
export class DonationDialogStateService {
  private readonly isOpenSignal = signal(false);

  readonly isOpen = this.isOpenSignal.asReadonly();

  open(): void {
    this.isOpenSignal.set(true);
  }

  close(): void {
    this.isOpenSignal.set(false);
  }
}
