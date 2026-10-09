import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallerStanding,
  type CallerToken,
  PLAYER_SIGN_IN_PROVIDERS,
  callerStanding,
  gameResultRefusal,
  isVerifiedPlayer,
} from './caller-gate';

/**
 * The caller gate every callable that writes about a player applies
 * (`caller-gate.ts`), tested as a table: provider by provider, and for a
 * password account by verification state.
 *
 * **The expected lists are written out, never read from the module.** A row
 * derived from `PLAYER_SIGN_IN_PROVIDERS` would shrink with it, so dropping a
 * provider from the gate would pass the very test that exists to notice — the
 * shape of the defect this module was written to close, where five providers
 * were refused and nothing went red.
 */

/** The seven OAuth providers the app renders a button for, besides email and password. */
const OAUTH_PROVIDERS = [
  'google.com',
  'facebook.com',
  'github.com',
  'microsoft.com',
  'apple.com',
  'twitter.com',
  'yahoo.com',
];

function token(provider: unknown, emailVerified?: unknown): CallerToken {
  return {
    firebase: { sign_in_provider: provider },
    ...(emailVerified === undefined ? {} : { email_verified: emailVerified }),
  };
}

describe('callerStanding', () => {
  // Accept cases first (`CLAUDE.md` §4.6): every refusal below is "not
  // verified", which a gate that refused everybody would also satisfy.
  it('stands every OAuth provider the app offers as verified, whatever the token says about the email', () => {
    for (const provider of OAUTH_PROVIDERS) {
      for (const emailVerified of [true, false, undefined]) {
        assert.equal(
          callerStanding(token(provider, emailVerified)),
          'verified',
          `${provider}, email_verified=${String(emailVerified)}`,
        );
      }
    }
  });

  it('stands a password account as verified once its address is', () => {
    assert.equal(callerStanding(token('password', true)), 'verified');
  });

  /**
   * Only the boolean `true` counts, as in `firestore.rules`, where
   * `email_verified == true` does not coerce: a string or a number in the claim
   * is a token nothing in Firebase mints, and it must not pass for one.
   */
  it('stands a password account whose address is not verified as unverified-email', () => {
    for (const emailVerified of [false, undefined, null, 'true', 1, {}]) {
      assert.equal(
        callerStanding(token('password', emailVerified)),
        'unverified-email',
        `email_verified=${JSON.stringify(emailVerified)}`,
      );
    }
  });

  it('stands an anonymous session as anonymous, whatever else its token carries', () => {
    for (const emailVerified of [undefined, true, false]) {
      assert.equal(callerStanding(token('anonymous', emailVerified)), 'anonymous');
    }
  });

  /**
   * Fail closed: Firebase signs a token for any provider enabled in the
   * console, and none of these is wired into the app. Spellings that differ
   * from an allowed one only by case or a space are here too — the list is
   * matched exactly, never normalised.
   */
  it('refuses every provider the app does not offer', () => {
    for (const provider of [
      'phone',
      'custom',
      'oidc.example',
      'saml.example',
      'playgames.google.com',
      'gc.apple.com',
      'Google.com',
      'google.com ',
      'password ',
      'firebase',
      '',
    ]) {
      assert.equal(callerStanding(token(provider, true)), 'unsupported-provider', provider);
    }
  });

  it('fails closed on a token that names no provider', () => {
    const shapeless: (CallerToken | undefined)[] = [
      undefined,
      {},
      { firebase: {} },
      { firebase: { sign_in_provider: null } },
      { firebase: { sign_in_provider: 7 } },
      { firebase: { sign_in_provider: ['google.com'] } },
      { firebase: { sign_in_provider: { id: 'google.com' } } },
      { email_verified: true },
    ];
    for (const shape of shapeless) {
      assert.equal(callerStanding(shape), 'unsupported-provider', JSON.stringify(shape));
    }
  });
});

