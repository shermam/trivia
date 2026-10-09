import {
  AVATAR_SEED_PATTERN,
  DEFAULT_AVATAR_CHOICE,
  avatarLetter,
  providerPhotoUrl,
  readAvatarChoice,
} from './avatar.model';

/**
 * The reader every surface draws an avatar through (`FEAT-038`). Lenient by
 * design — the server is the strict side — so what is pinned here is what
 * leniency must never loosen: the public switch, and which host a photo may
 * come from.
 */
describe('readAvatarChoice', () => {
  /**
   * **The owner's condition, pinned.** "We should give the user the choice of
   * not showing their photo" — so the switch is off unless the document says,
   * exactly, that it is on. A `users/{uid}` that never set it is the case
   * every existing account is in.
   */
  it('reads showPublicly as false on a document that never set it', () => {
    expect(readAvatarChoice(undefined)).toEqual({ kind: 'initials', showPublicly: false });
    expect(readAvatarChoice({ kind: 'built', seed: 'core-35' })).toEqual({
      kind: 'built',
      seed: 'core-35',
      showPublicly: false,
    });
    expect(readAvatarChoice({ kind: 'photo' }).showPublicly).toBe(false);
  });

  it('reads showPublicly as true only when it is exactly true', () => {
    expect(readAvatarChoice({ kind: 'initials', showPublicly: true }).showPublicly).toBe(true);
    for (const value of ['true', 1, 'yes', {}, null]) {
      expect(readAvatarChoice({ kind: 'initials', showPublicly: value }).showPublicly).toBe(false);
    }
  });

  it('falls back to initials for anything it cannot draw', () => {
    expect(readAvatarChoice(null)).toBe(DEFAULT_AVATAR_CHOICE);
    expect(readAvatarChoice('built')).toBe(DEFAULT_AVATAR_CHOICE);
    expect(readAvatarChoice({ kind: 'portrait', showPublicly: false })).toEqual({
      kind: 'initials',
      showPublicly: false,
    });
    // A built choice with a seed outside the grammar has nothing to draw.
    expect(readAvatarChoice({ kind: 'built', seed: '../a.png', showPublicly: true })).toEqual({
      kind: 'initials',
      showPublicly: true,
    });
    expect(readAvatarChoice({ kind: 'built', showPublicly: false }).kind).toBe('initials');
  });

  it('keeps a photo choice without storing — or reading — any address', () => {
    const choice = readAvatarChoice({
      kind: 'photo',
      showPublicly: false,
      url: 'https://lh3.googleusercontent.com/a/x',
    });
    expect(choice).toEqual({ kind: 'photo', showPublicly: false });
  });
});

describe('AVATAR_SEED_PATTERN', () => {
  it('matches a set name and two digits, and nothing looser', () => {
    for (const seed of ['core-00', 'core-35', 'a-99', 'abcdefgh-07']) {
      expect(AVATAR_SEED_PATTERN.test(seed)).toBe(true);
    }
    for (const seed of ['core-7', 'core-007', 'Core-35', 'abcdefghi-35', 'core_35', 'core-35x']) {
      expect(AVATAR_SEED_PATTERN.test(seed)).toBe(false);
    }
  });
});

describe('providerPhotoUrl', () => {
  it('passes a photo on Google’s image host through untouched', () => {
    const url = 'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c';
    expect(providerPhotoUrl(url)).toBe(url);
  });

  /**
   * The CSP admits that one host, so a photo anywhere else can only ever be
   * refused — and offering a choice that resolves to nothing is worse than not
   * offering it (`FEAT-038` §1).
   */
  it('refuses a photo anywhere else, however it is dressed up', () => {
    for (const url of [
      'https://graph.facebook.com/123/picture',
      'https://avatars.githubusercontent.com/u/1',
      'http://lh3.googleusercontent.com/a/x',
      'https://lh3.googleusercontent.com.evil.example/a',
      'https://lh3.googleusercontent.com@evil.example/a',
      'https://lh4.googleusercontent.com/a/x',
      'not a url',
      '',
    ]) {
      expect(providerPhotoUrl(url)).toBeNull();
    }
    expect(providerPhotoUrl(null)).toBeNull();
    expect(providerPhotoUrl(undefined)).toBeNull();
  });
});

describe('avatarLetter', () => {
  it('takes the first letter of the name, else of the email, uppercased', () => {
    expect(avatarLetter({ displayName: 'ada', email: 'x@example.com' })).toBe('A');
    expect(avatarLetter({ displayName: '', email: 'grace@example.com' })).toBe('G');
    expect(avatarLetter({ displayName: '  bo ' })).toBe('B');
  });

  it('falls back to a question mark when there is nothing to take one from', () => {
    expect(avatarLetter(null)).toBe('?');
    expect(avatarLetter({ displayName: null, email: null })).toBe('?');
  });
});
