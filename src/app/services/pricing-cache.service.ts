import { Injectable } from '@angular/core';
import type { ProPriceOption } from './subscription.service';

/**
 * The pricing page's browser-side memory: what Pro costs, where the reader
 * appears to be, and a Checkout Session already waiting for them.
 *
 * All three exist for the same reason — the page was measurably slow at the
 * two moments it is looked at. Opening `/pricing` took a visible beat to
 * settle on a currency (a geo round trip plus two Firestore reads), and
 * Subscribe sat on "Redirecting…" for seconds (an Eventarc delivery, a cold
 * start, Stripe's own customer and session creation, and our poll on top).
 * Neither is fixed by making those calls faster; they are fixed by not being
 * on the critical path.
 *
 * **None of it is authority, and none of it is personal.** The catalog and the
 * country decide which price is *shown* first; what is actually charged is
 * decided by the price ID the Cloud Function validates against the mirrored
 * catalog (`CLAUDE.md` §4.2), and a stale cache can therefore make the page
 * quote the wrong amount for up to a day but can never make it *sell* at one.
 * The country is a two-letter code the app already asked its own server for,
 * kept so it does not have to ask again on the next visit.
 *
 * **Every access is wrapped**, as `GamePersistenceService` wraps IndexedDB:
 * `localStorage` and `sessionStorage` can be unavailable outright (Safari's
 * private mode refuses the accessor, not just the write, and a quota refusal
 * throws on `setItem`). Losing the cache must cost a page its speed, never its
 * correctness — every caller here treats "nothing cached" as the normal case,
 * because for a first-time visitor it is.
 */

/**
 * How long a cached catalog or country is rendered without asking again.
 *
 * A day, because both change on a scale of months: a price is edited in the
 * Stripe Dashboard perhaps once a year, and a reader's country does not move
 * while they are reading. The cache is only ever *first* — every page load
 * revalidates in the background and corrects what it finds — so the TTL is not
 * how long a stale answer can survive, it is how long one may be shown before
 * a *fresh* answer arrives in the same page load. What it really bounds is the
 * case where revalidation never answers at all (an offline tab), and a day of
 * a possibly-outdated amount beats a placeholder for that reader.
 */
