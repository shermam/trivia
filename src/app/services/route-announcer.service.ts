import { Injectable, signal } from '@angular/core';

/**
 * Holds the text a live region reads out after a route change (finding G5).
 *
 * Client-side navigation is **silent** to assistive tech: nothing reloads, focus
 * does not move, and the only thing that changes is a chunk of DOM. A sighted
 * user sees a new screen; a screen reader user gets no signal at all that the
 * page they were on has been replaced.
 *
 * Deliberately a separate service rather than state on the root component: the
 * thing that *knows* about navigation is a `TitleStrategy` (`AppTitleStrategy`),
 * which is not a component and cannot render, and the thing that *renders* the
 * live region is `App`. This is the seam between them.
 */
@Injectable({ providedIn: 'root' })
export class RouteAnnouncerService {
  private readonly messageSignal = signal('');

  readonly message = this.messageSignal.asReadonly();

  announce(message: string): void {
    this.messageSignal.set(message);
  }
}
