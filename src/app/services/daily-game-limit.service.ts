import { Injectable, computed, inject, signal } from '@angular/core';
import { SubscriptionService } from './subscription.service';
import { DAILY_LIMIT_KEY, DAILY_LIMIT_STORE, OfflineDbService } from './offline-db.service';

/**
 * How many games a free player gets per day.
 *
 * One definition, client-side only. There is no server half to keep in step —
 * see `FEAT-014` §0 — so this is not one of the constants that has to be
 * mirrored into `functions/`.
 */
export const DAILY_FREE_GAME_LIMIT = 5;

interface StoredAllowance {
  id: string;
  /** The local date this count belongs to, `YYYY-MM-DD`. */
  date: string;
  count: number;
}

/**
 * The local date, as the counter keys on it.
 *
 * Derived from the device's own clock and timezone, deliberately. A player who
 * moves the clock forward gets more free trivia, which is the entire prize —
 * `FEAT-014` §0 records that this is a conversion nudge and not a boundary, and
 * that framing is what removes the stored timezone, the server-side midnight
 * arithmetic and the anti-tamper apparatus the first version of the spec
 * carried.
 *
 * Built from the date parts rather than `toISOString().slice(0, 10)`, which
 * would render the *UTC* date and roll over at the wrong moment for everyone
 * not on UTC — an off-by-one-day that is invisible in CI and in London.
 */
export function localDateKey(now: Date): string {
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function readCount(stored: unknown, today: string): number {
  if (typeof stored !== 'object' || stored === null) {
    return 0;
  }
  const record = stored as Partial<StoredAllowance>;
  // A record for any day but today is not migrated, reset or deleted — it is
  // simply not today's, so today's count is zero. One less write, and no
  // "reset" path that could run at the wrong moment.
  if (record.date !== today) {
    return 0;
  }
  return typeof record.count === 'number' && Number.isFinite(record.count) && record.count > 0
    ? Math.floor(record.count)
    : 0;
}

/**
 * The free tier's daily game allowance, counted on this device.
 *
 * **Why the device and not the server** is `FEAT-014` §0, and the short version
 * is that the anonymous uid lives in browser storage too — so a server counter
 * keyed on it is cleared by the same gesture that clears this one, at the cost
 * of a Cloud Function on the critical path of every game. `FEAT-047` carries
 * the server-side version for when a real chokepoint exists.
 *
 * **Every storage access is non-fatal.** IndexedDB can be unavailable outright
 * (Safari private mode, storage disabled, a quota refusal), and a limit that
 * failed closed would make the app unplayable in a private window — turning a
 * conversion nudge into a bounce. Unreadable storage reads as a full
 * allowance, which is the same direction `GamePersistenceService` fails in.
 */
@Injectable({ providedIn: 'root' })
export class DailyGameLimitService {
  private readonly db = inject(OfflineDbService);
  private readonly subscription = inject(SubscriptionService);

  private readonly played = signal(0);

  /**
   * Pro is unlimited, and this is the one gate in the app where a client-only
   * entitlement check is correct rather than a violation of `CLAUDE.md` §4.2.
   * That rule forbids gating a *privileged operation* on a client signal, and
   * requires a client signal never be broader than the server's. Playing a game
   * is not privileged and there is no server gate to be broader than — the
   * whole feature is advisory. Reading `isProUser` is therefore the entire
   * check, and it is the strict predicate the service already mirrors.
   */
  readonly isUnlimited = computed(() => this.subscription.isProUser());

  readonly remaining = computed(() =>
    this.isUnlimited()
      ? Number.POSITIVE_INFINITY
      : Math.max(0, DAILY_FREE_GAME_LIMIT - this.played()),
  );

  readonly hasGamesLeft = computed(() => this.remaining() > 0);

  /** Loads today's count into the signal. Safe to call more than once. */
  async refresh(): Promise<void> {
    this.played.set(await this.read());
  }

  /**
   * Spends one game, returning whether there was one to spend.
   *
   * The signal moves first and the write follows, so the UI never waits on
   * IndexedDB to show a number the player has already earned by starting a
   * game. A failed write costs the count, not the game.
   */
  async consumeGame(): Promise<boolean> {
    if (this.isUnlimited()) {
      return true;
    }

    const today = localDateKey(new Date());
    const played = await this.read();
    if (played >= DAILY_FREE_GAME_LIMIT) {
      this.played.set(played);
      return false;
    }

    const next = played + 1;
    this.played.set(next);
    await this.write({ id: DAILY_LIMIT_KEY, date: today, count: next });
    return true;
  }

  private async read(): Promise<number> {
    const today = localDateKey(new Date());
    try {
      const db = await this.db.open();
      const stored = await new Promise<unknown>((resolve, reject) => {
        const request = db
          .transaction(DAILY_LIMIT_STORE, 'readonly')
          .objectStore(DAILY_LIMIT_STORE)
          .get(DAILY_LIMIT_KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error as Error);
      });
      return readCount(stored, today);
    } catch {
      return 0;
    }
  }

  private async write(record: StoredAllowance): Promise<void> {
    try {
      const db = await this.db.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DAILY_LIMIT_STORE, 'readwrite');
        tx.objectStore(DAILY_LIMIT_STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error as Error);
      });
    } catch {
      // See the class comment: storage failing must not cost the player a game.
    }
  }
}
