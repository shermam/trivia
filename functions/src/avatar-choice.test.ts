import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AVATAR_PROVIDERS,
  type AvatarCaller,
  type AvatarChoice,
  applyAvatarChoice,
  decideAvatarChoice,
  parseAvatarChoice,
} from './avatar-choice';

/**
 * `setAvatar`'s whole decision (`FEAT-038`), tested directly because it is the
 * only thing standing where a `firestore.rules` block would otherwise be:
 * `users/{uid}` has no client write path, so the caller gate, the kind, the
 * seed and the switch are all checked here or nowhere (`CLAUDE.md` §4.6).
 */

function caller(
  provider: string | undefined,
  overrides: { uid?: string; emailVerified?: unknown } = {},
): AvatarCaller {
  return {
    uid: overrides.uid ?? 'player-1',
    token: {
      ...(provider === undefined ? {} : { firebase: { sign_in_provider: provider } }),
      ...('emailVerified' in overrides ? { email_verified: overrides.emailVerified } : {}),
    },
  };
}

const google = caller('google.com');
const verifiedPassword = caller('password', { emailVerified: true });

describe('decideAvatarChoice', () => {
  // Accept cases first (`CLAUDE.md` §4.6): every refusal below is "not ok",
  // which a decision that refused everything would also satisfy.
  it('accepts each kind from a Google account', () => {
    assert.deepEqual(decideAvatarChoice(google, { kind: 'initials', showPublicly: false }), {
      ok: true,
      uid: 'player-1',
      choice: { kind: 'initials', showPublicly: false },
    });
    assert.deepEqual(decideAvatarChoice(google, { kind: 'photo', showPublicly: true }), {
      ok: true,
      uid: 'player-1',
      choice: { kind: 'photo', showPublicly: true },
    });
    assert.deepEqual(
      decideAvatarChoice(google, { kind: 'built', seed: 'core-35', showPublicly: false }),
      {
        ok: true,
        uid: 'player-1',
        choice: { kind: 'built', seed: 'core-35', showPublicly: false },
      },
    );
  });

  it('accepts a password account whose email is verified', () => {
    const decision = decideAvatarChoice(verifiedPassword, {
      kind: 'initials',
      showPublicly: false,
    });
    assert.equal(decision.ok, true);
  });

  /**
   * Every provider the app offers, by name. The picker is shown to every
   * signed-in account, so a provider missing here is a player shown a control
   * the server then refuses — the client gate broader than the server's
   * (`CLAUDE.md` §4.2).
   */
  it('accepts every provider the app offers a sign-in button for', () => {
    for (const provider of [
      'google.com',
      'facebook.com',
      'github.com',
      'microsoft.com',
      'apple.com',
      'twitter.com',
      'yahoo.com',
    ]) {
      const decision = decideAvatarChoice(caller(provider), {
        kind: 'initials',
        showPublicly: false,
      });
      assert.equal(decision.ok, true, provider);
    }
    assert.equal(AVATAR_PROVIDERS.size, 8);
  });

  it('takes the uid from the verified caller, never from the payload', () => {
    // An unknown key refuses the call outright, so a `uid` in the payload can
    // never be read — let alone preferred over the token's.
    const decision = decideAvatarChoice(caller('google.com', { uid: 'me' }), {
      kind: 'initials',
      showPublicly: false,
      uid: 'someone-else',
    });
    assert.equal(decision.ok, false);

    const accepted = decideAvatarChoice(caller('google.com', { uid: 'me' }), {
      kind: 'initials',
      showPublicly: false,
    });
    assert.ok(accepted.ok);
    assert.equal(accepted.uid, 'me');
  });

  it('refuses a call with no signed-in caller', () => {
    const decision = decideAvatarChoice(undefined, { kind: 'initials', showPublicly: false });
    assert.equal(decision.ok, false);
    assert.equal(!decision.ok && decision.code, 'unauthenticated');
  });

  /**
   * An anonymous session has no `users/{uid}` and must never get one: nothing
   * would ever delete it, because `deleteAccount` never runs for a guest and
   * Firebase's own clean-up removes only the Auth record (`docs/data-model.md`).
   */
  it('refuses an anonymous session', () => {
    const decision = decideAvatarChoice(caller('anonymous'), {
      kind: 'initials',
      showPublicly: false,
    });
    assert.equal(!decision.ok && decision.code, 'permission-denied');
  });

  it('refuses a password account whose email is not verified', () => {
    for (const emailVerified of [false, undefined, 'true', 1]) {
      const decision = decideAvatarChoice(caller('password', { emailVerified }), {
        kind: 'initials',
        showPublicly: false,
      });
      assert.equal(!decision.ok && decision.code, 'permission-denied', String(emailVerified));
    }
  });

  it('refuses a provider nobody has enabled, and a token that names none', () => {
    for (const provider of ['phone', 'custom', 'oidc.example', undefined]) {
      const decision = decideAvatarChoice(caller(provider), {
        kind: 'initials',
        showPublicly: false,
      });
      assert.equal(!decision.ok && decision.code, 'permission-denied', String(provider));
    }
  });

  it('checks the caller before the payload', () => {
    // A refusal names the first thing wrong, and "who are you" comes first: an
    // anonymous caller with a malformed payload is told they may not choose,
    // not that their payload was bad.
    const decision = decideAvatarChoice(caller('anonymous'), { kind: 'portrait' });
    assert.equal(!decision.ok && decision.code, 'permission-denied');
  });

  it('refuses an invalid payload as invalid-argument', () => {
    const decision = decideAvatarChoice(google, { kind: 'portrait', showPublicly: false });
    assert.equal(!decision.ok && decision.code, 'invalid-argument');
  });
});

