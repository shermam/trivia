import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
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

/**
 * How long the currency has to stand still before a Checkout Session is
 * created for it.
 *
 * A session is created per price, and creating one expires the customer's
 * previous open session — so a reader flicking between USD and BRL while they
 * decide would otherwise spend one Stripe session and one slot of the
 * `firestore.rules` volume cap per flick. A second is long enough that
 * deciding costs one session and short enough that it has finished well before
 * anybody has read the feature list and reached the button.
 *
 * It also covers the page's own late answers: the country arrives up to two
 * seconds after the catalog and can move the selection, and the wait restarts
 * each time it does, so the session is created for the currency the reader is
 * actually looking at.
 */
const CHECKOUT_PREPARE_DELAY_MS = 1_000;

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
    // It renders from this browser's own copy first and revalidates behind
    // that, so a returning visitor waits for nothing — see `loadProPrices()`
    // for what that costs and what it cannot promise.
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

    // Create the Checkout Session while the reader is still reading, so
    // Subscribe is a redirect rather than a wait (`SubscriptionService.prepareCheckout`,
    // which decides for itself whether this reader is one it is worth doing
    // for). The effect reads every signal that can change the answer —
    // whether auth has resolved, whether they are already Pro, whether they
    // are a real verified account, and which price is selected — so each
    // change restarts the wait rather than racing it.
    //
    // `onCleanup` is the teardown `CLAUDE.md` §4.4 asks for, and it is doing
    // real work rather than satisfying a rule: it is what turns a stream of
    // selection changes into one session instead of one per change, and what
    // stops a timer firing into a destroyed component when the reader
    // navigates away mid-wait.
    effect((onCleanup) => {
      const ready = this.authReady();
      const isPro = this.isProUser();
      const verified = this.authService.isFullyAuthenticated();
      const priceId = this.subscriptionService.selectedProPrice()?.priceId;
      if (!ready || isPro || !verified || !priceId) {
        return;
      }

      const timer = setTimeout(
        () => void this.subscriptionService.prepareCheckout(),
        CHECKOUT_PREPARE_DELAY_MS,
      );
      onCleanup(() => clearTimeout(timer));
    });
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
