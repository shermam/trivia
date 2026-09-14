import { DocumentReference, getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  PLAY_SWEEP_BATCH_SIZE,
  PlaySweepStore,
  playRetentionCutoff,
  sweepExpiredPlays,
} from './play-retention';

/**
 * Deletes play history older than twelve months, once a day.
 *
 * The retention period, the boundary and the batching are
 * `play-retention.ts`'s; this file is the wiring — a Cloud Scheduler job, a
 * collection-group query and a `WriteBatch`.
 *
 * **A `collectionGroup` query, which needs a declared index.** `plays` is a
 * subcollection, so `firestore.collectionGroup('plays')` is the only way to
 * reach every player's in one query rather than one query per account.
 * Firestore creates single-field indexes automatically at *collection* scope
 * and not at collection-group scope, so `firestore.indexes.json` declares
 * `plays.at` explicitly (`data-model.md` §3). Without it this query fails with
 * `FAILED_PRECONDITION` and the sweep never deletes anything — which is why the
 * failure is logged as an error rather than swallowed.
 *
 * **Every 24 hours rather than at a fixed hour**, because nothing here is
 * time-of-day sensitive: a document a few hours past twelve months is not a
 * problem the schedule can be tuned against, and an interval schedule is one
 * fewer timezone to be wrong about.
 */
export const sweepPlayHistory = onSchedule(
  {
    schedule: 'every 24 hours',
    // The default is 60 seconds, and a first run facing a year's accumulation
    // has up to 20 batched deletes to get through. Nine minutes is generous
    // rather than necessary — the run stops itself at `PLAY_SWEEP_MAX_PASSES`
    // and leaves the remainder to tomorrow.
    timeoutSeconds: 540,
    // One job, one instance. Two overlapping runs would both read the same
    // page and both delete it, and the second's batch would be a no-op —
    // harmless, but paid for.
    maxInstances: 1,
  },
  async () => {
    const firestore = getFirestore();

    const store: PlaySweepStore<DocumentReference> = {
      async findExpired(cutoff, limit) {
        const snapshot = await firestore
          .collectionGroup('plays')
          .where('at', '<', cutoff)
          .limit(limit)
          .get();
        return snapshot.docs.map((doc) => doc.ref);
      },
      async deleteAll(refs) {
        const batch = firestore.batch();
        for (const ref of refs) {
          batch.delete(ref);
        }
        await batch.commit();
      },
    };

    try {
      const deleted = await sweepExpiredPlays(store, Date.now());
      logger.info(
        `sweepPlayHistory deleted ${deleted} play document(s) banked before ` +
          `${new Date(playRetentionCutoff(Date.now())).toISOString()} ` +
          `(batch size ${PLAY_SWEEP_BATCH_SIZE}).`,
      );
    } catch (error) {
      // Logged and rethrown. A sweep that fails silently is a retention promise
      // that quietly stops being kept, and the published policy names a number.
      logger.error('sweepPlayHistory failed', error);
      throw error;
    }
  },
);
