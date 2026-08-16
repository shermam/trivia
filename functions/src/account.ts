import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type Stripe from 'stripe';
import { getStripeClient, isMockMode, stripeSecretKey } from './stripe-client';
import { ANONYMISED_AUTHOR, isCancellableStatus } from './account-policy';
import { buildAccountExport } from './account-export';
import { LEADERBOARD_BOARDS, leaderboardPathsFor } from './leaderboards';

/**
 * Deletes the caller's account and everything attached to it.
 *
 * Callable rather than a Firestore trigger because it has to span four
 * systems that no single client write can reach — Stripe, Auth, the
 * leaderboard, and the question bank — and because the Admin SDK bypasses
 * `firestore.rules`, which is the only way to touch documents the client is
 * deliberately forbidden from writing (no leaderboard has a delete rule at
 * all, and `custom_questions` is create-only).
 *
 * Order matters. Stripe is cancelled first, because it is the only step with
 * a cost attached to getting it wrong: if a later step fails after Auth is
 * already gone, the user can retry, but a subscription left billing an
 * account that no longer exists is a charge nobody can explain. Auth is
 * deleted last for the same reason — while it exists the caller can retry;
 * once it's gone this function can never run for them again.
 */
export const deleteAccount = onCall({ secrets: [stripeSecretKey] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    // Not reachable through the app, but this is the whole authorisation
    // boundary: the caller can only ever delete themselves, because the uid
    // comes from the verified token and is never read from the payload.
    throw new HttpsError('unauthenticated', 'Sign in before deleting your account.');
  }

  logger.info(`deleteAccount invoked for uid=${uid}`);
  const firestore = getFirestore();

  try {
    await cancelBillingFor(uid);
    await anonymiseContributedQuestions(uid);
    // Every board, not just one. Since G7 a player can hold an entry on each
    // timing constraint, and the legacy flat collection may still hold a
    // pre-migration row — a deletion that missed any of them would leave the
    // user's name and score publicly readable after they asked to be removed.
    await Promise.all(leaderboardPathsFor(uid).map((path) => firestore.doc(path).delete()));
    await deleteCustomerRecord(uid);
    await getAuth().deleteUser(uid);
  } catch (error) {
    logger.error(`Failed to delete account ${uid}`, error);
    throw new HttpsError('internal', 'Could not delete your account. Please try again.');
  }

  logger.info(`deleteAccount completed for uid=${uid}`);
  return { deleted: true };
});

/**
 * Returns everything this application holds about the caller.
 *
 * Same authorisation boundary as `deleteAccount`: the uid comes from the
 * verified token, never the payload, so a caller can only ever export
 * themselves. Read-only, so unlike deletion there is no ordering to get right.
 *
 * Returned inline rather than written to Storage and linked. The payload is a
 * handful of documents — one leaderboard entry, some questions, a few billing
 * records — comfortably inside the callable response limit, and an inline
 * response avoids minting a signed URL that would itself become a way to reach
 * someone's personal data.
 */
