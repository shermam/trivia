import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';

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
  private readonly authService = inject(AuthService);

  private readonly isOpenSignal = signal(false);

  readonly isOpen = this.isOpenSignal.asReadonly();

  open(): void {
    this.isOpenSignal.set(true);
    /*
     * Opening this dialog is somebody two clicks from paying, and paying needs
     * a uid: `startDonation()` writes a `donation_sessions` document owned by
     * it. Since the auth bootstrap moved off the critical path (`FEAT-017`
     * §3.2) that uid can be up to two seconds away, and the footer's button is
     * on `/` from first paint — so a reader who opens the dialog and clicks
     * straight through used to be refused with "still starting up".
     * `startDonation()` also awaits the bootstrap, which is what makes the
     * click correct; starting it here is what makes it instant. Idempotent and
     * memoised, and nothing awaits it, so the dialog still opens at once.
     */
    void this.authService.ensureSignedIn();
  }

  close(): void {
    this.isOpenSignal.set(false);
  }
}
