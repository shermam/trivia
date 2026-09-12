import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import {
  SubscriptionService,
  subscriptionFailureMessage,
} from '../../services/subscription.service';
import { formatUnitAmount } from '../../utils/money.util';
import { IconComponent } from '../icon/icon.component';
import { LogoComponent } from '../logo/logo.component';

type CheckoutQueryStatus = 'success' | 'cancelled' | null;

@Component({
  selector: 'app-pricing',
  standalone: true,
  imports: [RouterLink, IconComponent, LogoComponent],
  templateUrl: './pricing.component.html',
  styleUrl: './pricing.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PricingComponent {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly subscriptionService = inject(SubscriptionService);
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

  /**
   * What Pro costs, in the currency this reader is being quoted.
   *
   * The amount is read from the mirrored Stripe catalog rather than written
   * into the template, because there is now more than one right answer: each
   * currency is its own Stripe Price (`SubscriptionService`), and a literal
   * would be wrong for whoever is not being charged in it.
   */
  protected readonly currencyOptions = this.subscriptionService.proPriceOptions;
  protected readonly selectedCurrency = this.subscriptionService.selectedCurrency;

  /** The formatted amount, or `null` until the catalog has answered. */
  protected readonly priceAmount = computed(() => {
    const price = this.subscriptionService.selectedProPrice();
    return price ? formatUnitAmount(price.unitAmount, price.currency) : null;
  });

  /**
   * Whether there is a choice to offer. One currency is not a choice, and a
   * control with a single option is a control that only looks like one.
   */
  protected readonly hasCurrencyChoice = computed(() => this.currencyOptions().length > 1);

  /**
   * The currency code shown when there is no choice to offer.
   *
   * A non-breaking space while the catalog is still loading, rather than an
   * empty string: the cell is a flex box whose height comes from its own line
   * box, and an empty one collapses — which would put the very layout jump
   * this row exists to prevent back into the card.
   */
  protected readonly currencyLabel = computed(
    () => this.selectedCurrency()?.toUpperCase() ?? '\u00A0',
  );

  /**
   * The Subscribe button's label, which names the price when there is one.
   *
   * It drops to a bare "Subscribe" rather than quoting a placeholder amount:
   * a button that offers to charge you "—" is worse than one that just says
   * what it does.
   */
  protected readonly subscribeLabel = computed(() => {
    const amount = this.priceAmount();
    return amount ? `Subscribe — ${amount}/mo` : 'Subscribe';
  });

  constructor() {
    // The pricing page is the one screen that has to *show* the price, so the
    // catalog read happens here on load rather than on the Subscribe click.
    // Roughly two public reads per visit; see `loadProPrices()` for the trade.
    void this.subscriptionService.loadProPrices();

    // Landing here from Stripe's `success_url` means the payment went through,
    // but not that our own `stripeWebhook` has finished mirroring the
    // subscription document yet — the redirect and the webhook delivery race,
    // and the redirect often wins. `SubscriptionService` used to hold an
    // `onSnapshot` listener that simply saw the write whenever it landed;
    // since the Firestore SDK left the bundle (`BACKLOG.md` item 2) that has
    // to be asked for, and this is the one place that knows to ask.
    if (this.checkoutStatus() === 'success') {
      void this.subscriptionService.awaitProActivation();
    }
  }

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

  protected selectCurrency(currency: string): void {
    this.subscriptionService.selectCurrency(currency);
  }

  protected dismissCheckoutStatus(): void {
    this.checkoutStatus.set(null);
    void this.router.navigate([], { queryParams: {}, replaceUrl: true });
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
    } catch (error) {
      // The service names every cause it can verify — signed out, no Pro
      // price on sale, the volume cap, an error the function wrote back, a
      // handshake that timed out — and that message is shown as is. Only a
      // failure it could not explain gets the generic line (`CLAUDE.md`
      // §4.4: distinguish the cases or stay generic).
      this.errorMessage.set(
        subscriptionFailureMessage(error, 'Could not start checkout. Please try again.'),
      );
      this.isSubscribing.set(false);
    }
  }
}
