import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import {
  type ProPriceOption,
  SubscriptionError,
  SubscriptionService,
} from '../../services/subscription.service';
import { PricingComponent } from './pricing.component';

/**
 * This constructor call is the entire in-app trigger for the post-checkout
 * activation poll — the only replacement for what the subscription
 * `onSnapshot` used to do for free when a subscriber came back from Stripe
 * (`BACKLOG.md` item 2). Until this spec existed, deleting the call broke
 * nothing: `subscription.service.spec.ts` calls `awaitProActivation()`
 * directly, which proves the method works but not that anything ever invokes
 * it, and `pricing.spec.ts` never loads `?checkout=success` at all.
 *
 * The gate matters as much as the call. Polling on every visit to `/pricing`
 * would spend up to twenty reads on a page most visitors reach by curiosity,
 * and polling on `cancelled` would wait twenty seconds for a subscription
 * nobody bought.
 */

function setup(
  checkout: string | null,
  startProCheckout: () => Promise<void> = () => Promise.resolve(),
  prices: ProPriceOption[] = [],
  /**
   * Everything the pre-creation effect gates on. Defaults describe the reader
   * it is *for* — signed in, verified, not yet subscribed — so only a test
   * about somebody else has to say so.
   */
  who: { authReady?: boolean; isFullyAuthenticated?: boolean; isProUser?: boolean } = {},
) {
  const awaitProActivation = vi.fn(() => Promise.resolve());
  const loadProPrices = vi.fn(() => Promise.resolve());
  const prepareCheckout = vi.fn(() => Promise.resolve());
  const proPriceOptions = signal<readonly ProPriceOption[]>(prices);
  const selectedCurrency = signal<string | null>(prices[0]?.currency ?? null);
  const selectedProPrice = computed(
    () =>
      proPriceOptions().find((option) => option.currency === selectedCurrency()) ??
      proPriceOptions()[0] ??
      null,
  );
  TestBed.configureTestingModule({
    providers: [
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: new Map([['checkout', checkout]]) } },
      },
      { provide: Router, useValue: { navigate: vi.fn() } },
      {
        provide: SubscriptionService,
        useValue: {
          isProUser: signal(who.isProUser ?? false),
          awaitProActivation,
          startProCheckout,
          loadProPrices,
          prepareCheckout,
          proPriceOptions,
          selectedCurrency,
          selectedProPrice,
          selectCurrency: (currency: string) => selectedCurrency.set(currency),
        },
      },
      {
        provide: AuthService,
        useValue: {
          authReady: signal(who.authReady ?? true),
          isAnonymous: signal(false),
          isFullyAuthenticated: signal(who.isFullyAuthenticated ?? true),
        },
      },
    ],
  });
  // Constructed inside an injection context rather than rendered: the
  // behaviour under test is entirely in the constructor, and rendering the
  // whole pricing template would drag in half the app to observe one call.
  const component = TestBed.runInInjectionContext(() => new PricingComponent());
  return {
    component,
    awaitProActivation,
    loadProPrices,
    prepareCheckout,
    proPriceOptions,
    selectedCurrency,
  };
}

describe('PricingComponent post-checkout activation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('waits for Pro to activate when Stripe redirects back with success', () => {
    // Stripe's `success_url` is `${origin}/pricing?checkout=success`
    // (functions/src/checkout-sessions.ts). The payment has gone through, but
    // our own `stripeWebhook` races that redirect and often loses, so the
    // subscription document may not exist yet when this page loads.
    const { awaitProActivation } = setup('success');
    expect(awaitProActivation).toHaveBeenCalledTimes(1);
  });

  it('does not poll when checkout was cancelled', () => {
    const { awaitProActivation } = setup('cancelled');
    expect(awaitProActivation).not.toHaveBeenCalled();
  });

  it('does not poll on an ordinary visit to the pricing page', () => {
    const { awaitProActivation } = setup(null);
    expect(awaitProActivation).not.toHaveBeenCalled();
  });
});

/**
 * What the Subscribe button says when checkout does not start.
 *
 * `SubscriptionService` explains every failure it can (`SubscriptionError`),
 * and this component's only job is not to throw that explanation away. It
 * did: one generic line for an empty catalog, a signed-out caller and a
 * function that never ran alike, so nobody standing up a new environment
 * could tell from the screen which of the three they had.
 */
