import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
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

  private readonly menuPanel = viewChild<ElementRef<HTMLElement>>('menuPanel');
  private readonly menuTrigger = viewChild<ElementRef<HTMLElement>>('menuTrigger');

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
      if (event.key === 'Escape' && this.isMenuOpen()) {
        this.authMenuState.close();
      }
    };
    document.addEventListener('keydown', onDocumentKeydown);

    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('keydown', onDocumentKeydown);
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
