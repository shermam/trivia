import { DocumentReference, getFirestore } from 'firebase-admin/firestore';

/**
 * Making webhook-driven Firestore writes safe against Stripe's delivery model.
 *
 * Stripe guarantees *at least once* delivery and nothing about order. Two
 * consequences the original handler didn't account for:
 *
 * - **A duplicate is harmless; a reordering is not.** Every write here is a
 *   `set(..., {merge:true})` or a `delete()`, so replaying an event changes
 *   nothing. But `customer.subscription.updated` (cancelled) arriving *after*
 *   `customer.subscription.updated` (active) writes the older truth over the
 *   newer one, and the `stripeRole` claim is then recomputed from it.
 * - **Retries make it likely, not theoretical.** A handler that 500s — or a
 *   cold start that times out — is retried while newer events keep flowing, so
 *   the out-of-order window is exactly the window where things are already
 *   going wrong.
 *
 * The fix is a high-water mark per synced document: each one records the
 * `created` timestamp of the event that last wrote it, and an event older than
 * that mark is dropped. Per-document rather than a global processed-event log,
 * because ordering only matters between events touching the same object, and a
 * global log would need its own collection, its own TTL, and a read on every
 * delivery to answer a question no document actually asked.
 */

/** Epoch **seconds**, matching Stripe's `event.created`, not JavaScript millis. */
export const EVENT_CREATED_FIELD = 'eventCreated';

/**
 * Whether this event predates what the document already holds.
 *
 * Equal timestamps are *not* stale: two events can share a second, and a
 * redelivery of the event that wrote the document has exactly its mark. Both
 * should proceed — they write the same or equivalent data, and treating a tie
 * as stale would drop the second of two genuine same-second updates.
 *
 * A document with no mark (written before this existed, or seeded by a test)
 * is never stale, so the first event after a deploy always lands.
 */
export function isStaleEvent(storedCreated: unknown, incomingCreated: number): boolean {
  return typeof storedCreated === 'number' && storedCreated > incomingCreated;
}

/**
 * `set(..., {merge:true})` unless the document was last written by a newer
 * event. Returns whether the write happened, for logging.
 *
 * A transaction rather than a read-then-write: two deliveries for the same
 * object can be in flight at once (that is the whole problem), and a plain read
 * followed by a write would let both pass the check and race.
 */
export async function setIfNotStale(
  ref: DocumentReference,
  data: Record<string, unknown>,
  eventCreated: number,
): Promise<boolean> {
  return getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (isStaleEvent(snapshot.data()?.[EVENT_CREATED_FIELD], eventCreated)) {
      return false;
    }
    transaction.set(ref, { ...data, [EVENT_CREATED_FIELD]: eventCreated }, { merge: true });
    return true;
  });
}

/**
 * `delete()` unless the document was last written by a newer event.
 *
 * Deleting loses the high-water mark along with the document, so a late
 * `deleted` event that arrives after the object was recreated cannot be
 * detected as stale afterwards — this check is what prevents it, and it is why
 * deletes go through here rather than straight to `ref.delete()`. An already
 * absent document reports `false`: nothing was deleted, and there is nothing to
 * compare against.
 */
export async function deleteIfNotStale(
  ref: DocumentReference,
  eventCreated: number,
): Promise<boolean> {
  return getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      return false;
    }
    if (isStaleEvent(snapshot.data()?.[EVENT_CREATED_FIELD], eventCreated)) {
      return false;
    }
    transaction.delete(ref);
    return true;
  });
}
