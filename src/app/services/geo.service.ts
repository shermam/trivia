import { Injectable } from '@angular/core';

/**
 * Where the visitor is, as far as the app can honestly tell — used for one
 * thing only, and never as authority.
 *
 * The pricing page has to open on the right currency before anybody clicks
 * anything, because a Brazilian-issued card presented a USD price is declined
 * rather than merely surprising (`SubscriptionService`). Language is not
 * location, and the difference is not academic: a Brazilian reading English
 * browses in `en-US`, so a default keyed on `navigator.languages` quotes them
 * dollars and lands them on exactly the refusal this feature exists to avoid.
 *
 * So the country comes from three sources in decreasing order of confidence,
 * and every one of them can be absent:
 *
 * 1. **The app's own server** (`/api/geo`, a Hosting rewrite to a Cloud
 *    Function that reads the `X-Country-Code` header Hosting resolves from the
 *    client IP). First-party, same-origin, and nothing is stored.
 * 2. **The browser's IANA time zone**, which is a statement about where the
 *    machine is set rather than what it reads, and needs no request at all.
 * 3. **Nothing** — the caller falls back to the catalog's own default price.
 *
 * All of it is UI (`CLAUDE.md` §4.2): it decides which of the catalog's prices
 * is preselected, the reader can switch, and what is actually charged is
 * decided by the price ID the Cloud Function validates.
 */

/**
 * The same-origin endpoint. Same origin is the whole point — it is why no CSP
 * directive changes (`connect-src 'self'` already covers it), why no
 * third-party learns the visitor's address, and why `csp:verify`'s
 * hand-maintained origin list is untouched.
 */
export const GEO_ENDPOINT = '/api/geo';

/**
 * How long the page will wait for it.
 *
 * `AbortSignal.timeout` rather than a `Promise.race` against a timer, because
 * a race abandons the request while it runs to completion and bills for a
 * result nobody reads (`CLAUDE.md` §4.4). Two seconds because the answer only
 * moves a radio button: past that the time-zone fallback is a better trade
 * than a page that has not chosen a currency yet.
 */
export const GEO_TIMEOUT_MS = 2_000;

/**
 * IANA time zones that identify a country the app prices differently.
 *
 * **Deliberately not a world map.** The only question this table answers is
 * "does the reader need a currency other than the catalog's default", and
 * today there is exactly one such country — so listing Brazil's zones is the
 * whole table, and a zone that is not in it means "no special handling",
 * never "unknown place". Selling in a third currency means adding that
 * country's zones here, next to the mapping that makes them matter.
 *
 * These are the sixteen zones IANA carries for Brazil. `America/Sao_Paulo` is
 * the one nearly every Brazilian browser reports; the rest exist because a
 * table that quietly covers only the biggest city is the kind of thing that
 * looks right in review and fails for the reader in Manaus.
 */
const TIME_ZONE_COUNTRIES: Record<string, string> = Object.fromEntries(
  [
    'America/Araguaina',
    'America/Bahia',
    'America/Belem',
    'America/Boa_Vista',
    'America/Campo_Grande',
    'America/Cuiaba',
    'America/Eirunepe',
    'America/Fortaleza',
    'America/Maceio',
    'America/Manaus',
    'America/Noronha',
    'America/Porto_Velho',
    'America/Recife',
    'America/Rio_Branco',
    'America/Santarem',
    'America/Sao_Paulo',
  ].map((zone) => [zone, 'BR']),
);

/**
 * The country a time zone puts the reader in, or `null` if the app has no
 * reason to treat that zone specially.
 *
 * Pure and exported so the rule is testable without a browser whose zone the
 * test cannot choose — the suite runs on machines set to whatever they are set
 * to, and a test that read the real `Intl` would assert about the runner.
 *
 * Matched case-insensitively: IANA identifiers are defined as
 * case-insensitive, and while every engine reports the canonical casing, the
 * value passes through code that is not ours to constrain.
 */
