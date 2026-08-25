import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
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
   * Whether the chip's label region takes up space on a phone.
   *
   * True for exactly one state — signed out, auth settled — and that is the
   * whole design. The chip has two widths below `sm`: avatar-only (42px) and
   * avatar-plus-"Sign in". Everything else collapses to the first, so the
   * label region's `grid-template-columns` transition only ever *widens*, and
   * it fires precisely when there is something to say.
   *
   * The product reading is the reason to prefer it over animating in both
   * directions. A returning player's chip resolves to their avatar without
   * moving, which is what you want when the next thing they do is start a
   * game. A signed-out player's chip grows a "Sign in" affordance in the
   * corner of their eye, which is the one moment the bar has something to
   * offer them.
   *
   * Desktop is unaffected: from `sm` up the track is always `1fr`, because
   * there is room for the label in every state and the skeleton is already
   * sized to the string it becomes.
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
    effect(() => {
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
        // Only if it is still in the document: the opener can have been removed
        // by the very action that closed the menu (signing in re-renders
        // game-over's prompt), and focusing a detached node silently sends
        // focus to `<body>`.
        if (restoreTo?.isConnected) {
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
   */
  private readonly navFocusEffect = effect(() => {
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