describe('PricingComponent checkout failure message', () => {
  const view = (component: PricingComponent) =>
    component as unknown as {
      subscribe(): Promise<void>;
      errorMessage(): string | null;
      isSubscribing(): boolean;
    };

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('shows the cause the service verified, word for word', async () => {
    const { component } = setup(null, () =>
      Promise.reject(new SubscriptionError('Timed out waiting for Stripe checkout to start.')),
    );

    await view(component).subscribe();

    expect(view(component).errorMessage()).toBe('Timed out waiting for Stripe checkout to start.');
    expect(view(component).isSubscribing()).toBe(false);
  });

  it('stays generic for a failure the service could not explain', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('Failed to fetch');
    const { component } = setup(null, () => Promise.reject(error));

    await view(component).subscribe();

    expect(view(component).errorMessage()).toBe('Could not start checkout. Please try again.');
    expect(view(component).isSubscribing()).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), error);
  });
});

/**
 * What the card and the button quote.
 *
 * The amount used to be `$0.99` written into the template. It cannot be any
 * more: each currency is its own Stripe Price, so a literal is wrong for
 * whoever is not being charged in it — and the formatting is not incidental
 * either, since R$ 5,90 rendered with US conventions reads as a different
 * number.
 */
describe('PricingComponent price and currency', () => {
  const usd: ProPriceOption = { priceId: 'price_usd', currency: 'usd', unitAmount: 99 };
  const brl: ProPriceOption = { priceId: 'price_brl', currency: 'brl', unitAmount: 590 };

  const view = (component: PricingComponent) =>
    component as unknown as {
      priceAmount(): string | null;
      subscribeLabel(): string;
      hasCurrencyChoice(): boolean;
      currencyLabel(): string;
      selectCurrency(currency: string): void;
    };

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('reads the catalog as the page loads, because the page has to show a price', () => {
    const { loadProPrices } = setup(null, () => Promise.resolve(), [usd]);
    expect(loadProPrices).toHaveBeenCalledTimes(1);
  });

  it('renders the amount in the currency the reader is quoted', () => {
    const { component } = setup(null, () => Promise.resolve(), [usd]);

    expect(view(component).priceAmount()).toBe('$0.99');
    expect(view(component).subscribeLabel()).toBe('Subscribe — $0.99/mo');
  });

  // The conventions belong to the currency, not to the reader's browser: a
  // price is a fact about the charge, and R$ 5,90 shown as "R$5.90" is the
  // same number wearing somebody else's punctuation.
  it('renders a Brazilian amount with Brazilian conventions', () => {
    const { component } = setup(null, () => Promise.resolve(), [brl]);

    // A non-breaking space is what `pt-BR` puts after the symbol.
    expect(view(component).priceAmount()).toBe('R$\u00A05,90');
    expect(view(component).subscribeLabel()).toBe('Subscribe — R$\u00A05,90/mo');
  });

  it('switches the quoted amount when another currency is chosen', () => {
    const { component } = setup(null, () => Promise.resolve(), [usd, brl]);
    expect(view(component).priceAmount()).toBe('$0.99');

    view(component).selectCurrency('brl');

    expect(view(component).priceAmount()).toBe('R$\u00A05,90');
    expect(view(component).currencyLabel()).toBe('BRL');
  });

  // One currency is not a choice, and a control with a single option is a
  // control that only looks like one. (Two tests rather than two `setup()`
  // calls in one: `TestBed` refuses to be configured twice in a test.)
  it('offers no choice when the catalog sells in one currency', () => {
    const { component } = setup(null, () => Promise.resolve(), [usd]);
    expect(view(component).hasCurrencyChoice()).toBe(false);
  });

  it('offers a choice once the catalog sells in two', () => {
    const { component } = setup(null, () => Promise.resolve(), [usd, brl]);
    expect(view(component).hasCurrencyChoice()).toBe(true);
  });

  /*
   * Before the catalog answers there is no price to show, and the button must
   * not offer to charge a placeholder (`CLAUDE.md` §4.4: the least alarming
   * outcome, not the most specific one). The currency cell falls back to a
   * non-breaking space rather than an empty string, because an empty flex cell
   * collapses and takes the row's reserved height with it — which is the very
   * layout jump the row exists to prevent.
   */
  it('quotes nothing at all until the catalog has answered', () => {
    const { component } = setup(null, () => Promise.resolve(), []);

    expect(view(component).priceAmount()).toBeNull();
    expect(view(component).subscribeLabel()).toBe('Subscribe');
    expect(view(component).currencyLabel()).toBe('\u00A0');
  });

  // Stripe stores an amount in the currency's smallest unit, and "divide by
  // 100" is only right for the currencies that have one.
  it('does not assume every currency has cents', () => {
    const { component } = setup(null, () => Promise.resolve(), [
      { priceId: 'price_jpy', currency: 'jpy', unitAmount: 500 },
    ]);

    expect(view(component).priceAmount()).toBe('¥500');
  });
});

