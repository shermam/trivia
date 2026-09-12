import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { environment } from '../../../environments/environment';
import { buildLabel } from '../../build-info';
import { DonationDialogStateService } from '../../services/donation-dialog-state.service';
import { DonationService } from '../../services/donation.service';
import { FooterComponent } from './footer.component';

/**
 * The donation service is stubbed rather than run: everything it does is
 * covered in `donation.service.spec.ts`, and the real one would try to read a
 * catalog over `fetch` the moment the dialog opened.
 */
const donationServiceStub = {
  presets: () => [],
  currencies: () => [],
  selectedCurrency: () => null,
  selectedPriceId: () => null,
  isGuest: () => false,
  catalogResolved: () => false,
  isUnavailable: () => false,
  loadPresets: () => Promise.resolve(),
  selectCurrency: () => undefined,
  selectPreset: () => undefined,
  startDonation: () => Promise.resolve(),
};

function render() {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: DonationService, useValue: donationServiceStub }],
  });
  const fixture = TestBed.createComponent(FooterComponent);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/**
 * Renders the footer as it would be on `url`.
 *
 * The URL is set on the `Router` before the component is created, because the
 * suppression has to hold from the first frame: a reader who lands directly on
 * `/play` produces no `NavigationEnd` at all, which is exactly the case a
 * naive implementation gets wrong.
 */
function renderAt(url: string) {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: DonationService, useValue: donationServiceStub }],
  });
  const router = TestBed.inject(Router);
  vi.spyOn(router, 'url', 'get').mockReturnValue(url);
  const fixture = TestBed.createComponent(FooterComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

/**
 * The build identity is a diagnostic, and a diagnostic nobody can reach is
 * worth nothing — which is the whole reason this has a spec at all. Two
 * carriers, on two elements, and the failure mode for each is silent: a
 * dropped `title` leaves the tooltip gone with the page looking identical, and
 * a dropped `sr-only` span leaves it unreachable by anyone not using a mouse,
 * which nothing about the rendered page would reveal.
 */
describe('FooterComponent build identity', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('carries the build on the brand name as a hover tooltip', () => {
    const brand = render().querySelector<HTMLElement>('[data-cy="footer-build"]');

    expect(brand?.textContent?.trim()).toBe('Trivimind');
    expect(brand?.getAttribute('title')).toBe(buildLabel(environment.environmentLabel));
  });

  it('also puts the build in the accessibility tree, not only in the tooltip', () => {
    // `title` is not reachable by keyboard and its screen-reader support is
    // inconsistent, so the tooltip alone would hide this from exactly the
    // people who cannot hover.
    const host = render();
    const spoken = host.querySelector<HTMLElement>('.sr-only');

    expect(spoken?.textContent).toContain(buildLabel(environment.environmentLabel));
  });

  it('keeps the two on separate elements', () => {
    // Same element would make the title an accessible *description* of text
    // that already says it, which some screen readers announce twice.
    const brand = render().querySelector<HTMLElement>('[data-cy="footer-build"]');

    expect(brand?.querySelector('.sr-only')).toBeNull();
    expect(brand?.classList.contains('sr-only')).toBe(false);
  });

  it('still renders the copyright line it hangs off', () => {
    expect(render().textContent).toContain(`${new Date().getFullYear()}`);
  });
});

/**
 * The donation CTA, and the one rule about it that is a product decision
 * rather than styling: it is excluded from the active quiz round outright
 * (`FEAT-013` §1). Nothing else in the suite would notice it reappearing
 * there — the route renders fine either way.
 */
describe('FooterComponent donation CTA', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('offers "Buy me a coffee" on an ordinary screen', () => {
    const { host } = renderAt('/');

    expect(host.querySelector('[data-cy="donate-cta"]')?.textContent).toContain('Buy me a coffee');
  });

  // Removed rather than hidden, so it is out of the tab order too.
  it('is absent during a quiz round', () => {
    const { host } = renderAt('/play');

    expect(host.querySelector('[data-cy="donate-cta"]')).toBeNull();
  });

  it('is absent on a quiz round reached with a query string', () => {
    const { host } = renderAt('/play?embed=1');

    expect(host.querySelector('[data-cy="donate-cta"]')).toBeNull();
  });

  it('announces the dialog it opens', () => {
    const { host } = renderAt('/');
    const cta = host.querySelector('[data-cy="donate-cta"]');

    // A disclosure trigger needs all three (`CLAUDE.md` §4.5), and the panel
    // it names has to be the dialog itself.
    expect(cta?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(cta?.getAttribute('aria-expanded')).toBe('false');
    expect(cta?.getAttribute('aria-controls')).toBe('donation-dialog');
  });

  /*
   * `await fixture.whenStable()` rather than `detectChanges()` alone: the
   * dialog is behind an `@defer`, so opening it fetches a chunk before there
   * is anything to assert on. TestBed plays defer blocks through as the
   * browser does, which is what makes this test cover the real thing.
   */
  it('opens the dialog it hosts, and says so on the trigger', async () => {
    const { host, fixture } = renderAt('/');

    host.querySelector<HTMLButtonElement>('[data-cy="donate-cta"]')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(TestBed.inject(DonationDialogStateService).isOpen()).toBe(true);
    expect(host.querySelector('[data-cy="donation-dialog"]')).not.toBeNull();
    expect(host.querySelector('[data-cy="donate-cta"]')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  // Mounted here and nowhere else, so two copies of a `role="dialog"` can
  // never be on the page at once.
  it('hosts exactly one donation dialog', async () => {
    const { host, fixture } = renderAt('/');
    TestBed.inject(DonationDialogStateService).open();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(host.querySelectorAll('[data-cy="donation-dialog"]')).toHaveLength(1);
  });

  // The other half of the `@defer`: nothing of the dialog is in the DOM, and
  // nothing of it is in the initial bundle, until somebody asks for it.
  it('renders no dialog at all until it is opened', () => {
    const { host } = renderAt('/');

    expect(host.querySelector('[data-cy="donation-dialog"]')).toBeNull();
  });
});
