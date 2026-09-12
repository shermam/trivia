import { Injectable, inject, signal } from '@angular/core';
import { isRegionCode } from '../models/regions';
import { GeoService } from './geo.service';

/**
 * Which country a player competes under (`FEAT-028`), and the one rule that
 * governs it: **the app may guess, but only the player may declare.**
 *
 * A regional leaderboard needs a country, and the three ways to get one are
 * not equivalent. The browser Geolocation API asks permission and is disabled
 * outright by `firebase.json`'s `Permissions-Policy: geolocation=()`. A
 * third-party IP lookup adds a processor and an inference to a Privacy Policy
 * that promises neither. A dropdown the player fills in costs nothing, is
 * trivially spoofable — which barely matters for a trivia board — and is the
 * one the spec chose.
 *
 * What is kept is therefore narrow on purpose:
 *
 * - **The declaration is remembered**, so a returning player does not re-pick
 *   their country every game.
 * - **The inference is not.** `GeoService` already answers "which country does
 *   this visitor's IP map to" for the pricing page, first-party and stored
 *   nowhere, and it is reused here to *preselect* the dropdown. Writing that
 *   answer into `localStorage` under this key would turn a preselection into a
 *   record of an inference — the exact thing the feature was designed not to
 *   keep — so a reader who never touches the control leaves nothing behind and
 *   is preselected again from scratch next time.
 *
 * None of it is authority. What reaches the leaderboard is whatever the
 * dropdown reads when Save is pressed, and `firestore.rules` validates that
 * against its own list of countries.
 */

/**
 * Underscored rather than hyphenated like `trivia-theme`, following
 * `trivia_sound_muted`: the key holds one short scalar the player set, and the
 * two of them read as a pair in a browser's storage inspector.
 */
const STORAGE_KEY = 'trivia_region';

@Injectable({ providedIn: 'root' })
export class RegionService {
  private readonly geo = inject(GeoService);

  /**
   * The country the player has declared, or `null` if they never have.
   *
   * A signal rather than a getter so a picker and a board toggle rendered in
   * different parts of the same screen cannot disagree about it.
   */
  readonly declaredRegion = signal<string | null>(readStoredRegion());

  /**
   * Records a declaration, or clears one when the player picks "Prefer not to
   * say".
   *
   * Writes only what the player chose. There is deliberately no path from
   * {@link inferredRegion} into this method: an inference that wrote itself
   * here would be indistinguishable from a declaration a day later, and the
   * two are the whole distinction the policy rests on.
   */
  declareRegion(region: string | null): void {
    const value = isRegionCode(region) ? region : null;
    this.declaredRegion.set(value);
    writeStoredRegion(value);
  }

  /**
   * The app's best guess at where the player is, for preselecting the picker.
   *
   * Delegates the whole chain to `GeoService` — `/api/geo`, then the cached
   * server answer, then the browser's IANA time zone, then nothing — rather
   * than re-implementing any part of it. Two consequences worth knowing before
   * writing a test: locally and on a preview channel there is no `/api/geo`
   * (functions deploy only on merge), so the answer comes from the time zone
   * alone, and `TIME_ZONE_COUNTRIES` maps Brazil's zones and nothing else — so
   * the control opens preselected on `BR` for a Brazilian machine and unset
   * for every other.
   *
   * Never rejects, and an answer the rules would not accept is discarded here
   * rather than offered: the picker must not be able to preselect a country
   * that makes the save fail.
   */
  async inferredRegion(): Promise<string | null> {
    const country = await this.geo.resolveCountry();
    return isRegionCode(country) ? country : null;
  }
}

/**
 * The stored declaration, or `null`.
 *
 * The accessor is inside the `try` deliberately: Safari's private mode and
 * blocked site data throw on `window.localStorage` itself rather than on the
 * `getItem` that follows, so a guard around only the call is a guard around
 * the wrong statement (the same shape `PricingCacheService` documents).
 *
 * Validated on the way out as well as on the way in. This value has been
 * sitting somewhere the reader can edit, and a code the rules refuse would
 * reach the picker as a preselected country whose save silently fails.
 */
function readStoredRegion(): string | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isRegionCode(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredRegion(region: string | null): void {
  try {
    if (region === null) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, region);
  } catch {
    // Unavailable storage or a quota refusal. The declaration still applies to
    // this session — it is component state as much as stored state — it just
    // will not be there next time, which is the pre-`FEAT-028` behaviour.
  }
}