describe('parseAvatarChoice', () => {
  it('rebuilds a valid payload key by key', () => {
    const payload = { kind: 'built', seed: 'core-07', showPublicly: true };
    const choice = parseAvatarChoice(payload);
    assert.deepEqual(choice, payload);
    assert.notEqual(choice, payload);
  });

  it('refuses a kind outside the three', () => {
    for (const kind of ['portrait', 'Initials', '', null, undefined, 3, ['built']]) {
      assert.equal(parseAvatarChoice({ kind, showPublicly: false }), null, String(kind));
    }
  });

  it('refuses a seed on any kind but built', () => {
    assert.equal(
      parseAvatarChoice({ kind: 'initials', seed: 'core-00', showPublicly: false }),
      null,
    );
    assert.equal(parseAvatarChoice({ kind: 'photo', seed: 'core-00', showPublicly: false }), null);
  });

  /**
   * The callable SDK encodes a present-but-`undefined` key as `null`, so a
   * client that wrote `{ kind: 'initials', seed: undefined }` arrives with a
   * `null` seed. That is the absence it meant, not a seed.
   */
  it('reads a null seed as no seed', () => {
    assert.deepEqual(parseAvatarChoice({ kind: 'initials', seed: null, showPublicly: false }), {
      kind: 'initials',
      showPublicly: false,
    });
    assert.equal(parseAvatarChoice({ kind: 'built', seed: null, showPublicly: false }), null);
  });

  it('refuses a built avatar with no seed', () => {
    assert.equal(parseAvatarChoice({ kind: 'built', showPublicly: false }), null);
  });

  it('refuses a seed outside the pattern', () => {
    for (const seed of [
      '',
      'core',
      'core-',
      'core-7',
      'core-007',
      'Core-07',
      'core_07',
      'core-0a',
      'abcdefghi-07',
      '-07',
      'core-07 ',
      ' core-07',
      'core-07\n',
      'https://example.com/a.png',
      7,
      ['core-07'],
    ]) {
      assert.equal(
        parseAvatarChoice({ kind: 'built', seed, showPublicly: false }),
        null,
        JSON.stringify(seed),
      );
    }
  });

  it('accepts a seed at both ends of the pattern', () => {
    for (const seed of ['a-00', 'abcdefgh-99']) {
      assert.ok(parseAvatarChoice({ kind: 'built', seed, showPublicly: false }), seed);
    }
  });

  it('refuses a switch that is not a boolean, or is missing', () => {
    for (const showPublicly of ['true', 'false', 1, 0, null, undefined]) {
      assert.equal(
        parseAvatarChoice({ kind: 'initials', showPublicly }),
        null,
        String(showPublicly),
      );
    }
    assert.equal(parseAvatarChoice({ kind: 'initials' }), null);
  });

  it('refuses a key it does not know', () => {
    assert.equal(
      parseAvatarChoice({ kind: 'photo', showPublicly: false, photoUrl: 'https://x.test/a' }),
      null,
    );
    assert.equal(
      parseAvatarChoice(JSON.parse('{"kind":"initials","showPublicly":false,"__proto__":{}}')),
      null,
    );
  });

  it('refuses a payload that is not an object', () => {
    for (const payload of [null, undefined, 'initials', 7, true, [], ['initials']]) {
      assert.equal(parseAvatarChoice(payload), null, JSON.stringify(payload));
    }
  });
});

describe('applyAvatarChoice', () => {
  /**
   * The option is the whole point of this function. A plain `set` would
   * replace `users/{uid}` and erase the lifetime totals; `merge: true` merges
   * maps deeply, so a stored `seed` would survive under a later `initials`.
   * `mergeFields: ['avatar']` replaces the one field whole. What that does to a
   * real document is asserted against the emulator in
   * `e2e/specs/authenticated/avatar-choice.spec.ts`.
   */
  it('replaces the avatar field whole and names nothing else', async () => {
    const calls: unknown[][] = [];
    const ref = {
      set: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    } as unknown as Parameters<typeof applyAvatarChoice>[0];
    const choice: AvatarChoice = { kind: 'initials', showPublicly: false };

    await applyAvatarChoice(ref, choice);

    assert.deepEqual(calls, [[{ avatar: choice }, { mergeFields: ['avatar'] }]]);
  });
});
