import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { DonationDialogStateService } from '../../services/donation-dialog-state.service';
import { DonationService, type DonationPreset } from '../../services/donation.service';
import { SubscriptionError } from '../../services/session-handshake.service';
import { DonationDialogComponent } from './donation-dialog.component';

/**
 * What this pins is the part of the dialog that is a *decision* rather than
 * markup: which amounts are offered, in which currency, what a signed-out
 * visitor is told before they pay, and what happens when the catalog is empty.
 *
 * The service is a double, because everything it does is covered directly in
 * `donation.service.spec.ts` and none of it is what this file is about. What
 * cannot be covered here at all is focus and the Tab trap — jsdom implements
 * neither `inert` nor visibility, and `offsetParent` not at all (`CLAUDE.md`
 * §4.4/§4.5) — so those live in the Playwright spec.
 */

const usdPresets: DonationPreset[] = [
  { priceId: 'price_small', currency: 'usd', unitAmount: 200 },
  { priceId: 'price_medium', currency: 'usd', unitAmount: 500 },
  { priceId: 'price_large', currency: 'usd', unitAmount: 1000 },
];

function donationServiceStub(
  overrides: {
    presets?: DonationPreset[];
    currencies?: string[];
    selectedCurrency?: string | null;
    selectedPriceId?: string | null;
    isGuest?: boolean;
    catalogResolved?: boolean;
    isUnavailable?: boolean;
  } = {},
) {
  const presets = signal<readonly DonationPreset[]>(overrides.presets ?? usdPresets);
  const selectedPriceId = signal<string | null>(overrides.selectedPriceId ?? 'price_medium');
  return {
    presets,
    currencies: signal<readonly string[]>(overrides.currencies ?? ['usd']),
    selectedCurrency: signal<string | null>(overrides.selectedCurrency ?? 'usd'),
    selectedPriceId,
    isGuest: signal(overrides.isGuest ?? false),
    catalogResolved: signal(overrides.catalogResolved ?? true),
    isUnavailable: signal(overrides.isUnavailable ?? false),
    loadPresets: vi.fn(() => Promise.resolve()),
    selectCurrency: vi.fn(),
    selectPreset: vi.fn((priceId: string) => selectedPriceId.set(priceId)),
    startDonation: vi.fn(() => Promise.resolve()),
  };
}

