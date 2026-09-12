import { TestBed } from '@angular/core/testing';
import {
  PRICING_CACHE_TTL_MS,
  PricingCacheService,
  READY_CHECKOUT_TTL_MS,
} from './pricing-cache.service';

/**
 * The pricing page's browser-side memory.
 *
 * Two things are worth pinning here and nothing else is. The **expiry**,
 * because it is the only thing standing between a Dashboard price change and a
 * reader quoted last year's amount forever. And the **parsing**, because every
 * value this service hands back has been sitting somewhere the reader can
 * edit — `localStorage` is a text field with a devtools UI — so a shape that
 * is trusted rather than checked is a `TypeError` during a page's first render,
 * or a `location.assign` to whatever somebody typed.
 *
 * Driven against jsdom's real `localStorage` rather than a
 * double: the thing under test *is* the serialisation, and a fake store that
 * kept objects would skip the JSON round trip entirely.
 */

const OPTIONS = [
  { priceId: 'price_usd', currency: 'usd', unitAmount: 99 },
  { priceId: 'price_brl', currency: 'brl', unitAmount: 590 },
];

const READY = {
  uid: 'user-1',
  priceId: 'price_usd',
  url: 'https://checkout.stripe.com/c/pay/cs_test_1',
  readyAt: 1_000_000,
};

function service(): PricingCacheService {
  return TestBed.inject(PricingCacheService);
}

