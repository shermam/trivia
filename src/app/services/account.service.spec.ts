import { TestBed } from '@angular/core/testing';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { FirebaseAppService } from './firebase-app.service';

/**
 * `AccountService` had no spec at all, while holding account deletion, data
 * export and now the lifetime-stats write — which `CLAUDE.md` §4.6 asks for
 * outright ("a new or changed service holding auth, entitlement, or payment
 * logic ships with a spec").
 *
 * The two behaviours pinned here are both bugs that shipped, not hypotheticals:
 * a callable invoked before auth had settled, and a memoized promise that was
 * never cleared on rejection.
 *
 * `firebase/functions` is faked at the module boundary, the same seam
 * `auth.service.spec.ts` and the Firestore specs use.
 */

const h = vi.hoisted(() => ({
  calls: [] as { name: string; payload: unknown; options: unknown }[],
  /** Ordered log of *everything*, so the assertions can be about sequence. */
  events: [] as string[],
  importError: null as unknown,
  callableError: null as unknown,
  importCount: 0,
  /** What `recordGameResult` answers — the server's verdict on the game. */
  recordAnswer: { recorded: true } as unknown,
}));

vi.mock('firebase/functions', () => ({
  getFunctions: () => ({ __fake: true }),
  connectFunctionsEmulator: () => undefined,
  httpsCallable: (_functions: unknown, name: string, options: unknown) => {
    return (payload: unknown) => {
      h.events.push(`call:${name}`);
      h.calls.push({ name, payload, options });
      if (h.callableError) {
        return Promise.reject(h.callableError);
      }
      // `setAvatar` answers with the choice it stored, `recordGameResult` with
      // its verdict; everything else here only needs to resolve.
      return Promise.resolve({
        data: name === 'setAvatar' ? { avatar: payload } : h.recordAnswer,
      });
    };
  },
}));

type Account = { uid: string; isAnonymous: boolean } | null;

function setup(options: { authReadyError?: unknown; account?: Account } = {}) {
  h.calls.length = 0;
  h.events.length = 0;
  h.importError = null;
  h.callableError = null;
  h.importCount = 0;
  h.recordAnswer = { recorded: true };

  // A signed-in account unless a test says otherwise: the refusal handling
  // below is about accounts, and a guest is the case a test opts into.
  const account: Account =
    'account' in options ? (options.account ?? null) : { uid: 'player-1', isAnonymous: false };
  const currentAccount = vi.fn(async () => {
    h.events.push('authReady');
    if (options.authReadyError) {
      throw options.authReadyError;
    }
    return account;
  });

  TestBed.configureTestingModule({
    providers: [
      {
        provide: FirebaseAppService,
        useValue: {
          getApp: vi.fn(async () => {
            h.importCount += 1;
            h.events.push('getApp');
            if (h.importError) {
              throw h.importError;
            }
            return { __fakeApp: true };
          }),
        },
      },
      { provide: AuthService, useValue: { currentAccount, signOut: vi.fn() } },
    ],
  });

  return { service: TestBed.inject(AccountService), currentAccount };
}

afterEach(() => TestBed.resetTestingModule());

