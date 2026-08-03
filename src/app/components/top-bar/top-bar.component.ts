import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { SubscriptionService } from '../../services/subscription.service';
import { IconComponent } from '../icon/icon.component';
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
  imports: [AuthMenuComponent, RouterLink, IconComponent],
  templateUrl: './top-bar.component.html',
  styleUrl: './top-bar.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TopBarComponent {
  protected readonly authService = inject(AuthService);
  protected readonly subscriptionService = inject(SubscriptionService);
  protected readonly authMenuState = inject(AuthMenuStateService);
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  protected readonly isMenuOpen = this.authMenuState.isOpen;

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
    inject(DestroyRef).onDestroy(() =>
      document.removeEventListener('click', onDocumentClick, true),
    );
  }

  protected toggleMenu(): void {
    this.authMenuState.toggle();
  }

  protected closeMenu(): void {
    this.authMenuState.close();
  }
}