describe('PricingCacheService', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.configureTestingModule({});
  });

  // Mocks first, and the order is load-bearing: the storage tests below
  // replace the `localStorage` accessor with one that throws, so a `clear()`
  // running before the restore takes the whole `afterEach` down with it —
  // including `resetTestingModule`, which then fails the *next spec file* with
  // "the test module has already been instantiated". Measured, not guessed.
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    TestBed.resetTestingModule();
  });

  describe('the catalog', () => {
    it('reads back what it wrote', () => {
      const cache = service();
      cache.writeCatalog(OPTIONS, 1_000);

      expect(cache.readCatalog(1_000)).toEqual(OPTIONS);
    });

    it('has nothing to say before anything has been written', () => {
      expect(service().readCatalog()).toBeNull();
    });

    // The whole point of the TTL: a price edited in the Stripe Dashboard
    // reaches a returning visitor rather than being remembered indefinitely.
    it('expires a day after it was stored', () => {
      const cache = service();
      cache.writeCatalog(OPTIONS, 1_000);

      expect(cache.readCatalog(1_000 + PRICING_CACHE_TTL_MS)).toEqual(OPTIONS);
      expect(cache.readCatalog(1_000 + PRICING_CACHE_TTL_MS + 1)).toBeNull();
    });

    /**
     * A clock that has moved backwards — a timezone fix, an NTP correction —
     * makes every stored entry look like it came from the future. Treating
     * that as expiry would throw away a perfectly good catalog for a reason
     * that has nothing to do with the catalog, which is the same call
     * `GamePersistenceService` makes about a saved game.
     */
    it('keeps an entry stamped in the future rather than treating it as expired', () => {
      const cache = service();
      cache.writeCatalog(OPTIONS, 5_000);

      expect(cache.readCatalog(1_000)).toEqual(OPTIONS);
    });

    /**
     * All-or-nothing, because this list is *ordered* and the order decides
     * which currency the page opens on when no country does. Dropping the one
     * unreadable entry would silently change that answer.
     */
    it('discards the whole catalog when one entry is unusable', () => {
      localStorage.setItem(
        'trivia-pricing-catalog',
        JSON.stringify({
          storedAt: 1_000,
          options: [OPTIONS[0], { priceId: 'price_brl', currency: '', unitAmount: 590 }],
        }),
      );

      expect(service().readCatalog(1_000)).toBeNull();
    });

    // Stripe leaves `unit_amount` null on a price whose amount is decided at
    // checkout. The page shows a placeholder for it, so it has to survive the
    // round trip as `null` rather than being rejected with the bad shapes.
    it('keeps a price with no amount, and rejects one with a nonsense amount', () => {
      const cache = service();
      cache.writeCatalog([{ priceId: 'price_x', currency: 'usd', unitAmount: null }], 1_000);
      expect(cache.readCatalog(1_000)).toEqual([
        { priceId: 'price_x', currency: 'usd', unitAmount: null },
      ]);

      localStorage.setItem(
        'trivia-pricing-catalog',
        JSON.stringify({
          storedAt: 1_000,
          options: [{ priceId: 'price_x', currency: 'usd', unitAmount: 'free' }],
        }),
      );
      expect(cache.readCatalog(1_000)).toBeNull();
    });

    it('ignores a value that is not JSON at all', () => {
      localStorage.setItem('trivia-pricing-catalog', 'not json');

      expect(service().readCatalog()).toBeNull();
    });

    it('ignores an empty catalog, which is not something to render', () => {
      localStorage.setItem(
        'trivia-pricing-catalog',
        JSON.stringify({ storedAt: Date.now(), options: [] }),
      );

      expect(service().readCatalog()).toBeNull();
    });
  });

  describe('the country', () => {
    it('reads back a country it wrote, normalised', () => {
      const cache = service();
      cache.writeCountry('br', 1_000);

      expect(cache.readCountry(1_000)).toBe('BR');
    });

    it('expires on the same day-long clock as the catalog', () => {
      const cache = service();
      cache.writeCountry('BR', 1_000);

      expect(cache.readCountry(1_000 + PRICING_CACHE_TTL_MS + 1)).toBeNull();
    });

    it('refuses anything that is not a two-letter code', () => {
      localStorage.setItem(
        'trivia-pricing-country',
        JSON.stringify({ storedAt: Date.now(), country: 'Brazil' }),
      );

      expect(service().readCountry()).toBeNull();
    });
  });

  describe('the pre-created checkout', () => {
    it('survives a reload', () => {
      const cache = service();
      cache.writeReadyCheckout(READY);

      expect(cache.readReadyCheckout(READY.readyAt)).toEqual(READY);
    });

    /**
     * The entry is device-wide rather than tab-wide, and that is the whole
     * point: Stripe allows this customer one open session, so a second tab
     * that could not see the first one's would pre-create and kill it. Pinned
     * on the store the two tabs would actually share.
     */
    it('is stored where every tab on this device can see it', () => {
      service().writeReadyCheckout(READY);

      expect(localStorage.getItem('trivia-checkout-ready')).not.toBeNull();
      expect(sessionStorage.getItem('trivia-checkout-ready')).toBeNull();
    });

    // What lets a caller stop spending Stripe sessions it will never find again.
    it('reports whether it could actually store the entry', () => {
      expect(service().writeReadyCheckout(READY)).toBe(true);

      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      });
      expect(service().writeReadyCheckout(READY)).toBe(false);
    });

    it('is cleared on request', () => {
      const cache = service();
      cache.writeReadyCheckout(READY);
      cache.clearReadyCheckout();

      expect(cache.readReadyCheckout(READY.readyAt)).toBeNull();
    });

    /**
     * Twenty hours, not twenty-four. Stripe expires an open Checkout Session
     * exactly a day after it is created and the URL stops working at that
     * moment, so the margin is what covers the gap between the clock that
     * stamped this entry (the reader's) and the clock that enforces the
     * expiry (Stripe's).
     */
    it('stops being usable four hours before Stripe would expire it', () => {
      const cache = service();
      cache.writeReadyCheckout(READY);

      expect(cache.readReadyCheckout(READY.readyAt + READY_CHECKOUT_TTL_MS)).toEqual(READY);
      expect(cache.readReadyCheckout(READY.readyAt + READY_CHECKOUT_TTL_MS + 1)).toBeNull();
    });

    /**
     * The stored URL is handed to `location.assign`. Nothing but this app
     * writes the entry, but it is read back out of a store the reader can
     * edit, and a `javascript:` URL reaching that call is the difference
     * between a cache and a scripting vector.
     */
    it('refuses a URL that is not an ordinary http(s) address', () => {
      for (const url of ['javascript:alert(1)', 'data:text/html,hi', '/pricing#relative', '']) {
        localStorage.setItem('trivia-checkout-ready', JSON.stringify({ ...READY, url }));
        expect(service().readReadyCheckout(READY.readyAt), url).toBeNull();
      }
    });

    // The mock-mode URL the e2e suite drives is a same-origin `http://…`
    // (`functions/src/checkout-sessions.ts`), so `https` alone would refuse
    // the only checkout that can be tested end to end.
    it('accepts the same-origin http URL mock mode writes', () => {
      const url = 'http://localhost:4200/pricing#mock-checkout-session-1-2';
      localStorage.setItem('trivia-checkout-ready', JSON.stringify({ ...READY, url }));

      expect(service().readReadyCheckout(READY.readyAt)?.url).toBe(url);
    });

    it('refuses an entry missing the account it belongs to', () => {
      localStorage.setItem('trivia-checkout-ready', JSON.stringify({ ...READY, uid: '' }));

      expect(service().readReadyCheckout(READY.readyAt)).toBeNull();
    });
  });

  /**
   * Safari's private mode throws on the `window.localStorage` *accessor*, not
   * on the call that follows — so a guard written around `getItem` alone is a
   * guard around the wrong statement, and the symptom is a pricing page that
   * throws during construction instead of one that is merely a little slower.
   */
  describe('when storage is unavailable', () => {
    it('reads as empty and writes without throwing', () => {
      const denied = () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      };
      vi.spyOn(window, 'localStorage', 'get').mockImplementation(denied);
      vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(denied);

      const cache = service();
      expect(() => cache.writeCatalog(OPTIONS)).not.toThrow();
      expect(() => cache.writeCountry('BR')).not.toThrow();
      expect(() => cache.writeReadyCheckout(READY)).not.toThrow();
      expect(() => cache.clearReadyCheckout()).not.toThrow();
      expect(cache.readCatalog()).toBeNull();
      expect(cache.readCountry()).toBeNull();
      expect(cache.readReadyCheckout()).toBeNull();
    });

    it('survives a quota refusal on the write itself', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      });

      expect(() => service().writeCatalog(OPTIONS)).not.toThrow();
    });
  });
});
