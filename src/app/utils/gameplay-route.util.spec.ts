import { isGameplayRoute } from './gameplay-route.util';

/**
 * Two components hide a control on this one route, and both used to decide it
 * themselves. What the tests are really pinning is the parsing: a URL that
 * carries anything after the path must still be recognised, or the CTA
 * reappears in the middle of a round the first time `/play` grows a query
 * parameter.
 */
describe('isGameplayRoute', () => {
  it('recognises the quiz round', () => {
    expect(isGameplayRoute('/play')).toBe(true);
  });

  it('recognises it with a query or a fragment attached', () => {
    expect(isGameplayRoute('/play?embed=1')).toBe(true);
    expect(isGameplayRoute('/play#question-3')).toBe(true);
    expect(isGameplayRoute('/play?embed=1#question-3')).toBe(true);
  });

  it('leaves every other route alone', () => {
    expect(isGameplayRoute('/')).toBe(false);
    expect(isGameplayRoute('/pricing')).toBe(false);
    expect(isGameplayRoute('/game-over')).toBe(false);
  });

  // Prefix matching would hide the control on a route that merely starts the
  // same way — there is none today, and that is exactly the kind of thing a
  // later route can quietly become.
  it('does not match a route that only begins with it', () => {
    expect(isGameplayRoute('/playlist')).toBe(false);
  });
});