export const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a pre-created Checkout Session is treated as usable.
 *
 * Stripe expires an open Checkout Session 24 hours after it is created, and
 * the URL stops working at that moment rather than degrading — so the number
 * here is a *margin* below Stripe's, not a policy of our own. Four hours of it
 * covers the gap between the clock that stamped the entry (the reader's) and
 * the clock that enforces the expiry (Stripe's), plus the reader who opens the
 * tab, walks away, and comes back to click.
 *
 * Past it the entry is ignored and Subscribe takes the ordinary path, which is
 * the same thing that happens when there is no entry at all.
 */
export const READY_CHECKOUT_TTL_MS = 20 * 60 * 60 * 1000;

/**
 * One namespaced key each, matching `trivia-theme`'s convention. All three are
 * `localStorage`.
 *
 * The checkout entry is the one worth explaining, because `sessionStorage`
 * looks like the better fit for it — a checkout does feel like a property of
 * the tab that started it — and is in fact **unsafe**. Stripe allows a
 * customer one open Checkout Session at a time as far as this app is
 * concerned, and `createCheckoutSession` expires the customer's open sessions
 * before creating another. Per-tab storage hides that from the client: a
 * second tab on `/pricing` sees no entry, pre-creates, and its create kills
 * the first tab's session while the first tab goes on believing its URL is
 * live — so clicking Subscribe there lands on Stripe's "this session has
 * expired" page. One entry per *device* is what makes the second tab reuse the
 * live session instead of destroying it.
 */
const CATALOG_KEY = 'trivia-pricing-catalog';
const COUNTRY_KEY = 'trivia-pricing-country';
const READY_CHECKOUT_KEY = 'trivia-checkout-ready';

/** A Checkout Session created before anybody clicked Subscribe. */
export interface ReadyCheckout {
  /** Whose session it is — a different account on the same device must not reuse it. */
  readonly uid: string;
  /** Which price it checks out against, so a currency change cannot reuse it. */
  readonly priceId: string;
  /** The hosted Stripe Checkout URL the Cloud Function wrote back. */
  readonly url: string;
  /** When the URL arrived, by this browser's clock. */
  readonly readyAt: number;
}

type StorageKind = 'local' | 'session';

/**
 * The `Storage` object, or `null` where reading the property itself throws.
 *
 * The accessor is inside the `try` deliberately: Safari's private mode and a
 * `SecurityError` from blocked site data both fail on `window.localStorage`
 * rather than on the call that follows, so a guard written around only
 * `getItem` is a guard around the wrong statement.
 */
function storage(kind: StorageKind): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function readJson(kind: StorageKind, key: string): unknown {
  try {
    const raw = storage(kind)?.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    // Unavailable storage, or a value somebody edited into something that is
    // not JSON. Both mean "nothing cached", which every caller handles.
    return null;
  }
}

/** Whether the value was actually stored — `false` for unavailable storage or a quota refusal. */
function writeJson(kind: StorageKind, key: string, value: unknown): boolean {
  try {
    const store = storage(kind);
    if (!store) {
      return false;
    }
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Quota exceeded, or storage unavailable. The page carries on doing what
    // it did before this cache existed.
    return false;
  }
}

function removeKey(kind: StorageKind, key: string): void {
  try {
    storage(kind)?.removeItem(key);
  } catch {
    // See above.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether a timestamp is recent enough to use.
 *
 * A stamp in the *future* counts as fresh rather than as expired, the same
 * call `GamePersistenceService` makes: it means the clock has since moved
 * backwards (a timezone fix, an NTP correction), and treating that as
 * expiry would quietly throw away a perfectly good entry.
 */
function isFresh(storedAt: unknown, now: number, ttlMs: number): boolean {
  return typeof storedAt === 'number' && Number.isFinite(storedAt) && now - storedAt <= ttlMs;
}

/**
 * The cached catalog, or `null` for anything that is not a complete one.
 *
 * **All-or-nothing rather than per-entry filtering**, and the reason is the
 * same one that makes `answerHistory` all-or-nothing: this list is *ordered*,
 * and the order decides which currency the page opens on when neither the
 * country nor a reader's choice does. Dropping one unreadable entry would
 * silently change that answer. A catalog that cannot be read in full is no
 * catalog, and the page then waits for the network exactly as it did before.
 */
function parseCatalog(value: unknown, now: number): readonly ProPriceOption[] | null {
  if (!isRecord(value) || !isFresh(value['storedAt'], now, PRICING_CACHE_TTL_MS)) {
    return null;
  }
  const options = value['options'];
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }

  const parsed: ProPriceOption[] = [];
  for (const option of options) {
    if (!isRecord(option)) {
      return null;
    }
    const { priceId, currency, unitAmount } = option;
    if (typeof priceId !== 'string' || priceId === '') {
      return null;
    }
    if (typeof currency !== 'string' || currency === '') {
      return null;
    }
    // `null` is a real value here — a Stripe price whose amount is decided at
    // checkout — and the page renders a placeholder for it. Anything else that
    // is not a finite number is not.
    if (unitAmount !== null && (typeof unitAmount !== 'number' || !Number.isFinite(unitAmount))) {
      return null;
    }
    parsed.push({ priceId, currency: currency.toLowerCase(), unitAmount });
  }
  return parsed;
}

function parseCountry(value: unknown, now: number): string | null {
  if (!isRecord(value) || !isFresh(value['storedAt'], now, PRICING_CACHE_TTL_MS)) {
    return null;
  }
  const country = value['country'];
  // The same shape `countryFromGeoBody` accepts, checked again on the way back
  // out: this value has been sitting somewhere the reader can edit.
  return typeof country === 'string' && /^[A-Za-z]{2}$/.test(country)
    ? country.toUpperCase()
    : null;
}

/**
 * Whether a stored string is a URL this app is willing to navigate to.
 *
 * The entry is same-origin `sessionStorage` written by this code alone, so in
 * practice it holds what the Cloud Function wrote — but it is read back and
 * handed to `location.assign`, and a value that reached that call without
 * being checked would be an open redirect with a `javascript:` variant behind
 * it. Absolute `http(s)` only: Stripe's hosted URL is `https`, and the
 * mock-mode URL the e2e suite drives is a same-origin `http://…/pricing#…`
 * (`functions/src/checkout-sessions.ts`).
 */
function isNavigableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') {
    return false;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function parseReadyCheckout(value: unknown, now: number): ReadyCheckout | null {
  if (!isRecord(value) || !isFresh(value['readyAt'], now, READY_CHECKOUT_TTL_MS)) {
    return null;
  }
  const { uid, priceId, url, readyAt } = value;
  if (typeof uid !== 'string' || uid === '' || typeof priceId !== 'string' || priceId === '') {
    return null;
  }
  if (!isNavigableUrl(url)) {
    return null;
  }
  return { uid, priceId, url, readyAt: readyAt as number };
}

@Injectable({ providedIn: 'root' })
export class PricingCacheService {
  /** The last catalog this browser saw, if it is still within the TTL. */
  readCatalog(now = Date.now()): readonly ProPriceOption[] | null {
    return parseCatalog(readJson('local', CATALOG_KEY), now);
  }

  writeCatalog(options: readonly ProPriceOption[], now = Date.now()): void {
    writeJson('local', CATALOG_KEY, { storedAt: now, options });
  }

  /** The last country the *server* named, if it is still within the TTL. */
  readCountry(now = Date.now()): string | null {
    return parseCountry(readJson('local', COUNTRY_KEY), now);
  }

  /**
   * Records a country the server actually answered with.
   *
   * Only a real answer is ever stored. Caching "could not say" would turn one
   * blocked request into a day of never asking again — the same mistake
   * `GeoService`'s in-memory memo deliberately avoids (`CLAUDE.md` §4.4), one
   * layer more durable and therefore one layer worse.
   */
  writeCountry(country: string, now = Date.now()): void {
    writeJson('local', COUNTRY_KEY, { storedAt: now, country });
  }

  /**
   * The Checkout Session waiting on this device, if it is still usable.
   *
   * Read afresh on every use rather than memoised anywhere, because another
   * tab can have replaced or cleared it since — which is the entire point of
   * keeping it here rather than in the tab.
   */
  readReadyCheckout(now = Date.now()): ReadyCheckout | null {
    return parseReadyCheckout(readJson('local', READY_CHECKOUT_KEY), now);
  }

  /**
   * Returns whether the entry was actually stored. A caller that cannot store
   * one gains nothing by creating the session it describes, and the answer is
   * what lets it stop trying (`SubscriptionService.prepareCheckout`).
   */
  writeReadyCheckout(entry: ReadyCheckout): boolean {
    return writeJson('local', READY_CHECKOUT_KEY, entry);
  }

  clearReadyCheckout(): void {
    removeKey('local', READY_CHECKOUT_KEY);
  }
}
