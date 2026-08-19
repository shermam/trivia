import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { SubscriptionService } from '../../services/subscription.service';
import { PricingComponent } from './pricing.component';

/**
 * This constructor call is the entire in-app trigger for the post-checkout
 * activation poll — the only replacement for what the subscription
 * `onSnapshot` used to do for free when a subscriber came back from Stripe
 * (`BACKLOG.md` item 2). Until this spec existed, deleting the call broke
 * nothing: `subscription.service.spec.ts` calls `awaitProActivation()`
 * directly, which proves the method works but not that anything ever invokes
 * it, and `pricing.cy.ts` never loads `?checkout=success` at all.
 *
 * The gate matters as much as the call. Polling on every visit to `/pricing`
 * would spend up to twenty reads on a page most visitors reach by curiosity,
 * and polling on `cancelled` would wait twenty seconds for a subscription
 * nobody bought.
 */

function setup(checkout: string | null) {
  const awaitProActivation = vi.fn(() => Promise.resolve());
  TestBed.configureTestingModule({
    providers: [
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: new Map([['checkout', checkout]]) } },
      },
      { provide: Router, useValue: { navigate: vi.fn() } },
      {
        provide: SubscriptionService,
        useValue: { isProUser: signal(false), awaitProActivation },
      },
      {
        provide: AuthService,
        useValue: {
          authReady: signal(true),
          isAnonymous: signal(false),
          isFullyAuthenticated: signal(true),
        },
      },
    ],
  });
  // Constructed inside an injection context rather than rendered: the
  // behaviour under test is entirely in the constructor, and rendering the
  // whole pricing template would drag in half the app to observe one call.
  const component = TestBed.runInInjectionContext(() => new PricingComponent());
  return { component, awaitProActivation };
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
