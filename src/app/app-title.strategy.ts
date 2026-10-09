import { Injectable, effect, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { I18nService } from './i18n/i18n.service';
import { routeTitleMessage } from './i18n/route-title';
import { RouteAnnouncerService } from './services/route-announcer.service';

/**
 * Appended so the browser tab reads "Play — Trivimind" rather than a bare
 * screen name. The brand is a name, the same in every language.
 */
const APP_NAME = 'Trivimind'; // i18n-exempt: the brand is never translated

/**
 * Sets the document title on navigation *and* announces the new screen (G5).
 *
 * Both from one place on purpose. The title and the announcement answer the
 * same question — "what am I looking at now" — and letting them drift apart is
 * how a screen reader ends up announcing a screen the tab disagrees with. It
 * also means adding a route means adding one `title`, not remembering two
 * separate registrations.
 *
 * **A route's title is a message key** (`routeTitle()` in `app.routes.ts`),
 * rendered through the active translation. The tab follows a change of
 * language by itself — the effect below re-renders it — and that is *not* a
 * change of screen, so it is never announced: the announcement is decided by
 * comparing keys, which a change of language leaves alone.
 */
@Injectable({ providedIn: 'root' })
export class AppTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly announcer = inject(RouteAnnouncerService);
  private readonly i18n = inject(I18nService);

  /** The key of the screen on show, or `null` before the first navigation or for an untitled one. */
  private readonly screen = signal<string | null>(null);

  /**
   * The key of the screen last announced, or `undefined` before the first
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
  private lastAnnouncedKey: string | undefined;

  constructor() {
    super();
    // Re-titles the tab when the translation changes. Silent by construction:
    // it never touches the announcer.
    effect(() => this.title.setTitle(this.documentTitle(this.screen())));
  }

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const key = this.buildTitle(snapshot) || null;
    this.screen.set(key);
    this.title.setTitle(this.documentTitle(key));

    const isFirstNavigation = this.lastAnnouncedKey === undefined;
    if (!isFirstNavigation && key && key !== this.lastAnnouncedKey) {
      this.announcer.announce(this.i18n.t(routeTitleMessage(key)));
    }
    this.lastAnnouncedKey = key ?? '';
  }

  private documentTitle(key: string | null): string {
    return key ? `${this.i18n.t(routeTitleMessage(key))} — ${APP_NAME}` : APP_NAME;
  }
}
