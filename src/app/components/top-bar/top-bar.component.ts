import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { ReviewerService } from '../../services/reviewer.service';
import { SubscriptionService } from '../../services/subscription.service';
import { ThemeService } from '../../services/theme.service';
import { IconComponent } from '../icon/icon.component';
import { LogoComponent } from '../logo/logo.component';
import { AuthMenuComponent } from './auth-menu.component';
import { environment } from '../../../environments/environment';

/**
 * Whether `focus()` on this element would actually move focus.
 *
 * It silently does nothing — no exception, no return value — on a detached
 * node, on `display: none`, and on `visibility: hidden` (`CLAUDE.md` §4.4).
 * Asking anyway does not leave focus where it was: it drops to `<body>`.
 *
 * `checkVisibility` answers all three in one call, but **its default ignores
 * the `visibility` property**, which is the one that matters here — hence the
 * explicit option. The `getComputedStyle` arm is for engines without it; it is
 * a weaker check (it misses a `display: none` ancestor) and is deliberately
 * the fallback rather than the implementation.
 */
function canReceiveFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected) {
    return false;
  }
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ visibilityProperty: true });
  }
  return getComputedStyle(element).visibility !== 'hidden';
}

/**
 * Global top bar: sits above `<router-outlet>` in app.html as a sibling, not
 * a wrapper, so it can be removed (or gated behind EmbedModeService) without
 * touching any routed screen. Owns only the trigger button + dropdown shell;
 * AuthMenuComponent owns everything auth-state-dependent.
 */
