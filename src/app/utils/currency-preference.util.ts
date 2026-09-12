/**
 * Which currency to quote somebody, given where they appear to be and what the
 * Stripe catalog actually offers.
 *
 * One rule, shared by everything this account sells — the Pro subscription and
 * the donation presets — because two copies of it could disagree, and the
 * reader would then be quoted dollars for one and reais for the other on the
 * same page. Pure and exported so the Brazilian case can be tested without
 * depending on the machine running the suite.
 */

/**
 * The currency a visitor in this country has to be offered, when the catalog
 * carries a price in it.
 *
 * **Not a preference — a requirement.** This Stripe account is registered in
 * Brazil, and a Brazilian-issued card can only be charged in BRL; presented a
 * USD price it is declined with "your card doesn't support this currency".
 * Stripe's Adaptive Pricing does not rescue that case, because it localises
 * prices only for buyers **outside** the merchant's own country
 * (`functions/src/checkout-sessions.ts`). So a Brazilian buyer needs a real
 * BRL price, and this is what puts them on it by default.
 *
 * The country comes from `GeoService` — the app's own server first, the
 * browser's time zone second — and is a UI signal and nothing more
 * (`CLAUDE.md` §4.2): it decides which of the catalog's prices is preselected,
 * and the visitor can switch. What is actually charged is decided by the price
 * ID the session document carries, which the Cloud Function validates against
 * the mirrored catalog either way.
 *
 * **The input is a country and not a locale**, which is the whole reason
 * `GeoService` exists: a Brazilian reading English browses in `en-US`, so a
 * rule keyed on language quotes them dollars and their card is declined.
 * Language says what somebody reads; it says nothing about where their bank
 * is.
 */
const COUNTRY_CURRENCIES: Record<string, string> = { BR: 'brl' };

/**
 * Preferred when the visitor's own country asks for nothing in particular.
 * The catalog decides what exists; this only decides which of several it opens
 * on.
 */
const FALLBACK_CURRENCY = 'usd';

/**
 * The currency to open on, from the currencies on offer in catalog order.
 *
 * **The country only decides anything when the catalog can honour it.** A
 * mapping to a currency nothing is priced in would leave a button quoting a
 * price that does not exist, so an unmatched country falls through to the same
 * default as an unknown one — which is also what `null` means here, and there
 * are three ways to get it: the server was not asked, could not tell, or the
 * reader is simply somewhere the app prices normally.
 *
 * Catalog order decides the last resort, so which currency wins never depends
 * on network timing.
 */
export function preferredCurrency(
  offeredCurrencies: readonly string[],
  country: string | null,
): string | null {
  const offered = new Set(offeredCurrencies);
  const required = country ? COUNTRY_CURRENCIES[country.toUpperCase()] : undefined;
  if (required && offered.has(required)) {
    return required;
  }
  if (offered.has(FALLBACK_CURRENCY)) {
    return FALLBACK_CURRENCY;
  }
  return offeredCurrencies[0] ?? null;
}
