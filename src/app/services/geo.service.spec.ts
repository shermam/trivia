import { TestBed } from '@angular/core/testing';
import {
  GEO_ENDPOINT,
  GEO_TIMEOUT_MS,
  GeoService,
  countryFromGeoBody,
  countryFromTimeZone,
} from './geo.service';
import { PricingCacheService } from './pricing-cache.service';

/**
 * The country chain, one source at a time.
 *
 * Two things here cannot be driven through the real environment and are
 * therefore stubbed rather than exercised: `fetch`, because there is no
 * `/api/geo` under Vitest and never will be — the endpoint only exists behind
 * a Firebase Hosting rewrite — and `Intl.DateTimeFormat`, because the machine
 * running the suite has whatever time zone it has and a test that read it
 * would be asserting about the runner. What each stub stands in for is a real
 * shape a real deployment produces, and the ones that matter most are the
 * *failures*: an HTML body from a deployment where the function is not
 * deployed yet, and a request that never comes back.
 *
 * `pricing.spec.ts` covers the same chain against a real browser, where the
 * time zone is a Playwright context option rather than a stub.
 */

/** A `fetch` double answering one response, and recording what it was asked. */
function answering(response: {
  status?: number;
  contentType?: string | null;
  body?: unknown;
  bodyIsNotJson?: boolean;
}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      status: response.status ?? 200,
      headers: new Headers(
        response.contentType === null
          ? {}
          : { 'Content-Type': response.contentType ?? 'application/json' },
      ),
      json: () =>
        response.bodyIsNotJson
          ? Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0'))
          : Promise.resolve(response.body),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** A `fetch` double that rejects, as a timeout or an offline tab does. */
function failingWith(error: Error) {
  const fetchMock = vi.fn(() => Promise.reject(error));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Replaces what the browser says its time zone is. */
function inTimeZone(timeZone: string | undefined) {
  const real = Intl.DateTimeFormat;
  vi.stubGlobal(
    'Intl',
    Object.assign(Object.create(Intl) as typeof Intl, {
      DateTimeFormat: Object.assign(
        (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => ({
          ...new real(...args),
          resolvedOptions: () => ({ ...new real(...args).resolvedOptions(), timeZone }),
        }),
        real,
      ),
    }),
  );
}

describe('countryFromTimeZone', () => {
  it('recognises São Paulo, the zone nearly every Brazilian browser reports', () => {
    expect(countryFromTimeZone('America/Sao_Paulo')).toBe('BR');
  });

  /**
   * The reason the table is not one row. A reader in Manaus or Recife needs
   * BRL exactly as much as one in São Paulo, and a table covering only the
   * biggest city is the kind of omission that looks complete in review.
   */
  it('recognises the rest of Brazil’s zones too', () => {
    for (const zone of [
      'America/Manaus',
      'America/Recife',
      'America/Fortaleza',
      'America/Cuiaba',
      'America/Rio_Branco',
      'America/Noronha',
      'America/Eirunepe',
    ]) {
      expect(countryFromTimeZone(zone), zone).toBe('BR');
    }
  });

  it('matches an identifier case-insensitively, as IANA defines them', () => {
    expect(countryFromTimeZone('america/sao_paulo')).toBe('BR');
  });

  // Everything the app prices normally, plus every way the zone can be absent.
  it('has no opinion about a zone the app does not price specially', () => {
    expect(countryFromTimeZone('America/New_York')).toBeNull();
    expect(countryFromTimeZone('Europe/Lisbon')).toBeNull();
    expect(countryFromTimeZone('UTC')).toBeNull();
    expect(countryFromTimeZone(undefined)).toBeNull();
    expect(countryFromTimeZone(null)).toBeNull();
    expect(countryFromTimeZone('')).toBeNull();
  });
});

describe('countryFromGeoBody', () => {
  it('reads the country out of the endpoint’s answer', () => {
    expect(countryFromGeoBody({ country: 'BR' })).toBe('BR');
    expect(countryFromGeoBody({ country: 'br' })).toBe('BR');
  });

  // `{"country": null}` is the endpoint's own answer for "Hosting did not tell
  // me", so it has to read as unknown rather than as a malformed response.
  it('reads an explicit null as unknown', () => {
    expect(countryFromGeoBody({ country: null })).toBeNull();
  });

  it('refuses anything that is not the shape of a country code', () => {
    expect(countryFromGeoBody({})).toBeNull();
    expect(countryFromGeoBody({ country: 'BRA' })).toBeNull();
    expect(countryFromGeoBody({ country: 55 })).toBeNull();
    expect(countryFromGeoBody(null)).toBeNull();
    expect(countryFromGeoBody('BR')).toBeNull();
    expect(countryFromGeoBody([])).toBeNull();
  });
});

describe('GeoService', () => {
  /**
   * The store is cleared around every test because the server's answer is now
   * kept there for a day (`PricingCacheService`), and `localStorage` outlives a
   * `TestBed` reset — so without this, the first test to record `BR` would
   * hand it to every later test that expects "could not say". That is not an
   * artefact of the suite: it is exactly the behaviour under test one file
   * further down, which is why it is cleared rather than mocked away.
   */
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('asks its own origin, as JSON, with a deadline that cancels the request', async () => {
    const { calls } = answering({ body: { country: 'BR' } });

    await expect(TestBed.inject(GeoService).resolveCountry()).resolves.toBe('BR');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(GEO_ENDPOINT);
    // `CLAUDE.md` §4.4: a timeout has to cancel the work, not just stop
    // waiting for it — so the deadline is an `AbortSignal`, not a race.
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(GEO_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  /**
   * The case every non-production environment is in. `ng serve` and a preview
   * channel both answer `/api/geo` with the SPA shell — `200`, `text/html`,
   * and a body that is not JSON — which is a success by every measure except
   * the only one that matters here.
   */
  it('reads the SPA shell from a deployment without the rewrite as unknown', async () => {
    answering({ contentType: 'text/html; charset=utf-8', bodyIsNotJson: true });

    await expect(TestBed.inject(GeoService).resolveCountry()).resolves.toBeNull();
  });

  it('reads a 5xx as unknown', async () => {
    answering({ status: 503, body: { country: 'BR' } });

    await expect(TestBed.inject(GeoService).resolveCountry()).resolves.toBeNull();
  });

  it('reads a timed-out request as unknown rather than rejecting', async () => {
    failingWith(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));

    await expect(TestBed.inject(GeoService).resolveCountry()).resolves.toBeNull();
  });

  // A body that parses but says something else — a rewrite pointed at the
  // wrong function, an intermediary rewriting the response.
  it('reads an unexpected JSON body as unknown', async () => {
    answering({ body: { error: 'nope' } });

    await expect(TestBed.inject(GeoService).resolveCountry()).resolves.toBeNull();
  });

  it('falls back to the time zone when the server cannot say', async () => {
    answering({ body: { country: null } });
    inTimeZone('America/Sao_Paulo');

    await expect(TestBed.inject(GeoService).resolveCountry()).resolves.toBe('BR');
  });

  it('prefers the server’s answer over the time zone when they disagree', async () => {
    answering({ body: { country: 'US' } });
    inTimeZone('America/Sao_Paulo');

    await expect(TestBed.inject(GeoService).resolveCountry()).resolves.toBe('US');
  });

  it('answers nothing when neither source can say', async () => {
    answering({ body: { country: null } });
    inTimeZone('Europe/Lisbon');

    await expect(TestBed.inject(GeoService).resolveCountry()).resolves.toBeNull();
  });

  it('reads the time zone with no request at all', () => {
    inTimeZone('America/Bahia');

    expect(TestBed.inject(GeoService).timeZoneCountry()).toBe('BR');
  });

  // A browser that cannot answer must not take a pricing page's load with it.
  it('survives an Intl that throws', () => {
    vi.stubGlobal('Intl', {
      DateTimeFormat: () => {
        throw new Error('no ICU data');
      },
    });

    expect(TestBed.inject(GeoService).timeZoneCountry()).toBeNull();
  });

  it('asks the server once and reuses the answer', async () => {
    const { fetchMock } = answering({ body: { country: 'BR' } });
    const service = TestBed.inject(GeoService);

    await service.resolveCountry();
    await service.resolveCountry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * `CLAUDE.md` §4.4, in its milder form: this promise never rejects, so what
   * would be cached is a resolved `null` — and caching that turns one blocked
   * request into a tab that never asks again. The memo sits on the server half
   * alone, so a time-zone answer standing in for a failed request does not
   * suppress the next attempt either.
   */
  it('asks again after a request that could not answer', async () => {
    const firstAttempt = failingWith(new TypeError('Failed to fetch'));
    inTimeZone('America/Sao_Paulo');
    const service = TestBed.inject(GeoService);

    await expect(service.resolveCountry()).resolves.toBe('BR');
    expect(firstAttempt).toHaveBeenCalledTimes(1);

    const { fetchMock } = answering({ body: { country: 'US' } });
    await expect(service.resolveCountry()).resolves.toBe('US');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * What the next page load starts from.
   *
   * The in-memory memo above dies with the tab, and the country is the slow
   * half of the pricing page's first paint — two seconds of `AbortSignal`
   * budget before the control can be checked. Keeping the answer for a day
   * turns the second visit into no wait at all, and `knownCountry()` is what
   * a cache-first render reads.
   */
  describe('remembering what the server said', () => {
    it('answers from the last visit’s server answer, with no request', async () => {
      answering({ body: { country: 'BR' } });
      await TestBed.inject(GeoService).resolveCountry();

      // A fresh service, as the next page load builds.
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});
      inTimeZone('America/New_York');

      expect(TestBed.inject(GeoService).knownCountry()).toBe('BR');
    });

    /**
     * A day-old answer about an IP address still beats a clock: a laptop set
     * to São Paulo in a New York hotel is a Brazilian clock and an American
     * card, and it was the *server* that said which.
     */
    it('prefers a remembered server answer to the time zone', () => {
      TestBed.inject(PricingCacheService).writeCountry('US');
      inTimeZone('America/Sao_Paulo');

      expect(TestBed.inject(GeoService).knownCountry()).toBe('US');
    });

    it('falls back to the time zone when nothing is remembered', () => {
      inTimeZone('America/Sao_Paulo');

      expect(TestBed.inject(GeoService).knownCountry()).toBe('BR');
    });

    /**
     * `CLAUDE.md` §4.4 again, and the durable copy is the version that would
     * hurt: an in-memory memo of a failure costs the tab, a stored one costs
     * the reader a day of never asking again.
     */
    it('never remembers a failure', async () => {
      answering({ body: { country: null } });
      inTimeZone('America/Sao_Paulo');

      await TestBed.inject(GeoService).resolveCountry();

      expect(TestBed.inject(PricingCacheService).readCountry()).toBeNull();
    });

    it('falls back to a remembered answer when this visit’s request fails', async () => {
      TestBed.inject(PricingCacheService).writeCountry('BR');
      failingWith(new TypeError('Failed to fetch'));
      inTimeZone('Europe/Lisbon');

      await expect(TestBed.inject(GeoService).resolveCountry()).resolves.toBe('BR');
    });
  });
});