function render(service: ReturnType<typeof donationServiceStub>, open = true) {
  TestBed.configureTestingModule({
    providers: [{ provide: DonationService, useValue: service }],
  });
  if (open) {
    TestBed.inject(DonationDialogStateService).open();
  }
  const fixture = TestBed.createComponent(DonationDialogComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('DonationDialogComponent', () => {
  it('renders nothing at all until it is opened', () => {
    const { host } = render(donationServiceStub(), false);

    expect(host.querySelector('[data-cy="donation-dialog"]')).toBeNull();
  });

  it('asks for the catalog on the first open, and not before', async () => {
    const service = donationServiceStub();
    const { fixture } = render(service, false);
    expect(service.loadPresets).not.toHaveBeenCalled();

    TestBed.inject(DonationDialogStateService).open();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(service.loadPresets).toHaveBeenCalledTimes(1);
  });

  /*
   * And asks again on the next open. A flag remembering the first one would
   * remember a *failed* read just as faithfully, which is the caching of a
   * rejection `CLAUDE.md` §4.4 forbids: one blocked request would leave the
   * dialog resolved with no presets, telling every later open that donations
   * are unavailable when they are not. Re-asking costs nothing when the read
   * worked — `DonationService` memoises a success and drops only a failure.
   */
  it('asks again on a later open, so one failed read is not the tab\u2019s last word', async () => {
    const service = donationServiceStub();
    const { fixture } = render(service, false);
    const dialogState = TestBed.inject(DonationDialogStateService);

    dialogState.open();
    fixture.detectChanges();
    await fixture.whenStable();

    dialogState.close();
    fixture.detectChanges();
    await fixture.whenStable();

    dialogState.open();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(service.loadPresets).toHaveBeenCalledTimes(2);
  });

  it('quotes the catalog’s own amounts, formatted in the currency', () => {
    const { host } = render(donationServiceStub());

    const labels = [...host.querySelectorAll('[data-cy="donation-amounts"] label')].map((label) =>
      label.textContent?.trim(),
    );
    expect(labels).toEqual(['$2.00', '$5.00', '$10.00']);
  });

  it('renders each amount in the currency’s own locale, not the reader’s', () => {
    const { host } = render(
      donationServiceStub({
        presets: [{ priceId: 'price_brl', currency: 'brl', unitAmount: 1000 }],
        currencies: ['brl'],
        selectedCurrency: 'brl',
        selectedPriceId: 'price_brl',
      }),
    );

    // Non-breaking space between the symbol and the number, and a comma for
    // the decimal — pt-BR conventions, whatever the runner's locale is.
    expect(host.querySelector('[data-cy="donation-amounts"] label')?.textContent?.trim()).toBe(
      'R$ 10,00',
    );
  });

  it('groups the amounts as a labelled radiogroup', () => {
    const { host } = render(donationServiceStub());
    const group = host.querySelector('[data-cy="donation-amounts"]');

    // Without both, the group's label is never conveyed (`CLAUDE.md` §4.5).
    expect(group?.getAttribute('role')).toBe('radiogroup');
    expect(group?.getAttribute('aria-labelledby')).toBe('donation-amount-label');
    expect(host.querySelector('#donation-amount-label')).not.toBeNull();
  });

  it('checks the selected amount and nothing else', () => {
    const { host } = render(donationServiceStub());
    const checked = [...host.querySelectorAll<HTMLInputElement>('input[name="donation-amount"]')]
      .filter((radio) => radio.checked)
      .map((radio) => radio.getAttribute('data-cy'));

    expect(checked).toEqual(['donation-amount-price_medium']);
  });

  it('tells the service which amount was chosen', () => {
    const service = donationServiceStub();
    const { host, fixture } = render(service);

    host
      .querySelector<HTMLInputElement>('[data-cy="donation-amount-price_large"]')
      ?.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(service.selectPreset).toHaveBeenCalledWith('price_large');
  });

  it('offers no currency switch when there is only one currency', () => {
    const { host } = render(donationServiceStub());

    expect(host.querySelector('app-currency-switch')).toBeNull();
    expect(host.querySelector('[data-cy="donation-currency"]')?.textContent?.trim()).toBe('USD');
  });

  it('offers the switch once the catalog carries two, under its own test ids', () => {
    const { host } = render(
      donationServiceStub({ currencies: ['usd', 'brl'], selectedCurrency: 'brl' }),
    );

    // Prefixed, because the pricing page's own switch can be on screen at the
    // same time — the footer is on `/pricing` too (`CLAUDE.md` §4.6).
    expect(host.querySelector('[data-cy="donation-currency-choice"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-cy="donation-currency-brl"]')?.checked).toBe(
      true,
    );
    expect(host.querySelector('[data-cy="currency-choice"]')).toBeNull();
  });

  it('tells the service which currency was chosen', () => {
    const service = donationServiceStub({ currencies: ['usd', 'brl'], selectedCurrency: 'usd' });
    const { host, fixture } = render(service);

    host
      .querySelector<HTMLInputElement>('[data-cy="donation-currency-brl"]')
      ?.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(service.selectCurrency).toHaveBeenCalledWith('brl');
  });

  /*
   * The guest notice says what is true today and no more: there is no
   * supporter badge in this release, so promising one would be a claim the app
   * cannot honour (`CLAUDE.md` §4.0's rule applied to the UI).
   */
  it('warns a signed-out visitor that the donation cannot be credited', () => {
    const { host } = render(donationServiceStub({ isGuest: true }));
    const notice = host.querySelector('[data-cy="donation-guest-notice"]');

    expect(notice?.textContent).toContain("won't be recorded against an account");
    expect(notice?.textContent).not.toMatch(/badge/i);
  });

  it('shows no such notice to a real account', () => {
    const { host } = render(donationServiceStub({ isGuest: false }));

    expect(host.querySelector('[data-cy="donation-guest-notice"]')).toBeNull();
  });

  it('names the amount on the button, so nobody pays without seeing it', () => {
    const { host } = render(donationServiceStub());

    expect(host.querySelector('[data-cy="donate"]')?.textContent?.trim()).toContain('Donate $5.00');
  });

  /*
   * What an environment looks like before the donation Product exists in the
   * Stripe Dashboard. The CTA still opens the dialog and nothing throws — the
   * dialog simply says so, and offers nothing to click.
   */
  it('degrades honestly when the catalog holds no donation price', () => {
    const { host } = render(donationServiceStub({ isUnavailable: true, presets: [] }));

    expect(host.querySelector('[data-cy="donation-unavailable"]')?.textContent).toContain(
      "Donations aren't available right now",
    );
    expect(host.querySelector('[data-cy="donate"]')).toBeNull();
  });

  // Loading and empty are different states, and the alarming one must not be
  // shown while the answer is still on its way (`CLAUDE.md` §4.4).
  it('says nothing about availability while the catalog is still loading', () => {
    const { host } = render(
      donationServiceStub({ catalogResolved: false, isUnavailable: false, presets: [] }),
    );

    expect(host.querySelector('[data-cy="donation-unavailable"]')).toBeNull();
    expect(host.querySelector('[data-cy="donation-amounts"]')).toBeNull();
    // Three placeholder cells, so the button below does not move when the real
    // amounts arrive.
    expect(host.querySelectorAll('.grid.grid-cols-3 > span')).toHaveLength(3);
  });

  it('starts the donation and stays quiet while it redirects', async () => {
    const service = donationServiceStub();
    const { host, fixture } = render(service);

    host.querySelector<HTMLButtonElement>('[data-cy="donate"]')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(service.startDonation).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-cy="donation-error"]')).toBeNull();
  });

  it('shows the service’s own message when the donation cannot be started', async () => {
    const service = donationServiceStub();
    service.startDonation.mockRejectedValue(
      new SubscriptionError('Your account is already set up to pay in BRL.'),
    );
    const { host, fixture } = render(service);

    host.querySelector<HTMLButtonElement>('[data-cy="donate"]')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    // Announced as well as rendered: the permanent `role="status"` region is
    // what a screen reader hears (`CLAUDE.md` §4.5).
    expect(host.querySelector('[role="status"]')?.textContent).toContain('already set up to pay');
  });

  it('closes on its own close button', () => {
    const { host, fixture } = render(donationServiceStub());

    host.querySelector<HTMLButtonElement>('[data-cy="close-donation-dialog"]')?.click();
    fixture.detectChanges();

    expect(TestBed.inject(DonationDialogStateService).isOpen()).toBe(false);
    expect(host.querySelector('[data-cy="donation-dialog"]')).toBeNull();
  });

  it('is a labelled modal dialog', () => {
    const { host } = render(donationServiceStub());
    const dialog = host.querySelector('[data-cy="donation-dialog"]');

    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(host.querySelector(`#${dialog?.getAttribute('aria-labelledby')}`)).not.toBeNull();
  });
});
