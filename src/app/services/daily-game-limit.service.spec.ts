import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DAILY_FREE_GAME_LIMIT,
  DailyGameLimitService,
  localDateKey,
} from './daily-game-limit.service';
import { DAILY_LIMIT_KEY, DAILY_LIMIT_STORE, OfflineDbService } from './offline-db.service';
import { SubscriptionService } from './subscription.service';

/**
 * `FEAT-014`. A free player gets five games a day, counted on this device.
 *
 * The counter is not a security boundary and the spec says so — what these
 * cover is that it counts correctly, rolls over on the right day, and **never
 * takes the game down with it**. That last one is the case that decides whether
 * the app works in a private window, and it is the direction every storage
 * failure here has to fail in.
 */

/** Writes straight to the store, bypassing the service, to plant a stale or hostile record. */
function putRaw(record: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('trivia-offline'); // no version: whatever the service created
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(DAILY_LIMIT_STORE, 'readwrite');
      tx.objectStore(DAILY_LIMIT_STORE).put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error as Error);
      };
    };
    open.onerror = () => reject(open.error as Error);
  });
}

function readRaw(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('trivia-offline');
    open.onsuccess = () => {
      const db = open.result;
      const request = db
        .transaction(DAILY_LIMIT_STORE, 'readonly')
        .objectStore(DAILY_LIMIT_STORE)
        .get(DAILY_LIMIT_KEY);
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => {
        db.close();
        reject(request.error as Error);
      };
    };
    open.onerror = () => reject(open.error as Error);
  });
}

const today = () => localDateKey(new Date());

function configure(isPro: boolean, db?: Partial<OfflineDbService>): DailyGameLimitService {
  TestBed.configureTestingModule({
    providers: [
      { provide: SubscriptionService, useValue: { isProUser: () => isPro } },
      ...(db ? [{ provide: OfflineDbService, useValue: db }] : []),
    ],
  });
  return TestBed.inject(DailyGameLimitService);
}

describe('localDateKey', () => {
  /**
   * The reason this is not `toISOString().slice(0, 10)`. That renders the
   * **UTC** date, so west of Greenwich the counter would roll over before local
   * midnight and east of it, after — invisible in CI, invisible in London, and
   * wrong for most of the world.
   */
  it('uses the local date, not the UTC one', () => {
    expect(localDateKey(new Date(2026, 0, 2, 1, 30))).toBe('2026-01-02');
  });

  it('pads month and day so the key compares as a plain string', () => {
    expect(localDateKey(new Date(2026, 8, 5))).toBe('2026-09-05');
  });
});

