import { expect, test } from '../../fixtures/test';
import { CallerIdentity } from '../../fixtures/types';

/**
 * The shared caller gate (`functions/src/caller-gate.ts`), driven through the
 * two callables that apply it — `recordGameResult` and `setAvatar` — with a
 * real session for every sign-in provider the app offers, a guest, and a
 * provider it does not offer.
 *
 * **Why this exists.** `recordGameResult` once carried its own list of three
 * providers while `setAvatar` carried the eight, so a player signed in with
 * GitHub, Microsoft, Apple, Twitter/X or Yahoo had every finished game refused
 * — no totals, no play history, nothing counted into a question — while their
 * avatar saved. Nothing went red: every spec here signed in with email and
 * password, and the unit tests read each callable's own list. These rows go
 * through the deployed functions in the emulator with tokens the Auth emulator
 * signed, so they fail on the wiring as well as on the list — a callable that
 * stopped consulting the gate, or a token shape the gate misreads.
 *
 * **Over HTTP rather than through the screen**, because the screen can only
 * sign in with email and password here: the OAuth buttons open a popup this
 * suite has no provider behind. The Auth emulator signs a session for any
 * provider id from a fake token of plain JSON claims (`firebase.signInAs`),
 * and the callable is invoked the way `httpsCallable` invokes it. Every row
 * owns a fresh account, so the file is safe beside the rest of the run.
 *
 * Emulator-only by construction — a real project signs no fake token — and
 * outside the preview slice, which lists the authenticated specs it runs.
 */

const OFFERED_OAUTH = [
  'google.com',
  'facebook.com',
  'github.com',
  'microsoft.com',
  'apple.com',
  'twitter.com',
  'yahoo.com',
];

interface Row {
  name: string;
  identity: CallerIdentity;
  /** `null` when the game is banked, or the reason the refusal names. */
  refusal: null | 'anonymous' | 'unsupported-provider';
  choosesAvatar: boolean;
}

const ROWS: Row[] = [
  ...OFFERED_OAUTH.map((providerId): Row => ({
    name: providerId,
    identity: { kind: 'oauth', providerId },
    refusal: null,
    choosesAvatar: true,
  })),
  {
    name: 'password, verified',
    identity: { kind: 'password', emailVerified: true },
    refusal: null,
    choosesAvatar: true,
  },
  // The one row where the two callables part: the gate's email clause is
  // `setAvatar`'s and not `recordGameResult`'s (`docs/data-model.md`, `users`).
  {
    name: 'password, address not verified yet',
    identity: { kind: 'password', emailVerified: false },
    refusal: null,
    choosesAvatar: false,
  },
  {
    name: 'a guest',
    identity: { kind: 'anonymous' },
    refusal: 'anonymous',
    choosesAvatar: false,
  },
  // Listed in the Firebase console and signed for by Firebase, with no Web SDK
  // and no button in the app — the provider the allowlist exists to refuse.
  {
    name: 'a provider the app does not offer',
    identity: { kind: 'oauth', providerId: 'playgames.google.com' },
    refusal: 'unsupported-provider',
    choosesAvatar: false,
  },
];

const AVATAR = { kind: 'initials', showPublicly: false };

test.describe('the caller gate on the callables that write about a player', () => {
  for (const row of ROWS) {
    test(`${row.name}: ${row.refusal === null ? 'banks the game' : 'banks nothing'}, ${
      row.choosesAvatar ? 'saves an avatar' : 'is refused an avatar'
    }`, async ({ firebase }) => {
      const caller = await firebase.signInAs(row.identity);
      const gameId = `caller-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const recorded = await firebase.invokeCallable('recordGameResult', caller.idToken, {
        gameId,
        totalQuestions: 5,
        correctAnswers: 4,
        bestStreak: 3,
      });
      expect(recorded.status, JSON.stringify(recorded)).toBe(200);
      if (row.refusal === null) {
        expect(recorded.result).toEqual({ recorded: true });
      } else {
        // The reason, not just the refusal: the client says nothing about a
        // guest's refused game and reports anything else, so the two must not
        // arrive looking alike.
        expect(recorded.result).toMatchObject({ recorded: false, reason: row.refusal });
      }

      const avatar = await firebase.invokeCallable('setAvatar', caller.idToken, AVATAR);
      if (row.choosesAvatar) {
        expect(avatar.status, JSON.stringify(avatar)).toBe(200);
        expect(avatar.result).toEqual({ avatar: AVATAR });
      } else {
        expect(avatar.status, JSON.stringify(avatar)).toBe(403);
        expect(avatar.error?.status).toBe('PERMISSION_DENIED');
      }

      // What was kept, read back: a callable that answered right and wrote
      // nothing — or wrote for a caller it refused — passes both checks above.
      const { gameplayStats } = await firebase.inspectAccountState({ uid: caller.uid });
      if (row.refusal !== null && !row.choosesAvatar) {
        expect(gameplayStats, 'nothing is kept for a refused caller').toBeNull();
        return;
      }
      expect(gameplayStats?.['gamesPlayed']).toBe(row.refusal === null ? 1 : undefined);
      expect(gameplayStats?.['avatar']).toEqual(row.choosesAvatar ? AVATAR : undefined);
    });
  }
});
