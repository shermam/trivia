import { Injectable, signal } from '@angular/core';

/**
 * Lets screens outside the top bar (e.g. the game-over "sign in to save
 * your score" prompt) open the top bar's auth dropdown without a direct
 * component reference between them — keeps the top bar a self-contained,
 * removable sibling of the routed content rather than something other
 * components reach into directly.
 */
@Injectable({ providedIn: 'root' })
export class AuthMenuStateService {
  private readonly isOpenSignal = signal(false);

  readonly isOpen = this.isOpenSignal.asReadonly();

  open(): void {
    this.isOpenSignal.set(true);
  }

  close(): void {
    this.isOpenSignal.set(false);
  }

  toggle(): void {
    this.isOpenSignal.set(!this.isOpenSignal());
  }
}