export function countryFromTimeZone(timeZone: string | null | undefined): string | null {
  if (!timeZone) {
    return null;
  }
  const wanted = timeZone.toLowerCase();
  const match = Object.entries(TIME_ZONE_COUNTRIES).find(([zone]) => zone.toLowerCase() === wanted);
  return match ? match[1] : null;
}

/**
 * The country in a `/api/geo` response body, or `null` for anything that is
 * not one.
 *
 * The body is parsed rather than trusted: the endpoint is reached through a
 * Hosting rewrite, and the rewrite is exactly the thing that can be missing —
 * on `ng serve` and on a preview channel, `/api/geo` falls through to the SPA
 * catch-all and answers `200 text/html`. That case is caught by the
 * content-type check in `resolveCountry`, and this is the second line: a body
 * that parsed as JSON but carries no country, or carries something that is not
 * a two-letter code, is unknown rather than an error.
 */
export function countryFromGeoBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const country = (body as { country?: unknown }).country;
  return typeof country === 'string' && /^[A-Za-z]{2}$/.test(country)
    ? country.toUpperCase()
    : null;
}

@Injectable({ providedIn: 'root' })
export class GeoService {
  private serverCountryPromise: Promise<string | null> | null = null;

  /**
   * What the browser's own clock settings say, with no request at all.
   *
   * Synchronous on purpose. It is what the pricing page opens on while the
   * server is still being asked, so a Brazilian machine gets the Brazilian
   * price from first paint and the radio never has to move — and a reader
   * whose zone the app does not price specially is no worse off than before
   * this existed.
   */
  timeZoneCountry(): string | null {
    return countryFromTimeZone(browserTimeZone());
  }

  /**
   * The best country signal available: the server's answer, falling back to
   * the time zone, falling back to nothing.
   *
   * **Never rejects.** Every failure — a timeout, a 5xx, an HTML page from a
   * deployment where the function does not exist, a body that is not what it
   * should be — falls to the next source in the chain, and ultimately to
   * `null`. A caller that had to handle a rejection here would be handling it
   * by falling back to exactly this, one layer further out.
   *
   * **A failed server lookup is not memoised** (`CLAUDE.md` §4.4). A real
   * answer is cached for the life of the tab because it cannot change, but
   * caching a failure would turn one blocked request into a session that never
   * asks again — and this runs on every visit to `/pricing`, so the retry
   * costs one request on a page that already makes two. The memo is on the
   * *server* half rather than on the chain, so a time-zone answer standing in
   * for a failed request does not also suppress the next attempt at it.
   */
  async resolveCountry(): Promise<string | null> {
    return (await this.cachedServerCountry()) ?? this.timeZoneCountry();
  }

  private cachedServerCountry(): Promise<string | null> {
    if (!this.serverCountryPromise) {
      this.serverCountryPromise = this.serverCountry();
      void this.serverCountryPromise.then((country) => {
        if (country === null) {
          this.serverCountryPromise = null;
        }
      });
    }
    return this.serverCountryPromise;
  }

  private async serverCountry(): Promise<string | null> {
    try {
      const response = await fetch(GEO_ENDPOINT, {
        headers: { Accept: 'application/json' },
        // Cancels the request rather than merely stopping the wait
        // (`CLAUDE.md` §4.4).
        signal: AbortSignal.timeout(GEO_TIMEOUT_MS),
      });
      // 200 and JSON, both checked. A deployment without the rewrite answers
      // `200 text/html` with the SPA shell, which is a success by every
      // measure except the only one that matters here.
      if (response.status !== 200) {
        return null;
      }
      if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
        return null;
      }
      return countryFromGeoBody(await response.json());
    } catch {
      // A timeout, an offline tab, a refused connection, a body that is not
      // JSON after all. None of them is something the reader can act on, and
      // the page has a currency to show either way.
      return null;
    }
  }
}

/**
 * The browser's IANA zone, or `undefined` where it cannot be read.
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is required to return an
 * identifier by ECMA-402 and does so everywhere this app runs, but it is read
 * defensively all the same: it is a browser-supplied value on a path that must
 * not be able to throw a pricing page's load.
 */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