describe('AccountService.recordGameResult', () => {
  const result = { gameId: 'g1', totalQuestions: 5, correctAnswers: 4, bestStreak: 3 };

  /**
   * **The ordering bug, and the reason this spec exists.**
   *
   * The Functions SDK attaches whatever ID token exists at invocation time,
   * and `auth.currentUser` reads `null` for a moment after bootstrap even for
   * an already-signed-in user — persistence restores asynchronously. A
   * callable fired inside that window arrives **unauthenticated** and is
   * refused, silently, because this call is fire-and-forget.
   *
   * It shipped that way and CI caught it: `recordGameResult` finishing in ~5ms
   * with no auth verification, on a freshly loaded `/game-over`. Since
   * reloading `/game-over` is a supported flow, the effect was a real player's
   * game silently missing from their totals.
   *
   * Asserted as a *sequence*, not as "was called" — the bug is entirely about
   * order, so a test that only checked both happened would pass against it.
   */
  it('waits for auth to settle before invoking the callable', async () => {
    const { service, currentAccount } = setup();

    await service.recordGameResult(result);

    expect(currentAccount).toHaveBeenCalledOnce();
    expect(h.events.indexOf('authReady')).toBeLessThan(h.events.indexOf('call:recordGameResult'));
  });

  it('sends the game payload, with a timeout', () => {
    const { service } = setup();

    return service.recordGameResult(result).then(() => {
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0].payload).toEqual(result);
      // A fire-and-forget call needs a timeout *more* than an awaited one:
      // nothing is waiting, so an abandoned request would hold a connection
      // open for a result nobody reads (`CLAUDE.md` §4.4).
      expect(h.calls[0].options).toMatchObject({ timeout: expect.any(Number) });
    });
  });

  /**
   * Never throws, whatever fails. `/game-over` renders from local state and
   * calls this without awaiting it — a rejection would surface as an unhandled
   * promise rejection on a screen that is working perfectly.
   */
  it('resolves quietly when the callable fails', async () => {
    const { service } = setup();
    h.callableError = new Error('unauthenticated');

    await expect(service.recordGameResult(result)).resolves.toBeUndefined();
  });

  it('resolves quietly when auth never settles', async () => {
    const { service } = setup({ authReadyError: new Error('offline') });

    await expect(service.recordGameResult(result)).resolves.toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });

  it('resolves quietly when the Firebase app cannot be reached', async () => {
    const { service } = setup();
    h.importError = new Error('chunk load failed');

    await expect(service.recordGameResult(result)).resolves.toBeUndefined();
  });
});

/**
 * What the callable's answer means, which used to be nothing at all: the
 * answer was never read, so a signed-in player whose games the server refused
 * — every GitHub, Microsoft, Apple, Twitter/X and Yahoo account — got no
 * totals and no sign that anything had gone wrong (`docs/data-model.md`,
 * `users`). A refusal of a signed-in account is now logged with the server's
 * reason and held for `/profile`; a guest's, and a game already banked, are
 * the design and say nothing.
 */