@Component({
  selector: 'app-top-bar',
  standalone: true,
  imports: [AuthMenuComponent, RouterLink, IconComponent, LogoComponent, NgClass],
  templateUrl: './top-bar.component.html',
  styleUrl: './top-bar.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TopBarComponent {
  protected readonly authService = inject(AuthService);
  protected readonly subscriptionService = inject(SubscriptionService);
  protected readonly authMenuState = inject(AuthMenuStateService);
  protected readonly themeService = inject(ThemeService);
  /**
   * Decides whether to show the review link, and nothing else. Rendering it
   * is a convenience; `firestore.rules` is what makes the page's buttons
   * work or not (`CLAUDE.md` §4.2).
   */
  protected readonly reviewerService = inject(ReviewerService);
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  /**
   * "EMULATOR" or "DEV", or empty in production — see
   * `src/environments/environment.ts` for why the label exists at all.
   *
   * A plain field, not a signal: it is fixed at build time by which
   * environment file was substituted, and nothing can change it while the app
   * is running.
   *
   * It renders in **no** e2e or Lighthouse build, because `environment.e2e.ts`
   * sets it empty. That is deliberate on both counts: those builds' layout
   * assertions measure the top bar to the pixel, and a badge would move them
   * without saying anything true about production. The unit spec covers it
   * instead, which is the layer that can vary the environment.
   */
  protected readonly environmentLabel = environment.environmentLabel;

  protected readonly isMenuOpen = this.authMenuState.isOpen;

  /** Ties the trigger's `aria-controls` to the panel it opens. Only one top bar exists. */
  protected readonly panelId = 'auth-menu-panel';

  /**
   * The site-navigation drawer, shown only below the `sm` breakpoint.
   *
   * A local signal rather than a service, unlike `AuthMenuStateService`: that
   * one exists because game-over opens the auth menu from the middle of the
   * page, and nothing outside this component opens this drawer.
   */
  private readonly isNavOpenSignal = signal(false);
  protected readonly isNavOpen = this.isNavOpenSignal.asReadonly();
  protected readonly navPanelId = 'site-nav-panel';

  private readonly menuPanel = viewChild<ElementRef<HTMLElement>>('menuPanel');
  private readonly menuTrigger = viewChild<ElementRef<HTMLElement>>('menuTrigger');
  private readonly navPanel = viewChild<ElementRef<HTMLElement>>('navPanel');
  private readonly navTrigger = viewChild<ElementRef<HTMLElement>>('navTrigger');
  private wasNavOpen = false;

  /**
   * Whatever had focus when the menu opened, so it can be given back on close.
   *
   * Captured rather than assuming the top-bar trigger, because the menu is not
   * only opened from there: game-over's "Sign in to save your score" button
   * opens it too (`AuthMenuStateService` exists for exactly that). Sending
   * focus to the top bar after closing a menu opened from the middle of the
   * page would be its own bug.
   */
  private previouslyFocused: HTMLElement | null = null;
  private wasMenuOpen = false;

  protected readonly needsVerification = computed(
    () => !this.authService.isAnonymous() && !this.authService.isFullyAuthenticated(),
  );

  /**
   * Whether the chip should show a real account rather than the "Sign in" call
   * to action.
   *
   * **Not simply `!isAnonymous()`,** which was the bug. `isAnonymous()` is
   * `user()?.isAnonymous ?? false`, so it is `false` when there is no user at
   * all — and there is a real window where that happens with `authReady()`
   * already true: `onAuthStateChanged` fires once with `null` and flips
   * `authReady`, and only then does `signInAnonymously()` deliver the
   * anonymous user. For those frames the template fell through to the
   * signed-in branch and rendered the `initials()` fallback, so the chip
   * flashed a "?" avatar as though somebody were logged in. That is exactly
   * the wrong-state flash the `authReady()` gate exists to prevent (see
   * `docs/app.md`), reintroduced one branch further down.
   *
   * The same window opens again on sign-out, between the old user going and
   * the replacement anonymous session arriving.
   */
  protected readonly showsRealAccount = computed(
    () => this.authService.user() !== null && !this.authService.isAnonymous(),
  );

  /**
   * Whether the chip shows a visible label at all.
   *
   * True for exactly one state — signed out, auth settled — and that is the
   * whole design. The chip has two widths: avatar-only (70px with the chevron,
   * 42px without it below `sm`) and avatar-plus-"Sign in". Loading and
   * signed-in are both the first, so a returning player's chip resolves
   * **without moving at any viewport**, and the transition only ever widens,
   * firing precisely when the bar has something to offer.
   *
   * **This used to be a phone-only rule and the desktop exception was the
   * bug.** Above `sm` the chip kept the display name and the PRO badge, which
   * made its width a function of two things that arrive late and separately:
   * the name (a short one shrank the chip 19px, a long one grew it 154px) and
   * then the Pro claim a beat later (+20.6px). Every signed-in desktop load
   * shifted the bar twice. Reserving space for them instead was measured and
   * rejected: a slot sized to the "Sign in" string fits four characters plus an
   * ellipsis, and a slot sized to the widest name leaves a signed-out user
   * looking at 150px of nothing.
   *
   * So the name and badge are `sr-only` everywhere and the chip is the avatar.
   * Identity is one click away in the auth menu, which already shows both; the
   * accessible name still reads "S Sherman PRO"; and paid status is an
   * `emerald-400` ring on the avatar, which is a box-shadow and therefore free.
   */
  protected readonly showsLabel = computed(
    () => this.authService.authReady() && !this.showsRealAccount(),
  );

  protected readonly initials = computed(() => {
    const user = this.authService.user();
    const source = user?.displayName || user?.email || '';
    return source.trim().charAt(0).toUpperCase() || '?';
  });

  constructor() {
    // Registered on the *capture* phase, so this runs before the click
    // reaches its target — otherwise a trigger living outside the top bar
    // (e.g. game-over's "Sign in" button) would open the menu and then
    // immediately have it closed by this same click bubbling up to
    // `document`, since that element isn't contained in `elementRef`.
    const onDocumentClick = (event: MouseEvent) => {
      if (this.isMenuOpen() && !this.elementRef.nativeElement.contains(event.target as Node)) {
        this.authMenuState.close();
      }
    };
    document.addEventListener('click', onDocumentClick, true);

    // On `document` rather than the panel: Escape should close the menu
    // wherever focus happens to be, including the moment before focus has
    // moved into the panel, and after a click has taken it back out.
    const onDocumentKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (this.isMenuOpen()) {
        this.authMenuState.close();
      }
      if (this.isNavOpenSignal()) {
        this.closeNav();
      }
    };
    document.addEventListener('keydown', onDocumentKeydown);

    /**
     * The drawer only exists below `sm`, so widening past it — rotating a
     * phone, or dragging a desktop window wider — has to close it.
     *
     * Without this the panel is unmounted by its own `sm:hidden` while focus is
     * still inside it, which drops focus to `<body>` and leaves `aria-expanded`
     * reading `true` on a trigger that is no longer visible. Closing it
     * properly is what returns focus to something real.
     *
     * `640px` is Tailwind's `sm`, and the two have to agree — the class in the
     * template is what actually hides the drawer, and this is what tidies up
     * after it.
     */
    const wideEnoughForFullNav = window.matchMedia('(min-width: 640px)');
    const onBreakpointChange = (event: MediaQueryListEvent) => {
      if (event.matches && this.isNavOpenSignal()) {
        this.closeNav();
      }
    };
    wideEnoughForFullNav.addEventListener('change', onBreakpointChange);

    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('keydown', onDocumentKeydown);
      wideEnoughForFullNav.removeEventListener('change', onBreakpointChange);
    });

    // Focus follows the menu: into the panel when it opens, back where it came
    // from when it closes (G2). Without this, opening the menu leaves focus on
    // the trigger — so a keyboard user tabs *through the whole page* to reach a
    // panel that is already on screen — and closing it drops focus to
    // `<body>`, losing their place entirely.
    //
    // **`afterRenderEffect`, for the same reason the drawer's is** — a plain
    // `effect()` runs before the bindings it depends on reach the DOM, so the
    // restore below inspected the *previous* frame's opener. That is not a
    // theoretical concern here: it is why the `isConnected` check underneath
    // never actually worked. Traced in Chromium on `main`, signing in from
    // game-over gave `in:open-sign-in` followed immediately by
    // `out:open-sign-in->null` — focus was handed to an opener that Angular
    // was about to take away in the same tick, and landed on `<body>`.
    afterRenderEffect(() => {
      const isOpen = this.isMenuOpen();
      const panel = this.menuPanel();

      if (isOpen && !this.wasMenuOpen) {
        this.previouslyFocused = document.activeElement as HTMLElement | null;
      }

      if (isOpen && panel) {
        // The panel itself, not its first control: it is announced as a dialog
        // with its label, and Tab then reaches the close button first. Focusing
        // the first control instead would skip that announcement.
        panel.nativeElement.focus();
      }

      if (!isOpen && this.wasMenuOpen) {
        const restoreTo = this.previouslyFocused ?? this.menuTrigger()?.nativeElement ?? null;
        this.previouslyFocused = null;
        // Only if focus can actually land there — the opener is routinely
        // taken away by the very action that closed the menu. Signing in from
        // game-over's "Sign in to save this score" is the case that exercises
        // this, and it changed shape: that prompt used to be *removed* from
        // the DOM when auth resolved, and is now one of five faces stacked in
        // a grid cell, so it stays connected and turns `visibility: hidden`
        // instead. Both send focus to `<body>` silently if you ask for it, so
        // both have to fall back to the trigger.
        if (canReceiveFocus(restoreTo)) {
          restoreTo.focus();
        } else {
          this.menuTrigger()?.nativeElement.focus();
        }
      }

      this.wasMenuOpen = isOpen;
    });
  }

  /**
   * Focus follows the drawer, same contract as the auth menu above (G2,
   * `CLAUDE.md` §4.5): into the panel on open, back to the trigger on close.
   *
   * Simpler than the auth menu's version because the drawer has exactly one
   * opener — the hamburger — so there is no "wherever it was opened from" to
   * remember.
   *
   * **`afterRenderEffect`, not `effect` — and that is a bug fix, not a
   * preference.** A plain `effect()` runs *before* the bindings it depends on
   * reach the DOM. Instrumenting `focus`, `setAttribute` and `classList` in
   * Chromium on the click that opens the drawer gives the order outright:
   *
   * ```
   * 1  focus(nav-menu-panel)        inert: true   invisible: true
   * 2  removeAttribute(inert)
   * 3  classList.remove(invisible)
   * 4  classList.remove(pointer-events-none)
   * ```
   *
   * `focus()` on an element that is still `inert` and still
   * `visibility: hidden` is a silent no-op, so the drawer opened with focus
   * left on the hamburger — a keyboard user tabbing from there walks the whole
   * page to reach a panel already on screen.
   *
   * **This worked right up until the drawer stopped being an `@if`, and for a
   * reason worth knowing.** The effect reads `navPanel()`, a `viewChild`
   * signal. While the panel was created and destroyed on open, that signal
   * changed *after* the view was built, which forced a second run of the
   * effect at a point when the DOM was already correct. The ordering was
   * always wrong; a freshly-resolved `viewChild` was accidentally covering for
   * it. Making the panel permanent removed the accident and left the bug.
   *
   * Nothing in jsdom enforces `inert` or `visibility`, so the unit spec's
   * focus assertions pass either way. `mobile-nav.cy.ts` is where this is
   * actually checked.
   */
  private readonly navFocusEffect = afterRenderEffect(() => {
    const isOpen = this.isNavOpen();
    const panel = this.navPanel();

    if (isOpen && panel) {
      panel.nativeElement.focus();
    }

    if (!isOpen && this.wasNavOpen) {
      this.navTrigger()?.nativeElement.focus();
    }

    this.wasNavOpen = isOpen;
  });

  protected toggleNav(): void {
    this.isNavOpenSignal.update((open) => !open);
  }

  protected closeNav(): void {
    this.isNavOpenSignal.set(false);
  }

  protected toggleMenu(): void {
    this.authMenuState.toggle();
  }

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  protected closeMenu(): void {
    this.authMenuState.close();
  }
}
