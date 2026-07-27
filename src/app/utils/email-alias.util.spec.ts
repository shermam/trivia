import { isAliasEmail } from './email-alias.util';

describe('isAliasEmail', () => {
  it('rejects plus-alias addresses', () => {
    expect(isAliasEmail('player+alt1@gmail.com')).toBe(true);
    expect(isAliasEmail('player+@gmail.com')).toBe(true);
  });

  it('accepts plain addresses', () => {
    expect(isAliasEmail('player@gmail.com')).toBe(false);
    expect(isAliasEmail('first.last@example.com')).toBe(false);
  });

  it('ignores a plus sign in the domain part', () => {
    expect(isAliasEmail('player@sub+domain.com')).toBe(false);
  });

  it('treats a missing local part as not an alias', () => {
    expect(isAliasEmail('@gmail.com')).toBe(false);
  });
});
