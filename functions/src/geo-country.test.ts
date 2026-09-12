import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COUNTRY_HEADER, countryFromHeaders } from './geo-country';

test('reads a two-letter country code', () => {
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: 'BR' }), 'BR');
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: 'US' }), 'US');
});

// The header's case is the platform's business, not ours. Normalising here is
// what lets the client compare against a plain `'BR'` without repeating the
// question.
test('accepts a code in any case and answers in upper case', () => {
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: 'br' }), 'BR');
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: 'bR' }), 'BR');
});

test('matches the header name case-insensitively', () => {
  assert.equal(countryFromHeaders({ 'X-Country-Code': 'BR' }), 'BR');
  assert.equal(countryFromHeaders({ 'X-COUNTRY-CODE': 'BR' }), 'BR');
});

test('tolerates surrounding whitespace', () => {
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: ' BR ' }), 'BR');
});

/**
 * The case this endpoint exists to survive: Hosting did not add the header at
 * all. That is what `ng serve` and any direct call to the function look like,
 * and it must read as "unknown", never as an empty-string country.
 */
test('reads a missing header as unknown', () => {
  assert.equal(countryFromHeaders({}), null);
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: undefined }), null);
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: '' }), null);
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: '   ' }), null);
});

test('refuses anything that is not the shape of an ISO 3166-1 alpha-2 code', () => {
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: 'BRA' }), null);
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: 'B' }), null);
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: '55' }), null);
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: 'B1' }), null);
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: '<script>' }), null);
});

/**
 * A repeated header arrives from Node joined with `", "` for everything except
 * `set-cookie`, and the joined value fails the shape check — which is the
 * answer we want anyway, since two countries is not a country. The array form
 * is covered because the type allows it, not because Hosting produces it.
 */
test('reads a duplicated header as unknown rather than picking one', () => {
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: 'BR, US' }), null);
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: ['BR', 'US'] }), null);
});

/**
 * `ZZ` is the user-assigned code a resolver sends when it cannot tell, and it
 * is passed through deliberately: the client maps every country that is not
 * `BR` to the same currency, so filtering it would change nothing while adding
 * a list of exceptions to keep current.
 */
test('passes an unrecognised but well-formed code straight through', () => {
  assert.equal(countryFromHeaders({ [COUNTRY_HEADER]: 'ZZ' }), 'ZZ');
});
