import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';

/**
 * Lets screens outside the top bar (e.g. the game-over "sign in to save
 * your score" prompt) open the top bar's auth dropdown without a direct
 * component reference between them — keeps the top bar a self-contained,
 * removable sibling of the routed content rather than something other
 * components reach into directly.
 */
@Injectable({ providedIn: 'root' })
export class AuthMenuStateService {
  private readonly authService = inject(AuthService);

  private readonly isOpenSignal = signal(false);

  readonly isOpen = this.isOpenSignal.asReadonly();

  open(): void {
    this.isOpenSignal.set(true);
    this.startAuth();
  }

  close(): void {
    this.isOpenSignal.set(false);
  }

  toggle(): void {
    const opening = !this.isOpenSignal();
    this.isOpenSignal.set(opening);
    if (opening) {
      this.startAuth();
    }
  }

  /**
   * Opening the menu is the moment auth stops being optional, so it is also
   * where the bootstrap is started if nothing else has started it yet.
   *
   * **This is load-bearing since the bootstrap moved off the critical path
   * (`FEAT-017` §3.2, `App`).** Auth used to be pulled in during boot, so by
   * the time anybody could click the chip it was long resolved. Now it starts
   * on the first idle moment after paint, bounded at two seconds — and on `/`,
   * `/privacy` and `/terms` nothing else reaches for it either, because none
   * of them makes an authenticated read. Without this call, a fast click after
   * load opens a `w-80` dialog showing only "Loading…", which then grows into
   * the whole sign-in form when the SDK lands: a component changing size on
   * the interaction path, which is exactly what `CLAUDE.md` §4.4 forbids.
   *
   * `ensureSignedIn()` is idempotent and memoised (`AuthService.getAuth()`),
   * so calling it here costs nothing when the bootstrap has already run, and
   * it swallows its own failures — nothing here awaits it.
   */
  private startAuth(): void {
    void this.authService.ensureSignedIn();
  }
}