describe('AccountService.recordGameResult reading the answer', () => {
  const result = { gameId: 'g1', totalQuestions: 5, correctAnswers: 4, bestStreak: 3 };

  const silenceConsoleError = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let consoleError: ReturnType<typeof silenceConsoleError>;
  beforeEach(() => {
    consoleError = silenceConsoleError();
  });
  afterEach(() => consoleError.mockRestore());

  // The accept case first (`CLAUDE.md` §4.6): a handler that flagged every
  // answer would pass every refusal row below.
  it('notes nothing when the game is banked', async () => {
    const { service } = setup();

    await service.recordGameResult(result);

    expect(service.unbankedGame()).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("reports a signed-in account's refused game, with the server's reason", async () => {
    const { service } = setup({ account: { uid: 'player-1', isAnonymous: false } });
    h.recordAnswer = { recorded: false, reason: 'unsupported-provider', provider: 'oidc.example' };

    await service.recordGameResult(result);

    expect(service.unbankedGame()).toEqual({ uid: 'player-1', reason: 'unsupported-provider' });
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0][0])).toContain('unsupported-provider');
    expect(String(consoleError.mock.calls[0][0])).toContain('oidc.example');
  });

  /**
   * The server's daily ceiling (`functions/src/daily-ceiling.ts`) refuses with
   * a reason `/profile` has words of its own for, so it has to arrive there
   * exactly as the server gave it.
   */
  it('holds a refusal for the daily ceiling with its reason, for /profile to name', async () => {
    const { service } = setup({ account: { uid: 'player-1', isAnonymous: false } });
    h.recordAnswer = { recorded: false, reason: 'daily-limit' };

    await service.recordGameResult(result);

    expect(service.unbankedGame()).toEqual({ uid: 'player-1', reason: 'daily-limit' });
    expect(String(consoleError.mock.calls[0][0])).toContain('daily-limit');
  });

  it('reports every refusal of a signed-in account it was not built to expect', async () => {
    for (const reason of ['invalid', 'rate-limited', 'anonymous', 'a-reason-from-a-newer-server']) {
      const { service } = setup();
      h.recordAnswer = { recorded: false, reason };

      await service.recordGameResult(result);

      expect(service.unbankedGame(), reason).toEqual({ uid: 'player-1', reason });
      TestBed.resetTestingModule();
    }
  });

  /**
   * Whatever reason it carries: this server says `anonymous`, an older one said
   * `unsupported-provider`, and a preview channel talks to whichever functions
   * `main` last deployed. Deciding from the account is what keeps every guest's
   * game from reading as a gap — and from putting a `console.error` on every
   * game an anonymous e2e spec plays, which the preview slice's console checks
   * would fail on.
   */
  it("says nothing about a guest's refused game, whichever reason the server gives", async () => {
    for (const reason of ['anonymous', 'unsupported-provider']) {
      const { service } = setup({ account: { uid: 'guest-1', isAnonymous: true } });
      h.recordAnswer = { recorded: false, reason };

      await service.recordGameResult(result);

      expect(service.unbankedGame(), reason).toBeNull();
      TestBed.resetTestingModule();
    }
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('reads a duplicate as banked — a reload of /game-over re-sends a game that counted', async () => {
    const { service } = setup();
    h.recordAnswer = { recorded: false, reason: 'duplicate' };

    await service.recordGameResult(result);

    expect(service.unbankedGame()).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("clears the note once the same account's next game banks", async () => {
    const { service } = setup();
    h.recordAnswer = { recorded: false, reason: 'unsupported-provider' };
    await service.recordGameResult(result);
    expect(service.unbankedGame()).not.toBeNull();

    h.recordAnswer = { recorded: true };
    await service.recordGameResult({ ...result, gameId: 'g2' });

    expect(service.unbankedGame()).toBeNull();
  });

  it('does not report an answer it cannot read, nor a call that never reached the server', async () => {
    for (const answer of [null, {}, { recorded: 'no' }]) {
      const { service } = setup();
      h.recordAnswer = answer;

      await service.recordGameResult(result);

      expect(service.unbankedGame(), JSON.stringify(answer)).toBeNull();
      TestBed.resetTestingModule();
    }

    // A timeout is not a refusal: the SDK's timeout cancels nothing, so the
    // game may well have landed.
    const { service } = setup();
    h.callableError = Object.assign(new Error('timeout'), { code: 'functions/deadline-exceeded' });
    await service.recordGameResult(result);

    expect(service.unbankedGame()).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

/**
 * `FEAT-041`: a banked game's answer carries the player's XP after it and what
 * the game added, and `/profile` says when the last game crossed a level from
 * that and nothing else — so what is kept, for whom, and when it is dropped
 * are pinned here.
 */
describe('AccountService.recordGameResult noting the XP', () => {
  const result = { gameId: 'g1', totalQuestions: 5, correctAnswers: 4, bestStreak: 3 };

  const silenceConsoleError = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let consoleError: ReturnType<typeof silenceConsoleError>;
  beforeEach(() => {
    consoleError = silenceConsoleError();
  });
  afterEach(() => consoleError.mockRestore());

  it('keeps the XP a banked game came to, for the account it was banked for', async () => {
    const { service } = setup();
    h.recordAnswer = { recorded: true, xp: 650, xpGained: 60 };

    await service.recordGameResult(result);

    expect(service.bankedXp()).toEqual({ uid: 'player-1', xp: 650, gained: 60 });
  });

  it('keeps nothing for a guest', async () => {
    const { service } = setup({ account: { uid: 'guest-1', isAnonymous: true } });
    h.recordAnswer = { recorded: true, xp: 650, xpGained: 60 };

    await service.recordGameResult(result);

    expect(service.bankedXp()).toBeNull();
  });

  /**
   * An answer from a server older than the XP, or one this build cannot read,
   * says nothing about the game it answers — and the note about the game
   * before would then be about a game that is no longer the last one.
   */
  it('drops the note when a fresh game banks without an XP it can read', async () => {
    for (const answer of [
      { recorded: true },
      { recorded: true, xp: '650', xpGained: 60 },
      { recorded: true, xp: 650, xpGained: -1 },
      { recorded: true, xp: 50, xpGained: 60 },
      { recorded: true, xp: 650.5, xpGained: 60 },
    ]) {
      const { service } = setup();
      h.recordAnswer = { recorded: true, xp: 590, xpGained: 40 };
      await service.recordGameResult(result);

      h.recordAnswer = answer;
      await service.recordGameResult({ ...result, gameId: 'g2' });

      expect(service.bankedXp(), JSON.stringify(answer)).toBeNull();
      TestBed.resetTestingModule();
    }
  });

  it('leaves the note alone for a duplicate, which repeats a game already noted', async () => {
    const { service } = setup();
    h.recordAnswer = { recorded: true, xp: 650, xpGained: 60 };
    await service.recordGameResult(result);

    h.recordAnswer = { recorded: false, reason: 'duplicate' };
    await service.recordGameResult(result);

    expect(service.bankedXp()).toEqual({ uid: 'player-1', xp: 650, gained: 60 });
  });

  it('drops the note when the next game is refused, which earned nothing', async () => {
    const { service } = setup();
    h.recordAnswer = { recorded: true, xp: 650, xpGained: 60 };
    await service.recordGameResult(result);

    h.recordAnswer = { recorded: false, reason: 'rate-limited' };
    await service.recordGameResult({ ...result, gameId: 'g2' });

    expect(service.bankedXp()).toBeNull();
  });
});

describe('AccountService functions bootstrap', () => {
  const result = { gameId: 'g1', totalQuestions: 5, correctAnswers: 4, bestStreak: 3 };

  /**
   * **Never cache a rejected promise** (`CLAUDE.md` §4.4). This memoized the
   * dynamic `firebase/functions` import plus the runtime-config fetch with no
   * `.catch` clearing it, so **one** failed chunk fetch was replayed for the
   * life of the tab — permanently disabling Export and Delete account, not
   * just the call that failed.
   *
   * The third instance of this exact pattern in this repo, which is why §4.4
   * names it. `SubscriptionService.getProPrices` has the correct one.
   */
  it('retries the bootstrap after a failure instead of replaying it forever', async () => {
    const { service } = setup();

    h.importError = new Error('chunk load failed');
    await service.recordGameResult(result);
    expect(h.importCount, 'bootstrap attempted once').toBe(1);

    // The blip clears. Asserted on the bootstrap being **re-attempted**, which
    // is exactly what the `.catch` buys and all it buys: a cached rejection is
    // replayed without re-running anything, so `importCount` stays at 1 and
    // this row is the one that notices. Deliberately not asserted via the
    // callable — after a rejected dynamic import the re-import resolves to the
    // *real* `firebase/functions` here rather than the module mock, which is a
    // property of the test harness and not of the service.
    h.importError = null;
    await service.recordGameResult(result);

    expect(h.importCount, 'bootstrap retried after the failure').toBe(2);
  });

  // ...and the successful bootstrap *is* still memoized, or the fix would have
  // traded one defect for a dynamic import on every call.
  it('reuses a successful bootstrap', async () => {
    const { service } = setup();

    await service.recordGameResult(result);
    await service.recordGameResult({ ...result, gameId: 'g2' });

    expect(h.calls).toHaveLength(2);
    expect(h.importCount).toBe(1);
  });
});

/**
 * `setAvatar` (`FEAT-038`). The payload is the part worth pinning: the server
 * refuses a `seed` on any kind but `built`, and the callable SDK encodes a
 * present-but-`undefined` key as `null` — so the key has to be absent, not
 * merely empty, for everything that is not a built avatar.
 */
describe('AccountService.setAvatar', () => {
  it('sends a built avatar with its seed, and returns what the server stored', async () => {
    const { service } = setup();

    const stored = await service.setAvatar({ kind: 'built', seed: 'core-35', showPublicly: true });

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].name).toBe('setAvatar');
    expect(h.calls[0].payload).toEqual({ kind: 'built', seed: 'core-35', showPublicly: true });
    expect(h.calls[0].options).toEqual({ timeout: 10_000 });
    expect(stored).toEqual({ kind: 'built', seed: 'core-35', showPublicly: true });
  });

  it('omits the seed key entirely for any other kind', async () => {
    const { service } = setup();

    // A stale seed on the object passed in must not travel.
    await service.setAvatar({ kind: 'photo', seed: 'core-35', showPublicly: false });

    expect(h.calls[0].payload).toEqual({ kind: 'photo', showPublicly: false });
    expect(Object.keys(h.calls[0].payload as object)).not.toContain('seed');
  });

  it('throws a message fit to show, keeping the SDK error as the cause', async () => {
    const { service } = setup();
    const refusal = Object.assign(new Error('gone'), { code: 'functions/not-found' });
    h.callableError = refusal;

    const error = (await service.setAvatar({ kind: 'initials', showPublicly: false }).then(
      () => null,
      (caught: unknown) => caught,
    )) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("isn't available on this deployment yet");
    expect(error.cause).toBe(refusal);
  });
});
