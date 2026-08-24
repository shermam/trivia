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
import { prefersReducedMotion } from '../../motion';
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
/**
 * How long the account chip takes to settle into its new width. Short enough
 * that it reads as the chip resolving rather than as an animation in its own
 * right; long enough to be a movement rather than a jump.
 */
const CHIP_WIDTH_TRANSITION_MS = 220;

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
  private readonly accountChip = viewChild<ElementRef<HTMLElement>>('accountChip');
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
  /**
   * The chip's width last time it was measured, so a change can be animated
   * from it. `null` until the first measurement.
   */
  private lastChipWidth: number | null = null;
  private chipAnimationFrame: number | null = null;
  private chipTransitionCleanup: (() => void) | null = null;

  protected readonly showsRealAccount = computed(
    () => this.authService.user() !== null && !this.authService.isAnonymous(),
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
      // The chip's width animation owns a frame request, a listener and a
      // timer; a component torn down mid-animation must not leave any of them
      // (`CLAUDE.md` §4.4).
      const chip = this.accountChip()?.nativeElement;
      if (chip) {
        this.cancelChipWidthAnimation(chip);
      }
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

  /**
   * Animates the chip's width when its contents change size.
   *
   * **Why this cannot be done in CSS.** A transition animates a change to a
   * *property*; this width change comes from the content changing while the
   * property stays `width: auto`, so there is no property transition to hook.
   * `interpolate-size: allow-keywords` does not help either — it lets `auto`
   * be interpolated against a length, and here both the before and after
   * computed values are `auto`. The only way is to measure both and drive the
   * width explicitly, which is what this does: read the new width after
   * render, put the old one back, and let a transition carry it to the new.
   *
   * Writing `element.style.width` goes through CSSOM, which the CSP does not
   * govern — unlike a `style="…"` attribute in a template, whose declarations
   * would be silently dropped (`CLAUDE.md` §4.4).
   *
   * The app is zoneless (no zone.js, no polyfills entry), so the callbacks
   * below trigger no change detection and need none: they touch the DOM
   * directly and read no signals.
   */
  private readonly chipWidthEffect = effect(() => {
    // Everything that changes the chip's contents, read so the effect re-runs.
    this.authService.authReady();
    this.authService.user();
    this.subscriptionService.isProUser();
    this.showsRealAccount();

    const element = this.accountChip()?.nativeElement;
    if (!element) {
      return;
    }

    const from = this.lastChipWidth;
    // Clear any width left over from an animation still in flight, so the
    // measurement below is of the content and not of where it had got to.
    this.cancelChipWidthAnimation(element);
    const to = element.getBoundingClientRect().width;
    this.lastChipWidth = to;

    // Nothing to animate on first paint, when the width is unchanged, or when
    // the reader has asked for less motion.
    if (from === null || Math.abs(from - to) < 1 || prefersReducedMotion()) {
      return;
    }

    element.style.width = `${from}px`;
    element.style.transitionProperty = 'width';
    element.style.transitionDuration = `${CHIP_WIDTH_TRANSITION_MS}ms`;
    element.style.transitionTimingFunction = 'ease-out';

    this.chipAnimationFrame = requestAnimationFrame(() => {
      this.chipAnimationFrame = null;
      element.style.width = `${to}px`;
    });

    // `transitionend` alone is not enough: it never fires if the transition is
    // interrupted or never starts, which would strand an explicit width on the
    // chip and freeze it at that size for the rest of the session. The timer is
    // the backstop, and whichever lands first tears the other down.
    const onEnd = () => this.cancelChipWidthAnimation(element);
    element.addEventListener('transitionend', onEnd);
    const timer = setTimeout(onEnd, CHIP_WIDTH_TRANSITION_MS + 100);
    this.chipTransitionCleanup = () => {
      element.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);
    };
  });

  /** Returns the chip to `width: auto` and drops whatever was watching it. */
  private cancelChipWidthAnimation(element: HTMLElement): void {
    if (this.chipAnimationFrame !== null) {
      cancelAnimationFrame(this.chipAnimationFrame);
      this.chipAnimationFrame = null;
    }
    this.chipTransitionCleanup?.();
    this.chipTransitionCleanup = null;
    element.style.width = '';
    element.style.transitionProperty = '';
    element.style.transitionDuration = '';
    element.style.transitionTimingFunction = '';
  }

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
