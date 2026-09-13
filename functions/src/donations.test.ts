import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DocumentReference, Timestamp, Transaction } from 'firebase-admin/firestore';
import { applySupporterSince, shouldMoveSupporterSince } from './donations';

/**
 * `supporterSince` is the date of an account's **first** donation, and "first"
 * is not a property of arrival order: Stripe retries, and a retry can deliver
 * an older session after a newer one has already landed (`CLAUDE.md` §4.3).
 * The comparison below is the whole of the claim that the field is
 * order-independent, so it is tested directly rather than inferred from the
 * handler — and the write around it too, since `merge: true` is what keeps
 * `stripeId` on the same document.
 */

const JANUARY = Date.UTC(2026, 0, 1);
const MARCH = Date.UTC(2026, 2, 1);

/** The slice of a Firestore transaction this write uses, and nothing else. */
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

const customerRef = 'customers/user-1' as unknown as DocumentReference;

const storedMillis = (write: { data: Record<string, unknown> }) =>
  (write.data['supporterSince'] as Timestamp).toMillis();

describe('shouldMoveSupporterSince', () => {
  it('writes when the account has no date yet', () => {
    assert.equal(shouldMoveSupporterSince(null, MARCH), true);
  });

  it('writes when this donation predates the one stored', () => {
    assert.equal(shouldMoveSupporterSince(MARCH, JANUARY), true);
  });

  // The reordering this exists for, the other way round: a second donation
  // must not move the date of the first one forward.
  it('leaves the stored date alone for a later donation', () => {
    assert.equal(shouldMoveSupporterSince(JANUARY, MARCH), false);
  });

  // A redelivery carries exactly the value already stored, so rewriting it
  // would be a write that changes nothing.
  it('does not rewrite the same date', () => {
    assert.equal(shouldMoveSupporterSince(JANUARY, JANUARY), false);
  });
});

describe('applySupporterSince', () => {
  it('stamps the date, merging so the rest of the customer document survives', async () => {
    const { transaction, writes } = fakeTransaction({ stripeId: 'cus_123' });

    await applySupporterSince(transaction, customerRef, new Date(MARCH));

    assert.equal(writes.length, 1);
    // Without this the write would take `stripeId` with it, and nothing would
    // notice until the next checkout looked for a customer and found none.
    assert.deepEqual(writes[0].options, { merge: true });
    assert.equal(storedMillis(writes[0]), MARCH);
  });

  it('writes nothing when the stored date is already the earlier one', async () => {
    const { transaction, writes } = fakeTransaction({
      supporterSince: Timestamp.fromMillis(JANUARY),
    });

    await applySupporterSince(transaction, customerRef, new Date(MARCH));

    assert.deepEqual(writes, []);
  });

  it('moves the date earlier when a retry delivers an older donation', async () => {
    const { transaction, writes } = fakeTransaction({
      supporterSince: Timestamp.fromMillis(MARCH),
    });

    await applySupporterSince(transaction, customerRef, new Date(JANUARY));

    assert.equal(storedMillis(writes[0]), JANUARY);
  });

  // A seeded or hand-edited document must not be able to freeze the field
  // against every future donation by holding something unreadable.
  it('overwrites a stored value that is not a timestamp', async () => {
    const { transaction, writes } = fakeTransaction({ supporterSince: '2026-01-01' });

    await applySupporterSince(transaction, customerRef, new Date(MARCH));

    assert.equal(storedMillis(writes[0]), MARCH);
  });
});
