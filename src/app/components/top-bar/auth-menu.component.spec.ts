import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AccountService } from '../../services/account.service';
import { AuthService } from '../../services/auth.service';
import { SubscriptionError, SubscriptionService } from '../../services/subscription.service';
import { AuthMenuComponent } from './auth-menu.component';

/**
 * What "Manage subscription" says when the billing portal does not open — the
 * same contract `PricingComponent` has with `SubscriptionService`
 * (`pricing.component.spec.ts`): a cause the service verified is shown as is,
 * and only a failure it could not explain falls back to the generic line.
 *
 * Constructed in an injection context rather than rendered: the auth menu's
 * template is the whole sign-in surface, and the behaviour under test is one
 * `catch` block.
 */
function setup(openBillingPortal: () => Promise<void>) {
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: { user: signal(null) } },
      { provide: SubscriptionService, useValue: { isProUser: signal(true), openBillingPortal } },
      { provide: AccountService, useValue: {} },
    ],
  });
  return TestBed.runInInjectionContext(() => new AuthMenuComponent()) as unknown as {
    manageSubscription(): Promise<void>;
    errorMessage(): string | null;
    isOpeningPortal(): boolean;
  };
}

describe('AuthMenuComponent billing portal failure message', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('shows the cause the service verified, word for word', async () => {
    const component = setup(() =>
      Promise.reject(new SubscriptionError('Timed out waiting for the billing portal to open.')),
    );

    await component.manageSubscription();

    expect(component.errorMessage()).toBe('Timed out waiting for the billing portal to open.');
    expect(component.isOpeningPortal()).toBe(false);
  });

  it('stays generic for a failure the service could not explain', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('Failed to fetch');
    const component = setup(() => Promise.reject(error));

    await component.manageSubscription();

    expect(component.errorMessage()).toBe('Could not open the billing portal. Please try again.');
    expect(component.isOpeningPortal()).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), error);
  });
});
