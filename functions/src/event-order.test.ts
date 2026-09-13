import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { EVENT_CREATED_FIELD, applySetIfNotStale, isStaleEvent } from './event-order';

/**
 * `event.created` is epoch **seconds**, so these fixtures are seconds too —
 * mixing in a millisecond value would make every comparison pass for the wrong
 * reason.
 */
const EARLIER = 1_770_000_000;
const LATER = 1_770_000_060;

/** The slice of a Firestore transaction these writes use, and nothing else. */
function fakeTransaction(stored?: Record<string, unknown>) {
  const writes: { data: Record<string, unknown>; options: unknown }[] = [];
  return {
    writes,
    transaction: {
      get: () => Promise.resolve({ data: () => stored }),
      set: (_ref: unknown, data: Record<string, unknown>, options: unknown) => {
        writes.push({ data, options });
      },
    } as unknown as Transaction,
  };
}

const ref = 'customers/user-1/subscriptions/sub_1' as unknown as DocumentReference;

describe('isStaleEvent', () => {
  // The finding: `cancelled` arriving after `active` used to overwrite it, and
  // the stripeRole claim was then recomputed from the older truth.
  it('drops an event older than what the document already holds', () => {
    assert.equal(isStaleEvent(LATER, EARLIER), true);
  });

  it('accepts an event newer than the document', () => {
    assert.equal(isStaleEvent(EARLIER, LATER), false);
  });

  // Not stale: a redelivery of the event that wrote the document carries
  // exactly its mark, and two genuine updates can share a second. Both write
  // the same or equivalent data, so letting them through is correct and
  // treating a tie as stale would drop the second of two real updates.
  it('accepts an event with the same timestamp', () => {
    assert.equal(isStaleEvent(LATER, LATER), false);
  });

  // Otherwise the first event after this shipped would be dropped on every
  // document that predates the field.
  it('accepts any event against a document with no high-water mark', () => {
    assert.equal(isStaleEvent(undefined, EARLIER), false);
    assert.equal(isStaleEvent(null, EARLIER), false);
  });

  // A hand-edited or seeded document must not be able to freeze itself against
  // all future events by carrying a non-numeric mark.
  it('accepts any event against a non-numeric mark', () => {
    assert.equal(isStaleEvent('9999999999', EARLIER), false);
    assert.equal(isStaleEvent({ seconds: LATER }, EARLIER), false);
  });

  it('names the field in seconds, matching Stripe', () => {
    assert.equal(EVENT_CREATED_FIELD, 'eventCreated');
  });
});

/**
 * The decision above is `isStaleEvent`'s; what only these can reach is what
 * the write does once the answer is "not stale".
 */
describe('applySetIfNotStale', () => {
  it('writes the data and the mark, merging into what the document already holds', async () => {
    const { transaction, writes } = fakeTransaction({ stripeId: 'cus_123' });

    assert.equal(await applySetIfNotStale(transaction, ref, { status: 'active' }, LATER), true);

    // Merged, because every caller here owns one facet of a document that
    // other handlers also write.
    assert.deepEqual(writes[0].options, { merge: true });
    // The mark goes in with the data rather than in a second write: a document
    // that landed without one cannot refuse the next stale event.
    assert.deepEqual(writes[0].data, { status: 'active', [EVENT_CREATED_FIELD]: LATER });
  });

  it('writes nothing when a newer event already wrote the document', async () => {
    const { transaction, writes } = fakeTransaction({ [EVENT_CREATED_FIELD]: LATER });

    assert.equal(
      await applySetIfNotStale(transaction, ref, { status: 'canceled' }, EARLIER),
      false,
    );
    assert.deepEqual(writes, []);
  });
});
