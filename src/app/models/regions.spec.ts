import { REGION_CODES, isRegionCode, regionName, regionOptions } from './regions';

/**
 * The country list the picker offers and `firestore.rules` validates against
 * (`FEAT-028`).
 *
 * The list itself is pinned against the rules copy by
 * `firestore-tests/leaderboards.rules.spec.ts`, which reads the codes out of
 * `firestore.rules` — that is the check that matters and it belongs where the
 * emulator is. What is left here is the shape of the list and the naming
 * around it: the properties a save depends on and a rules test cannot see.
 */
describe('REGION_CODES', () => {
  it('holds the officially assigned ISO 3166-1 alpha-2 codes', () => {
    // 249 is the count of currently assigned alpha-2 codes. Stated as a number
    // because the list is generated once and hand-maintained afterwards: a
    // code added or dropped by accident is exactly the edit this catches.
    expect(REGION_CODES).toHaveLength(249);
    expect(REGION_CODES).toContain('BR');
    expect(REGION_CODES).toContain('ZW');
  });

  it('holds nothing but two uppercase ASCII letters, with no duplicates', () => {
    expect(REGION_CODES.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true);
    expect(new Set(REGION_CODES).size).toBe(REGION_CODES.length);
  });

  /*
   * The exclusions are the part that is easy to get wrong, because ICU knows
   * all of these and a list generated from it without filtering would offer
   * them. None is a country: `UK` and `EU` are exceptionally reserved, `XK`
   * is user-assigned, `ZZ` is the unknown-region placeholder, and `DY` is a
   * name withdrawn in 1977. A board under any of them is one no dropdown can
   * reach and no sweep visits.
   */
  it.each(['UK', 'EU', 'XK', 'CQ', 'ZZ', 'AA', 'DY'])(
    'leaves out %s, which is not an assigned country code',
    (code) => {
      expect(REGION_CODES).not.toContain(code);
      expect(isRegionCode(code)).toBe(false);
    },
  );

  it.each([null, undefined, 42, 'br', 'BRA', ''])('rejects %s as a code', (value) => {
    expect(isRegionCode(value)).toBe(false);
  });
});

describe('regionName', () => {
  it('names a country rather than echoing its code', () => {
    expect(regionName('BR')).not.toBe('BR');
    expect(regionName('BR').length).toBeGreaterThan(2);
  });

  /*
   * The fallback exists because `Intl.DisplayNames` is not guaranteed to have
   * data for every code on every runtime, and a board heading reading `QQ` is
   * a far better outcome than one that throws while rendering. `QQ` rather
   * than `ZZ`, which CLDR does know and names "Unknown Region" — a string that
   * would make this pass for the wrong reason if the fallback were removed.
   */
  it('falls back to the code it was given', () => {
    expect(regionName('QQ')).toBe('QQ');
  });
});

describe('regionOptions', () => {
  it('offers every code exactly once, each with a name', () => {
    const options = regionOptions();

    expect(options).toHaveLength(REGION_CODES.length);
    expect(options.map((option) => option.code).sort()).toEqual([...REGION_CODES].sort());
    expect(options.every((option) => option.name.length > 0)).toBe(true);
  });

  it('is sorted by name, not by code', () => {
    const names = regionOptions().map((option) => option.name);
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

    expect(names).toEqual([...names].sort((a, b) => collator.compare(a, b)));
  });

  // Built once: the game-over screen is created afresh after every round, and
  // 249 `Intl.DisplayNames` lookups plus a collated sort is not a cost worth
  // paying again for an answer that cannot have changed.
  it('returns the same list every time rather than rebuilding it', () => {
    expect(regionOptions()).toBe(regionOptions());
  });
});
