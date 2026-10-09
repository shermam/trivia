import { DocumentReference, Firestore, getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  PLAY_SWEEP_BATCH_SIZE,
  PlaySweepStore,
  playRetentionCutoff,
  sweepExpiredPlays,
} from './play-retention';
import { anonymiseDecidedReports } from './report-anonymisation';
import { runSweepPasses } from './sweep-passes';

/**
 * The project's one scheduled job, once a day, running two independent passes:
 * play history older than twelve months is deleted (`FEAT-049`), and every
 * report whose question has been decided is copied without its reporter
 * (`FEAT-042`).
 *
 * **One job carrying both, rather than a job each, is a billing decision.**
 * Firebase deploys a scheduled function as a Cloud Scheduler job, Scheduler's
 * free tier is three jobs per *billing account*, and this function is deployed
 * to two projects — so a second scheduled function would be the fourth job on
 * a billing account the two share. Neither pass is time-of-day sensitive, so
 * nothing is lost by running them together, and `runSweepPasses` keeps them
 * apart where it matters: each runs whatever the other did, and the run fails
 * if either did.
 *
 * **The name is the play-history pass's, and it stays.** A function's name is
 * its identity in the project: renaming it means deploying a new one and
 * deleting the old, and a non-interactive deploy refuses the deletion by
 * aborting the whole functions deploy — on both projects, until somebody
 * deletes the old function by hand.
 *
 * The decisions, the boundaries and the batching are `play-retention.ts`'s and
 * `report-anonymisation.ts`'s, each unit-tested; this file is the wiring.
 *
 * **Every 24 hours rather than at a fixed hour**, because nothing here is
 * time-of-day sensitive: a document a few hours past its deadline is not a
 * problem the schedule can be tuned against, and an interval schedule is one
 * fewer timezone to be wrong about.
 */
export const sweepPlayHistory = onSchedule(
  {
    schedule: 'every 24 hours',
    // The default is 60 seconds, and a first run facing a year's accumulation
    // has up to 20 batched deletes to get through, and the report pass up to
    // 20 pages more. Nine minutes is generous rather than necessary — each
    // pass stops itself at its own ceiling and leaves the remainder to
    // tomorrow.
    timeoutSeconds: 540,
    // One job, one instance. Two overlapping runs would both read the same
    // page and both act on it; for the plays the second delete is a no-op,
    // for a report the second anonymisation is refused by its precondition —
    // harmless either way, but paid for.
    maxInstances: 1,
  },
  async () => {
    const firestore = getFirestore();
    await runSweepPasses(
      [
        {
          name: 'play-history retention',
          run: async () => {
            const now = Date.now();
            const deleted = await sweepExpiredPlays(playSweepStore(firestore), now);
            return (
              `sweepPlayHistory deleted ${deleted} play document(s) banked before ` +
              `${new Date(playRetentionCutoff(now)).toISOString()} ` +
              `(batch size ${PLAY_SWEEP_BATCH_SIZE}).`
            );
          },
        },
        {
          name: 'report anonymisation',
          run: async () => {
            const { examined, anonymised, kept } = await anonymiseDecidedReports(firestore);
            return (
              `sweepPlayHistory read ${examined} report(s) still naming their reporter: ` +
              `${anonymised} anonymised, ${kept} kept for a question still under review.`
            );
          },
        },
      ],
      logger,
    );
  },
);

/**
 * The play-history pass's store: a collection-group query and a `WriteBatch`.
 *
 * **A `collectionGroup` query, which needs a declared index.** `plays` is a
 * subcollection, so `firestore.collectionGroup('plays')` is the only way to
 * reach every player's in one query rather than one query per account.
 * Firestore creates single-field indexes automatically at *collection* scope
 * and not at collection-group scope, so `firestore.indexes.json` declares
 * `plays.at` explicitly (`data-model.md` §3). Without it this query fails with
 * `FAILED_PRECONDITION` and the pass never deletes anything — which is why a
 * failure is logged as an error rather than swallowed.
 */
function playSweepStore(firestore: Firestore): PlaySweepStore<DocumentReference> {
  return {
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
}
