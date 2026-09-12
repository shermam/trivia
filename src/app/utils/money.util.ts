/**
 * Rendering a Stripe amount as money.
 *
 * Stripe stores an amount in the **smallest unit of its currency** — 99 for
 * $0.99, 590 for R$ 5,90, and 500 for ¥500, which has no subunit at all. So
 * the conversion is not "divide by 100": it is "divide by ten to the power of
 * the currency's exponent", and the exponent is exactly what
 * `Intl.NumberFormat` already knows. Asking the formatter rather than keeping
 * a table means a currency this app has never sold in still renders correctly
 * the day it is added to the Stripe catalog.
 */

/**
 * Which locale's conventions each currency is rendered with.
 *
 * Deliberately **not** the visitor's locale. A price is a fact about the
 * charge, and rendering R$ 5,90 as "R$5.90" to an en-US browser (or $0.99 as
 * "US$ 0,99" to a pt-BR one) makes the same number look like a different
 * convention depending on who is reading it. Pinning the locale to the
 * currency also makes the rendered string deterministic, which is what lets
 * the e2e suite assert on it at all.
 */
const CURRENCY_LOCALES: Record<string, string> = { brl: 'pt-BR' };
const DEFAULT_CURRENCY_LOCALE = 'en-US';

/**
 * A Stripe unit amount as money, or `null` when it cannot be rendered —
 * an amount the price does not carry, or a currency code `Intl` does not
 * recognise. `null` rather than a guess: the caller shows a placeholder, which
 * is the least alarming thing to show for a number nobody has verified
 * (`CLAUDE.md` §4.4).
 */
export function formatUnitAmount(unitAmount: number | null, currency: string): string | null {
  if (unitAmount === null || !Number.isFinite(unitAmount)) {
    return null;
  }
  const locale = CURRENCY_LOCALES[currency.toLowerCase()] ?? DEFAULT_CURRENCY_LOCALE;
  try {
    const format = new Intl.NumberFormat(locale, { style: 'currency', currency });
    // `maximumFractionDigits` for a currency style *is* its ISO 4217 exponent:
    // 2 for USD and BRL, 0 for JPY, 3 for KWD. Reading it back beats hardcoding
    // 100, which would publish ¥500 as ¥5.
    const exponent = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(unitAmount / 10 ** exponent);
  } catch {
    // `Intl.NumberFormat` throws a RangeError on a currency code it cannot
    // parse. The catalog is written only by `stripeWebhook`, so this should be
    // unreachable — but "should be" is not a reason to let a pricing page
    // throw.
    return null;
  }
}