/**
 * When the page asks for a Checkout Session to be created ahead of the click.
 *
 * The service decides *whether* — it owns the eligibility rule and the
 * budget — and this component decides *when*, which is the part with a timer
 * in it. Two things have to hold. A session must not be created for a reader
 * still in the middle of choosing a currency, because each one expires the
 * last and spends a slot of the `firestore.rules` volume cap. And the wait
 * must not survive the component, because a timer firing into a page the
 * reader has navigated away from is exactly the leak `CLAUDE.md` §4.4 is
 * about.
 */
describe('PricingComponent pre-created checkout', () => {
  const usd: ProPriceOption = { priceId: 'price_usd', currency: 'usd', unitAmount: 99 };
  const brl: ProPriceOption = { priceId: 'price_brl', currency: 'brl', unitAmount: 590 };

  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('asks for one a second after the currency settles', () => {
    const { prepareCheckout } = setup(null, () => Promise.resolve(), [usd]);
    TestBed.tick();

    vi.advanceTimersByTime(999);
    expect(prepareCheckout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(prepareCheckout).toHaveBeenCalledTimes(1);
  });

  /**
   * The reason for the delay at all. Without it, somebody comparing the two
   * prices before deciding would create a Stripe session per glance — and
   * since each one expires the previous, the only one that survives is the
   * last, which makes every earlier one pure waste of a capped resource.
   */
  it('starts the wait again when the reader changes currency', () => {
    const { prepareCheckout, selectedCurrency } = setup(null, () => Promise.resolve(), [usd, brl]);
    TestBed.tick();

    vi.advanceTimersByTime(900);
    selectedCurrency.set('brl');
    TestBed.tick();
    vi.advanceTimersByTime(900);
    expect(prepareCheckout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(prepareCheckout).toHaveBeenCalledTimes(1);
  });

  /**
   * `authReady()` is false before Firebase's first auth callback, and
   * everything derived from it reads as the signed-out answer meanwhile —
   * which is exactly the state §4.4 says to treat as "not yet" rather than as
   * an answer. Asking here would be asking on behalf of a reader nobody has
   * identified.
   */
  it('waits for auth to resolve before asking for anything', () => {
    const { prepareCheckout } = setup(null, () => Promise.resolve(), [usd], { authReady: false });
    TestBed.tick();

    vi.advanceTimersByTime(5_000);
    expect(prepareCheckout).not.toHaveBeenCalled();
  });

  /**
   * The one page load where `isProUser()` being false does not mean "this
   * reader might buy": they have just bought, and the webhook that will say so
   * is still in flight. Preparing here creates a Stripe session after every
   * completed checkout, for a button that is about to be replaced by "You're
   * subscribed".
   */
  it('asks for nothing on the page Stripe redirects back to', () => {
    const { prepareCheckout } = setup('success', () => Promise.resolve(), [usd]);
    TestBed.tick();

    vi.advanceTimersByTime(5_000);
    expect(prepareCheckout).not.toHaveBeenCalled();
  });

  // A cancelled checkout is the opposite case: they did not buy, the button is
  // still there, and the session is worth having ready for the second attempt.
  it('still asks after a cancelled checkout', () => {
    const { prepareCheckout } = setup('cancelled', () => Promise.resolve(), [usd]);
    TestBed.tick();

    vi.advanceTimersByTime(1_000);
    expect(prepareCheckout).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing on behalf of a subscriber', () => {
    const { prepareCheckout } = setup(null, () => Promise.resolve(), [usd], { isProUser: true });
    TestBed.tick();

    vi.advanceTimersByTime(5_000);
    expect(prepareCheckout).not.toHaveBeenCalled();
  });

  it('asks for nothing until the email is verified', () => {
    const { prepareCheckout } = setup(null, () => Promise.resolve(), [usd], {
      isFullyAuthenticated: false,
    });
    TestBed.tick();

    vi.advanceTimersByTime(5_000);
    expect(prepareCheckout).not.toHaveBeenCalled();
  });

  // Nothing to check out against yet — and asking anyway would create a
  // session for whichever price landed first rather than the one the reader
  // ends up being quoted.
  it('asks for nothing while the catalog is still loading', () => {
    const { prepareCheckout, proPriceOptions } = setup(null, () => Promise.resolve(), []);
    TestBed.tick();

    vi.advanceTimersByTime(5_000);
    expect(prepareCheckout).not.toHaveBeenCalled();

    proPriceOptions.set([usd]);
    TestBed.tick();
    vi.advanceTimersByTime(1_000);
    expect(prepareCheckout).toHaveBeenCalledTimes(1);
  });

  it('does not fire into a page the reader has left', () => {
    const { prepareCheckout } = setup(null, () => Promise.resolve(), [usd]);
    TestBed.tick();

    vi.advanceTimersByTime(900);
    TestBed.resetTestingModule();
    vi.advanceTimersByTime(5_000);

    expect(prepareCheckout).not.toHaveBeenCalled();
  });
});
