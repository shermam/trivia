import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { SubscriptionService } from '../../services/subscription.service';

type CheckoutQueryStatus = 'success' | 'cancelled' | null;

@Component({
  selector: 'app-pricing',
  standalone: true,
  templateUrl: './pricing.component.html',
  styleUrl: './pricing.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PricingComponent {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly subscriptionService = inject(SubscriptionService);
  protected readonly authService = inject(AuthService);
  protected readonly authMenuState = inject(AuthMenuStateService);

  protected readonly isProUser = this.subscriptionService.isProUser;
  protected readonly isSubscribing = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  // Read once at construction — this is only ever meaningful on the initial
  // landing from Stripe's `success_url`/`cancel_url` redirect, not something
  // that needs to react to later in-app navigation.
  protected readonly checkoutStatus = signal<CheckoutQueryStatus>(
    (this.route.snapshot.queryParamMap.get('checkout') as CheckoutQueryStatus) ?? null,
  );

  // `AuthService.isAnonymous`/`isFullyAuthenticated` both default to `false`
  // before the very first auth state resolves (`user()` is still `null`),
  // which would otherwise make `needsVerification` read `true` for a split
  // second on every load — mirrors the same guard TopBarComponent already
  // uses ("Loading…") for exactly this reason.
  protected readonly authReady = this.authService.authReady;
  protected readonly needsSignIn = computed(() => this.authService.isAnonymous());
  protected readonly needsVerification = computed(
    () => !this.authService.isAnonymous() && !this.authService.isFullyAuthenticated(),
  );

  protected dismissCheckoutStatus(): void {
    this.checkoutStatus.set(null);
    this.router.navigate([], { queryParams: {}, replaceUrl: true });
  }

  protected async subscribe(): Promise<void> {
    if (this.isSubscribing() || !this.authReady()) {
      return;
    }
    this.errorMessage.set(null);

    if (this.needsSignIn()) {
      this.authMenuState.open();
      return;
    }
    if (this.needsVerification()) {
      this.errorMessage.set('Verify your email first, then come back to subscribe.');
      return;
    }

    this.isSubscribing.set(true);
    try {
      // Redirects the page to Stripe Checkout on success, so there's
      // nothing further to do here in the happy path.
      await this.subscriptionService.startProCheckout();
    } catch {
      this.errorMessage.set('Could not start checkout. Please try again.');
      this.isSubscribing.set(false);
    }
  }
}
