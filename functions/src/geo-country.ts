/**
 * Reading the visitor's country out of the request headers Firebase Hosting
 * adds when it proxies to a function.
 *
 * Pure and in its own module, same convention as `role.ts` and
 * `account-policy.ts`: the parsing is the only part of `geo.ts` with a decision
 * in it, so it gets a direct unit test rather than being inferred from a
 * deployed request nobody can reproduce locally.
 *
 * **The header is the platform's, not ours, and it may simply not be there.**
 * Hosting resolves the client IP to a country at the edge and passes it down as
 * `X-Country-Code`; nothing in this repo can make that happen, and nothing
 * here should pretend to know it always will. Every path that cannot produce a
 * country returns `null` — the caller answers `{"country": null}` and the
 * client falls through to its own signals rather than being told something
 * that was guessed.
 */

/**
 * The header Firebase Hosting sets on a request it proxies to a function or a
 * Cloud Run service. Lowercase because that is how Node normalises an incoming
 * header name; the lookup below does not rely on that.
 */
export const COUNTRY_HEADER = 'x-country-code';

/** Exactly two ASCII letters — the shape of an ISO 3166-1 alpha-2 code. */
const ALPHA2 = /^[A-Za-z]{2}$/;

/**
 * The visitor's country as a two-letter uppercase code, or `null`.
 *
 * The header name is matched case-insensitively. Node lowercases incoming
 * header names already, so on the real request object the direct lookup always
 * wins — but this function is tested directly with plain objects, and a rule
 * that only holds because of a caller's normalisation is a rule the test would
 * not be checking.
 *
 * **Only a `string` is considered a value.** Node hands back an array only for
 * `set-cookie`; every other repeated header arrives joined with `", "`, which
 * fails the shape check below and reads as unknown. That is the right answer
 * for a duplicated header anyway: two countries is not a country.
 *
 * **Validation is the shape, not a list of countries.** A user-assigned code
 * such as `ZZ` (which is what a resolver conventionally sends for "could not
 * tell") is returned as-is rather than filtered out, because the only consumer
 * treats every country that is not `BR` identically — so distinguishing
 * "unknown" from "not Brazil" would buy nothing, while a hand-maintained list
 * of the world's countries would be a second thing to keep current for no
 * behavioural difference at all.
 */
export function countryFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headerValue(headers, COUNTRY_HEADER);
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return ALPHA2.test(trimmed) ? trimmed.toUpperCase() : null;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | string[] | undefined {
  const direct = headers[name];
  if (direct !== undefined) {
    return direct;
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}