describe('DailyGameLimitService', () => {
  let service: DailyGameLimitService;

  beforeEach(async () => {
    service = configure(false);
    // Touch the service first so it opens the database at the current version
    // and creates the store — `putRaw` opens without a version, so it would
    // otherwise race ahead of the schema and find nothing to write to.
    await service.refresh();
    // Then clear the counter, rather than trusting `afterEach` to have left it
    // clear. `ng test` runs with `--isolate` false, so every spec file in a
    // worker shares one `fake-indexeddb` — which means a *different* file can
    // leave a record here, and one did: `game-controller.service.spec.ts`
    // spent five real games through the unstubbed service and this suite's
    // first test then opened on an exhausted allowance. That file now stubs
    // the quota, and this reset makes the suite independent of whether the
    // next one to touch storage remembers to.
    await putRaw({ id: DAILY_LIMIT_KEY, date: '1970-01-01', count: 0 });
    await service.refresh();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await putRaw({ id: DAILY_LIMIT_KEY, date: '1970-01-01', count: 0 });
    await TestBed.inject(OfflineDbService).close();
    TestBed.resetTestingModule();
  });

  it('starts a fresh day with the full allowance', async () => {
    await service.refresh();

    expect(service.remaining()).toBe(DAILY_FREE_GAME_LIMIT);
    expect(service.hasGamesLeft()).toBe(true);
  });

  it('counts a consumed game against the allowance', async () => {
    expect(await service.consumeGame()).toBe(true);

    expect(service.remaining()).toBe(DAILY_FREE_GAME_LIMIT - 1);
  });

  it('survives a reload — the count is read back from storage', async () => {
    await service.consumeGame();
    await service.consumeGame();

    TestBed.resetTestingModule();
    const fresh = configure(false);
    await fresh.refresh();

    expect(fresh.remaining()).toBe(DAILY_FREE_GAME_LIMIT - 2);
  });

  it('refuses the game once the allowance is spent', async () => {
    await putRaw({ id: DAILY_LIMIT_KEY, date: today(), count: DAILY_FREE_GAME_LIMIT });

    expect(await service.consumeGame()).toBe(false);
    expect(service.hasGamesLeft()).toBe(false);
    expect(service.remaining()).toBe(0);
  });

  it('ignores a record written on a previous day', async () => {
    await putRaw({ id: DAILY_LIMIT_KEY, date: '2020-01-01', count: 99 });
    await service.refresh();

    expect(service.remaining()).toBe(DAILY_FREE_GAME_LIMIT);
    expect(await service.consumeGame()).toBe(true);
  });

  /** The rollover, driven by the clock rather than by waiting for one. */
  it('rolls over when midnight passes mid-session', async () => {
    // `toFake: ['Date']` and nothing else. Faking the whole timer set stalls
    // fake-indexeddb, which drives its requests off `setImmediate` — every
    // storage call then hangs until the test times out, which is not a failure
    // that names its own cause.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 4, 10, 23, 59));

    for (let i = 0; i < DAILY_FREE_GAME_LIMIT; i++) {
      await service.consumeGame();
    }
    expect(await service.consumeGame()).toBe(false);

    vi.setSystemTime(new Date(2026, 4, 11, 0, 1));
    await service.refresh();

    expect(service.remaining()).toBe(DAILY_FREE_GAME_LIMIT);
    expect(await service.consumeGame()).toBe(true);
  });

  it('treats a corrupt count as a fresh allowance rather than throwing', async () => {
    await putRaw({ id: DAILY_LIMIT_KEY, date: today(), count: 'lots' });
    await service.refresh();

    expect(service.remaining()).toBe(DAILY_FREE_GAME_LIMIT);
  });

  /**
   * The case that decides whether the app is playable in a private window.
   * Failing closed here turns a conversion nudge into a bounce.
   */
  it('grants a full allowance when storage cannot be opened at all', async () => {
    TestBed.resetTestingModule();
    const offline = configure(false, {
      open: () => Promise.reject(new Error('no storage')),
      close: () => Promise.resolve(),
    } as Partial<OfflineDbService>);

    await offline.refresh();

    expect(offline.remaining()).toBe(DAILY_FREE_GAME_LIMIT);
    expect(await offline.consumeGame()).toBe(true);
  });

  describe('Pro', () => {
    it('is unlimited, and does not spend a count it might later need', async () => {
      await putRaw({ id: DAILY_LIMIT_KEY, date: today(), count: 1 });
      TestBed.resetTestingModule();
      const pro = configure(true);
      await pro.refresh();

      expect(pro.isUnlimited()).toBe(true);
      expect(pro.hasGamesLeft()).toBe(true);
      expect(pro.remaining()).toBe(Number.POSITIVE_INFINITY);
      expect(await pro.consumeGame()).toBe(true);

      // Not merely allowed — nothing was written. A subscription that lapses
      // must not hand the player a day already spent.
      expect((await readRaw()) as { count: number }).toMatchObject({ count: 1 });
    });

    /**
     * `CLAUDE.md` §4.2 — a client entitlement signal must mirror **all** of the
     * server predicate, never a looser one. `SubscriptionService.isProUser`
     * already refuses an active subscription whose price carries no
     * `firebaseRole`; this pins that the limit asks that same question rather
     * than inventing its own notion of "subscribed".
     */
    it('defers entirely to isProUser, so it cannot be broader than the claim', () => {
      expect(service.isUnlimited()).toBe(false);
      expect(service.remaining()).toBe(DAILY_FREE_GAME_LIMIT);
    });
  });
});
