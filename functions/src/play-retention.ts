/**
 * How long a `users/{uid}/plays/{gameId}` document lives, and the sweep that
 * enforces it (`FEAT-049`).
 *
 * Twelve months of raw per-answer records; the **aggregates outlive them** —
 * the lifetime totals already on `users/{uid}`, and whatever the recommender
 * derives and stores there later. A player who has been away for two years
 * still gets sensible recommendations; the app just no longer holds the
 * individual rounds behind them. Twelve months is long enough that a seasonal
 * player's profile survives a year's gap and short enough to be a defensible
 * answer to "why do you still have this", which is why it goes in the Privacy
 * Policy as a number rather than as "as long as necessary".
 *
 * **A scheduled sweep rather than a Firestore TTL policy**, which is what the
 * Stripe session collections use (`session-expiry.ts`). A TTL policy deletes on
 * a per-document `expiresAt` written at create time, so the retention period is
 * frozen into every document the moment it is written: shortening it to six
 * months would apply to new games only, and the documents this policy claim is
 * actually about would keep their old deadline with nothing able to change it.
 * A sweep over `at` applies whatever the current policy says to every document
 * that exists, which is the property a published retention promise needs.
 *
 * Pure and free of `firebase-admin` on purpose — the store is injected, so the
 * boundary and the batching are unit-testable without an emulator. The
 * Firestore-backed store lives in `play-history-sweep.ts`.
 */

/** Twelve months, as the Privacy Policy's retention section states it. */
export const PLAY_HISTORY_RETENTION_DAYS = 365;

export const PLAY_HISTORY_RETENTION_MS = PLAY_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * How many documents one pass deletes.
 *
 * 500 is Firestore's hard limit on writes in a single `WriteBatch`, so this is
 * the largest a pass can be rather than a tuning choice.
 */
export const PLAY_SWEEP_BATCH_SIZE = 500;

/**
 * A ceiling on passes per run, so one invocation cannot run until the platform
 * kills it.
 *
 * 20 passes is 10,000 documents — far more than a day's worth of expiries could
 * ever be once the sweep has caught up, and enough that even the very first run
 * over a year's accumulation clears it in a handful of days. Anything left over
 * is picked up by tomorrow's run, which is why stopping early is safe: nothing
 * is lost, the deletion is merely later.
 */
export const PLAY_SWEEP_MAX_PASSES = 20;

/** The instant at which a play becomes old enough to delete. */
export function playRetentionCutoff(nowMs: number): number {
  return nowMs - PLAY_HISTORY_RETENTION_MS;
}

/**
 * Whether a play banked at `at` has outlived the retention period.
 *
 * Strictly older, so a document exactly twelve months old survives one more
 * run. The direction matters less than its being stated: the sweep's query uses
 * `<` against {@link playRetentionCutoff}, and a predicate that disagreed with
 * the query would describe a boundary the code does not have.
 */
export function isExpiredPlay(at: number, nowMs: number): boolean {
  return at < playRetentionCutoff(nowMs);
}

/**
 * Where the sweep finds expired plays and how it deletes them.
 *
 * Generic in the handle type so this module needs nothing from
 * `firebase-admin`: the real store hands back `DocumentReference`s, the tests
 * hand back strings, and neither is this module's business.
 */
export interface PlaySweepStore<Handle> {
  /** At most `limit` plays banked before `cutoff`. */
  findExpired(cutoff: number, limit: number): Promise<Handle[]>;
  /** Deletes a page of them, in one batch. */
  deleteAll(handles: Handle[]): Promise<void>;
}

/**
 * Deletes every expired play the store can reach, a batch at a time, and
 * reports how many went.
 *
 * Paged rather than fetched whole, because the number of expired documents on
 * any given day is not bounded by anything this code controls — the first run
 * after launch faces a year's accumulation at once. A short page ends the run:
 * the query asks for `limit` and got fewer, so there is nothing left to find.
 */
export async function sweepExpiredPlays<Handle>(
  store: PlaySweepStore<Handle>,
  nowMs: number,
): Promise<number> {
  const cutoff = playRetentionCutoff(nowMs);
  let deleted = 0;

  for (let pass = 0; pass < PLAY_SWEEP_MAX_PASSES; pass += 1) {
    const expired = await store.findExpired(cutoff, PLAY_SWEEP_BATCH_SIZE);
    if (expired.length === 0) {
      break;
    }
    await store.deleteAll(expired);
    deleted += expired.length;
    if (expired.length < PLAY_SWEEP_BATCH_SIZE) {
      break;
    }
  }

  return deleted;
}