describe('PLAYER_SIGN_IN_PROVIDERS', () => {
  /**
   * The same eight `auth.service.spec.ts` pins against the buttons the auth
   * menu renders. Pinned here too, so a ninth added to the gate alone is a red
   * row in this package rather than only in the app's.
   */
  it('names exactly the eight providers the app offers', () => {
    assert.deepEqual([...PLAYER_SIGN_IN_PROVIDERS].sort(), ['password', ...OAUTH_PROVIDERS].sort());
  });
});

describe('what each callable admits', () => {
  const STANDINGS: CallerStanding[] = [
    'verified',
    'unverified-email',
    'anonymous',
    'unsupported-provider',
  ];

  /** `setAvatar`: the whole gate, which is `isRealAuthedUser()` on the allowlist. */
  it('admits only a verified caller to a write that requires the whole gate', () => {
    assert.deepEqual(
      STANDINGS.filter((standing) => isVerifiedPlayer(standing)),
      ['verified'],
    );
  });
});

/**
 * `recordGameResult`'s caller decision: every account the app signs in is
 * banked, a password account that has not verified its address yet included
 * — `gameResultRefusal` and `docs/data-model.md` say why — and a guest or a
 * provider the app does not offer is refused, with the reason the client acts
 * on.
 */
describe('gameResultRefusal', () => {
  // Accept cases first (`CLAUDE.md` §4.6).
  it('banks a game for every provider the app offers', () => {
    for (const provider of OAUTH_PROVIDERS) {
      assert.equal(gameResultRefusal(token(provider)), null, provider);
    }
    assert.equal(gameResultRefusal(token('password', true)), null);
  });

  it('banks a game for a password account whose address is not verified yet', () => {
    for (const emailVerified of [false, undefined]) {
      assert.equal(gameResultRefusal(token('password', emailVerified)), null);
    }
  });

  it('refuses a guest, naming the reason the client keeps quiet about', () => {
    assert.deepEqual(gameResultRefusal(token('anonymous')), {
      recorded: false,
      reason: 'anonymous',
      provider: 'anonymous',
    });
  });

  it('refuses a provider the app does not offer, naming it for the client to log', () => {
    assert.deepEqual(gameResultRefusal(token('playgames.google.com', true)), {
      recorded: false,
      reason: 'unsupported-provider',
      provider: 'playgames.google.com',
    });
  });

  it('refuses a token that names no provider, and says it named none', () => {
    for (const shape of [undefined, {}, { firebase: { sign_in_provider: 7 } }]) {
      assert.deepEqual(
        gameResultRefusal(shape),
        { recorded: false, reason: 'unsupported-provider', provider: null },
        JSON.stringify(shape),
      );
    }
  });
});

/**
 * The gate against `isRealAuthedUser()` in `firestore.rules`, clause by clause,
 * over every token shape above. The rules' predicate is transcribed rather than
 * evaluated — the rules suite owns the real one — and the transcription is the
 * point: it states the one difference on purpose, so a second one cannot creep
 * in unremarked. The rules admit **any** provider that is not `anonymous`; the
 * gate admits the eight the app offers. Every other clause agrees.
 */
describe('isRealAuthedUser(), clause by clause', () => {
  function rulesAdmit(caller: CallerToken): boolean {
    const provider = caller.firebase?.sign_in_provider;
    // `request.auth.token.firebase.sign_in_provider` on a token without one is
    // an error in the rules language, and an erroring rule denies.
    if (provider === undefined || provider === null) {
      return false;
    }
    return provider !== 'anonymous' && (provider !== 'password' || caller.email_verified === true);
  }

  it('agrees on every provider the app offers, and differs only by refusing the rest', () => {
    const providers = [...OAUTH_PROVIDERS, 'password', 'anonymous', 'phone', 'custom', 'oidc.x'];
    for (const provider of providers) {
      for (const emailVerified of [true, false, undefined, 'true']) {
        const caller = token(provider, emailVerified);
        const offered = provider === 'password' || OAUTH_PROVIDERS.includes(provider);
        assert.equal(
          isVerifiedPlayer(callerStanding(caller)),
          rulesAdmit(caller) && offered,
          `${provider}, email_verified=${JSON.stringify(emailVerified)}`,
        );
      }
    }
  });
});
