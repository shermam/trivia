import { TestBed } from '@angular/core/testing';
import { AuthMenuStateService } from './auth-menu-state.service';
import { AuthService } from './auth.service';

/**
 * The service is three lines of signal state and one call, and the call is the
 * reason it has a spec.
 *
 * Since `FEAT-017` §3.2 the Firebase bootstrap starts on the first idle moment
 * after paint rather than from the root component's constructor, and on `/`,
 * `/privacy` and `/terms` nothing else asks for auth at all. Opening the auth
 * menu is therefore the one gesture that can arrive before the SDK does, and
 * the panel it opens renders "Loading…" in a `w-80` box until `authReady()`
 * flips — then grows into the whole sign-in form. Kicking the bootstrap here is
 * what keeps that from being a component that changes size on the interaction
 * path (`CLAUDE.md` §4.4).
 */
function setup(ensureSignedIn = vi.fn(() => Promise.resolve())) {
  TestBed.configureTestingModule({
    providers: [{ provide: AuthService, useValue: { ensureSignedIn } }],
  });
  return { service: TestBed.inject(AuthMenuStateService), ensureSignedIn };
}

describe('AuthMenuStateService', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('starts the auth bootstrap when the menu is opened', () => {
    const { service, ensureSignedIn } = setup();

    service.open();

    expect(service.isOpen()).toBe(true);
    expect(ensureSignedIn).toHaveBeenCalledTimes(1);
  });

  it('starts it when the menu is toggled open, and not again on the way closed', () => {
    const { service, ensureSignedIn } = setup();

    service.toggle();
    expect(service.isOpen()).toBe(true);
    expect(ensureSignedIn).toHaveBeenCalledTimes(1);

    service.toggle();
    expect(service.isOpen()).toBe(false);
    expect(ensureSignedIn).toHaveBeenCalledTimes(1);
  });

  it('does not start it just to close the menu', () => {
    const { service, ensureSignedIn } = setup();

    service.close();

    expect(ensureSignedIn).not.toHaveBeenCalled();
  });

  /**
   * The panel is open before auth is, deliberately: `ensureSignedIn()` is fired
   * and not awaited, so a slow — or permanently stalled — bootstrap delays the
   * dialog by nothing. Its own "Loading…" state is what covers the wait.
   */
  it('opens without waiting for the bootstrap it started', () => {
    const { service } = setup(vi.fn(() => new Promise<void>(() => undefined)));

    service.open();

    expect(service.isOpen()).toBe(true);
  });
});
