import { TestBed } from '@angular/core/testing';
import { GeoService } from './geo.service';
import { RegionService } from './region.service';

/**
 * `FEAT-028`. The service holds one distinction and it is the whole reason the
 * feature was designed this way: **the app may guess where a player is, and
 * only the player may declare it.**
 *
 * A guess is component state that preselects a dropdown and disappears with
 * the page. A declaration is written to the device and published on a public
 * board. Nothing here may quietly turn the first into the second — a stored
 * inference would be indistinguishable from a stated country a day later, and
 * the Privacy Policy says in as many words that nothing inferred is kept.
 */

function configure(geoAnswer: string | null | Promise<string | null>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: GeoService, useValue: { resolveCountry: () => Promise.resolve(geoAnswer) } },
    ],
  });
  return TestBed.inject(RegionService);
}

const STORAGE_KEY = 'trivia_region';

describe('RegionService', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('starts with no declaration when the device holds none', () => {
    expect(configure(null).declaredRegion()).toBeNull();
  });

  it('reads a stored declaration at construction', () => {
    localStorage.setItem(STORAGE_KEY, 'BR');

    expect(configure(null).declaredRegion()).toBe('BR');
  });

  /*
   * The stored value has been sitting somewhere the reader can edit, so it is
   * validated on the way out as well as on the way in. A code the rules refuse
   * would otherwise reach the picker as a preselected country whose save fails
   * with nothing the screen can explain.
   */
  it.each(['ZZ', 'XK', 'br', 'BRA', '', 'Brazil'])(
    'ignores a stored value that is not a country the rules accept (%s)',
    (stored) => {
      localStorage.setItem(STORAGE_KEY, stored);

      expect(configure(null).declaredRegion()).toBeNull();
    },
  );

  it('remembers a declaration on the device', () => {
    const service = configure(null);

    service.declareRegion('PT');

    expect(service.declaredRegion()).toBe('PT');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('PT');
  });

  // "Prefer not to say" has to leave the reader in the same state as one who
  // has never chosen: nothing stored, no regional entry written.
  it('clears the stored value when the declaration is withdrawn', () => {
    const service = configure(null);
    service.declareRegion('PT');

    service.declareRegion(null);

    expect(service.declaredRegion()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('refuses to store a code the rules would reject', () => {
    const service = configure(null);

    service.declareRegion('ZZ');

    expect(service.declaredRegion()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  /*
   * Private windows and blocked site data throw on the `localStorage` accessor
   * itself, not on the call that follows. Losing the memory must cost the
   * reader one re-pick next time, never a screen that will not render.
   */
  it('degrades to an unremembered declaration when storage throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });

    try {
      const service = configure(null);
      expect(service.declaredRegion()).toBeNull();

      expect(() => service.declareRegion('BR')).not.toThrow();
      expect(service.declaredRegion()).toBe('BR');
    } finally {
      Object.defineProperty(window, 'localStorage', descriptor!);
    }
  });

  it('offers the server’s country as a guess', async () => {
    await expect(configure('BR').inferredRegion()).resolves.toBe('BR');
  });

  it('offers nothing when the chain cannot say', async () => {
    await expect(configure(null).inferredRegion()).resolves.toBeNull();
  });

  /*
   * `GeoService` accepts any two-letter code, deliberately — the pricing page
   * maps everything that is not `BR` to one currency, so an unrecognised code
   * costs it nothing. A leaderboard cannot be so relaxed: a board named `ZZ`
   * is refused by the rules, so an unrecognised guess must not be preselected.
   */
  it('discards a guess the rules would refuse rather than preselecting it', async () => {
    await expect(configure('ZZ').inferredRegion()).resolves.toBeNull();
  });

  // The property the whole design rests on.
  it('never writes an inference to the device', async () => {
    const service = configure('BR');

    await service.inferredRegion();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(service.declaredRegion()).toBeNull();
  });
});
