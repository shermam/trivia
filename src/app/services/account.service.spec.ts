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
      return Promise.resolve({ data: { recorded: true } });
    };
  },
}));

function setup(options: { authReadyError?: unknown } = {}) {
  h.calls.length = 0;
  h.events.length = 0;
  h.importError = null;
  h.callableError = null;
  h.importCount = 0;

  const whenAuthStateReady = vi.fn(async () => {
    h.events.push('authReady');
    if (options.authReadyError) {
      throw options.authReadyError;
    }
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
      { provide: AuthService, useValue: { whenAuthStateReady, signOut: vi.fn() } },
    ],
  });

  return { service: TestBed.inject(AccountService), whenAuthStateReady };
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
    const { service, whenAuthStateReady } = setup();

    await service.recordGameResult(result);

    expect(whenAuthStateReady).toHaveBeenCalledOnce();
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
   * names it. `SubscriptionService.getProPriceId` has the correct one.
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
