import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { DonationDialogStateService } from './donation-dialog-state.service';

/**
 * Two lines of signal state and one call, and the call is why this has a spec.
 *
 * A donation is a document owned by the visitor's uid, and since `FEAT-017`
 * §3.2 that uid arrives on the first idle moment after paint rather than
 * during boot — while the footer's "Buy me a coffee" button is on `/` from
 * first paint. Starting the bootstrap when the dialog opens is what turns a
 * click that would have been refused ("still starting up") into one that has
 * nothing left to wait for. `DonationService.startDonation()` awaits the same
 * call, so this is the optimisation and that is the guarantee.
 */
function setup(ensureSignedIn = vi.fn(() => Promise.resolve())) {
  TestBed.configureTestingModule({
    providers: [{ provide: AuthService, useValue: { ensureSignedIn } }],
  });
  return { service: TestBed.inject(DonationDialogStateService), ensureSignedIn };
}

describe('DonationDialogStateService', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('starts the auth bootstrap when the dialog opens', () => {
    const { service, ensureSignedIn } = setup();

    service.open();

    expect(service.isOpen()).toBe(true);
    expect(ensureSignedIn).toHaveBeenCalledTimes(1);
  });

  it('does not start it just to close the dialog', () => {
    const { service, ensureSignedIn } = setup();

    service.close();

    expect(service.isOpen()).toBe(false);
    expect(ensureSignedIn).not.toHaveBeenCalled();
  });

  it('opens without waiting for the bootstrap it started', () => {
    const { service } = setup(vi.fn(() => new Promise<void>(() => undefined)));

    service.open();

    expect(service.isOpen()).toBe(true);
  });
});
