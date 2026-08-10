import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { RouteAnnouncerService } from './services/route-announcer.service';

/** Appended so the browser tab reads "Play — Trivimind" rather than a bare screen name. */
const APP_NAME = 'Trivimind';

/**
 * Sets the document title on navigation *and* announces the new screen (G5).
 *
 * Both from one place on purpose. The title and the announcement answer the
 * same question — "what am I looking at now" — and letting them drift apart is
 * how a screen reader ends up announcing a screen the tab disagrees with. It
 * also means adding a route means adding one `title`, not remembering two
 * separate registrations.
 */
@Injectable({ providedIn: 'root' })
export class AppTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly announcer = inject(RouteAnnouncerService);

  /**
   * The title of the screen last announced, or `undefined` before the first
   * navigation.
   *
   * Two things fall out of comparing against it, and the second was found by
   * using the app rather than by reasoning about it:
   *
   * - **The first navigation is never announced.** The browser has just loaded
   *   the document and reads its title as part of that; saying it again before
   *   the user has done anything is noise.
   * - **A navigation that does not change the screen is never announced.** The
   *   router fires for a fragment or query-string change too, so the skip link
   *   (`#main-content`) made the app announce "Start a game" at the exact
   *   moment the user was trying to reach the content, and returning from
   *   Stripe to `/pricing?checkout=success` re-announced "Pricing". Neither is
   *   a page change, and neither should sound like one.
   */
  private lastAnnouncedTitle: string | undefined;

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const screenTitle = this.buildTitle(snapshot);
    this.title.setTitle(screenTitle ? `${screenTitle} — ${APP_NAME}` : APP_NAME);

    const isFirstNavigation = this.lastAnnouncedTitle === undefined;
    if (!isFirstNavigation && screenTitle && screenTitle !== this.lastAnnouncedTitle) {
      this.announcer.announce(screenTitle);
    }
    this.lastAnnouncedTitle = screenTitle ?? '';
  }
}
