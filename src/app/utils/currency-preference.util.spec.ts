import { preferredCurrency } from './currency-preference.util';

/**
 * The rule that decides which currency an amount is quoted in, shared by the
 * Pro card and the donation dialog. It is small, and it is the reason a
 * Brazilian card is not declined at checkout — so it is pinned here directly
 * rather than only through whichever service happens to call it.
 */
describe('preferredCurrency', () => {
  it('quotes a Brazilian visitor in BRL when the catalog carries it', () => {
    expect(preferredCurrency(['usd', 'brl'], 'BR')).toBe('brl');
  });

  it('accepts the country in either case, since it passes through code that is not ours', () => {
    expect(preferredCurrency(['usd', 'brl'], 'br')).toBe('brl');
  });

  // A mapping to a currency nothing is priced in would leave a button quoting
  // a price that does not exist.
  it('falls back to the default when the catalog cannot honour the country', () => {
    expect(preferredCurrency(['usd'], 'BR')).toBe('usd');
  });

  it('quotes USD to everybody else', () => {
    expect(preferredCurrency(['usd', 'brl'], 'US')).toBe('usd');
    expect(preferredCurrency(['usd', 'brl'], 'PT')).toBe('usd');
    expect(preferredCurrency(['usd', 'brl'], null)).toBe('usd');
  });

  // Catalog order, so which currency wins never depends on network timing.
  it('falls back to the first on offer when even the default is not sold', () => {
    expect(preferredCurrency(['eur', 'gbp'], 'BR')).toBe('eur');
    expect(preferredCurrency(['gbp', 'eur'], null)).toBe('gbp');
  });

  it('has nothing to quote when nothing is on sale', () => {
    expect(preferredCurrency([], 'BR')).toBe(null);
    expect(preferredCurrency([], null)).toBe(null);
  });
});
