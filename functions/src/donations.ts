import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { CompletedCheckoutSession, donationRecordFrom } from './donation-record';
import { setIfNotStale } from './event-order';

/**
 * Records a completed one-time payment as a donation under
 * `customers/{uid}/donations/{checkoutSessionId}`, and marks the account as a
 * supporter.
 *
 * Whether there is anything to record at all is `donationRecordFrom`'s
 * decision — mode, payment status, attribution and amount — kept pure and
 * tested on its own. What is left here is the writing, and both writes are
 * built to survive Stripe's delivery model (`CLAUDE.md` §4.3):
 *
 * - **The donation document goes through `setIfNotStale`**, so a redelivery is
 *   a no-op and a reordered pair cannot overwrite the newer with the older.
 *   The document id is the Checkout Session's own id, which makes the write
 *   idempotent by construction as well: the same session recorded twice is the
 *   same document written twice.
 * - **`supporterSince` only ever moves earlier.** It is the date of the first
 *   donation, and "first" is not a property of arrival order — a retry can
 *   deliver an older session after a newer one has already landed. So the
 *   transaction writes when the field is absent *or* when this donation
 *   predates what is stored, which makes the result the same whatever order
 *   the events arrive in.
 */
export async function recordDonation(
  session: CompletedCheckoutSession,
  eventCreated: number,
): Promise<void> {
  const donation = donationRecordFrom(session);
  if (!donation) {
    // Not an error, and deliberately not logged as one: every Pro checkout
    // completing arrives here too, and so does every guest donation, which by
    // design leaves no record.
    return;
  }

  const createdAt = new Date((donation.createdAtSeconds ?? eventCreated) * 1000);
  const customerRef = getFirestore().collection('customers').doc(donation.uid);

  const written = await setIfNotStale(
    customerRef.collection('donations').doc(donation.sessionId),
    {
      amount: donation.amount,
      currency: donation.currency,
      createdAt: Timestamp.fromDate(createdAt),
    },
    eventCreated,
  );
  if (!written) {
    logger.info(
      `Ignored out-of-order Stripe event for donation ${donation.sessionId}: a newer one already wrote it.`,
    );
  }

  await markSupporterSince(donation.uid, createdAt);
}

/**
 * Stamps `customers/{uid}.supporterSince` with the earliest donation this
 * account has made.
 *
 * A transaction rather than a read-then-write for the same reason
 * `setIfNotStale` uses one: two deliveries for the same customer can be in
 * flight at once, and a plain read followed by a write would let both pass the
 * comparison and race.
 *
 * `merge: true`, because this document is also where `stripeId` lives and a
 * plain `set` would take it with it.
 */
async function markSupporterSince(uid: string, donatedAt: Date): Promise<void> {
  const customerRef = getFirestore().collection('customers').doc(uid);
  await getFirestore().runTransaction(async (transaction) => {
    const existing = (await transaction.get(customerRef)).data()?.['supporterSince'];
    const existingMillis =
      existing instanceof Timestamp ? existing.toMillis() : Number.POSITIVE_INFINITY;
    if (donatedAt.getTime() >= existingMillis) {
      return;
    }
    transaction.set(
      customerRef,
      { supporterSince: Timestamp.fromDate(donatedAt) },
      { merge: true },
    );
  });
}