export const exportAccountData = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign in before exporting your data.');
  }

  logger.info(`exportAccountData invoked for uid=${uid}`);
  const firestore = getFirestore();
  const customerRef = firestore.collection('customers').doc(uid);

  try {
    const [user, leaderboard, questions, customer, subscriptions, checkouts, portals] =
      await Promise.all([
        getAuth().getUser(uid),
        // One read per board. A player can hold an entry on each timing
        // constraint since G7, and an export that returned only one of them
        // would be an incomplete answer to a data-access request.
        Promise.all(
          LEADERBOARD_BOARDS.map((board) =>
            firestore.doc(`leaderboards/${board}/entries/${uid}`).get(),
          ),
        ),
        firestore.collection('custom_questions').where('createdBy', '==', uid).get(),
        customerRef.get(),
        customerRef.collection('subscriptions').get(),
        customerRef.collection('checkout_sessions').get(),
        customerRef.collection('portal_sessions').get(),
      ]);

    return buildAccountExport({
      user,
      // Pair each snapshot with its board *before* filtering. Filtering first
      // and then reading `index` inside `map` renumbers the survivors, so a
      // player with an entry on only the second board would have it labelled
      // as the first — and having entries on some boards but not all is the
      // normal case, not an edge one.
      leaderboardEntries: LEADERBOARD_BOARDS.map((board, index) => ({
        board,
        snapshot: leaderboard[index],
      }))
        .filter(({ snapshot }) => snapshot.exists)
        .map(({ board, snapshot }) => ({ board, ...snapshot.data() })),
      contributedQuestions: questions.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      stripeCustomerId: (customer.data()?.['stripeId'] as string | undefined) ?? null,
      subscriptions: subscriptions.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      checkoutSessions: checkouts.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      portalSessions: portals.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    });
  } catch (error) {
    logger.error(`Failed to export account data for ${uid}`, error);
    throw new HttpsError('internal', 'Could not export your data. Please try again.');
  }
});

/**
 * Cancels any live subscription immediately and removes the Stripe customer.
 *
 * "Immediately" is a product decision, not a technical one: the alternative —
 * cancelling at period end — leaves a live subscription and a Stripe customer
 * pointing at a Firebase account that no longer exists, which is impossible to
 * square with a privacy policy that promises deletion.
 */
async function cancelBillingFor(uid: string): Promise<void> {
  const customerRef = getFirestore().collection('customers').doc(uid);
  const stripeId = (await customerRef.get()).data()?.['stripeId'] as string | undefined;
  if (!stripeId || isMockMode()) {
    return;
  }

  const stripe = getStripeClient();
  const subscriptions = await stripe.subscriptions.list({ customer: stripeId, status: 'all' });
  for (const subscription of subscriptions.data) {
    if (isCancellableStatus(subscription.status as Stripe.Subscription.Status)) {
      await stripe.subscriptions.cancel(subscription.id);
    }
  }
  // Removing the customer also detaches stored payment methods, so no card
  // details remain associated with a deleted account.
  await stripe.customers.del(stripeId);
}

/**
 * Strips the author link from the user's contributed questions rather than
 * deleting them.
 *
 * The questions stay because they are part of a shared bank other players are
 * actively drawing from, and one prolific contributor leaving should not empty
 * a category mid-game. What goes is the link to a person who asked to be
 * erased.
 *
 * The cost is real and worth naming: these rows become unattributable, which
 * is precisely the state finding A10 existed to fix. An abuse report about one
 * of them can no longer be traced. That is the accepted trade — erasure wins
 * over moderation for someone who has left.
 */
async function anonymiseContributedQuestions(uid: string): Promise<void> {
  const firestore = getFirestore();
  const authored = await firestore
    .collection('custom_questions')
    .where('createdBy', '==', uid)
    .get();

  // Batched: a prolific contributor can exceed the 500-write limit of a single
  // batch, and a partial anonymisation would leave some questions still
  // pointing at a deleted user.
  const BATCH_LIMIT = 500;
  for (let i = 0; i < authored.docs.length; i += BATCH_LIMIT) {
    const batch = firestore.batch();
    for (const doc of authored.docs.slice(i, i + BATCH_LIMIT)) {
      batch.update(doc.ref, { createdBy: ANONYMISED_AUTHOR });
    }
    await batch.commit();
  }
}

/** Removes `customers/{uid}` and every subcollection under it. */
async function deleteCustomerRecord(uid: string): Promise<void> {
  const firestore = getFirestore();
  const customerRef = firestore.collection('customers').doc(uid);

  for (const name of ['checkout_sessions', 'portal_sessions', 'subscriptions']) {
    const snapshot = await customerRef.collection(name).get();
    // A document's subcollections are not deleted with it — deleting the
    // parent alone would orphan these, leaving them readable by nobody and
    // deleted by nothing.
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }
  await customerRef.delete();
}
