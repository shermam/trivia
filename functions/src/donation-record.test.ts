import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompletedCheckoutSession, donationRecordFrom } from './donation-record';

/**
 * The billing decision behind `customers/{uid}/donations` — whether a
 * completed Checkout Session is a donation this app records, and what it
 * records (`CLAUDE.md` §4.6: a Cloud Function that makes a billing decision
 * has a direct unit test for that decision).
 *
 * Every rejection here has a real delivery behind it. Stripe sends
 * `checkout.session.completed` for a Pro subscription starting; it sends it
 * for a boleto that has not been paid; and it sends it for the guest donations
 * this app deliberately accepts and deliberately does not attribute.
 */
const paidDonation: CompletedCheckoutSession = {
  id: 'cs_test_123',
  mode: 'payment',
  payment_status: 'paid',
  amount_total: 500,
  currency: 'BRL',
  created: 1_757_600_000,
  metadata: { firebaseUID: 'user-1' },
};

describe('donationRecordFrom', () => {
  it('records a paid one-time payment carrying an account', () => {
    assert.deepEqual(donationRecordFrom(paidDonation), {
      uid: 'user-1',
      sessionId: 'cs_test_123',
      amount: 500,
      // Lowercased on the way in, so the record matches the catalog's own
      // spelling and the client never has to case-fold to compare.
      currency: 'brl',
      createdAtSeconds: 1_757_600_000,
    });
  });

  // A Pro checkout completing arrives on exactly the same event type. Recording
  // it would file a subscription's first invoice as a donation.
  it('ignores a subscription-mode session', () => {
    assert.equal(donationRecordFrom({ ...paidDonation, mode: 'subscription' }), null);
  });

  it('ignores a setup-mode session', () => {
    assert.equal(donationRecordFrom({ ...paidDonation, mode: 'setup' }), null);
  });

  /*
   * Boleto and Pix complete the session before the money moves, so
   * `payment_status` is `unpaid` at completion and `paid` later, on
   * `checkout.session.async_payment_succeeded`. Both events route to the same
   * handler; this is what makes the first one a no-op.
   */
  it('ignores a session whose payment has not settled yet', () => {
    assert.equal(donationRecordFrom({ ...paidDonation, payment_status: 'unpaid' }), null);
    assert.equal(donationRecordFrom({ ...paidDonation, payment_status: undefined }), null);
  });

  // A guest donation is allowed and stores nothing: no uid, no record. The
  // Privacy Policy says so, and this is the line that makes it true.
  it('records nothing for a session with no Firebase account on it', () => {
    assert.equal(donationRecordFrom({ ...paidDonation, metadata: {} }), null);
    assert.equal(donationRecordFrom({ ...paidDonation, metadata: null }), null);
    assert.equal(donationRecordFrom({ ...paidDonation, metadata: { firebaseUID: '' } }), null);
    assert.equal(donationRecordFrom({ ...paidDonation, metadata: { firebaseUID: 42 } }), null);
  });

  it('records nothing without a usable amount', () => {
    assert.equal(donationRecordFrom({ ...paidDonation, amount_total: null }), null);
    assert.equal(donationRecordFrom({ ...paidDonation, amount_total: 0 }), null);
    assert.equal(donationRecordFrom({ ...paidDonation, amount_total: -100 }), null);
    assert.equal(donationRecordFrom({ ...paidDonation, amount_total: '500' }), null);
  });

  it('records nothing without a currency', () => {
    assert.equal(donationRecordFrom({ ...paidDonation, currency: null }), null);
    assert.equal(donationRecordFrom({ ...paidDonation, currency: '' }), null);
  });

  it('records nothing for a session with no id to key the document on', () => {
    assert.equal(donationRecordFrom({ ...paidDonation, id: undefined }), null);
  });

  // The caller substitutes the event's own timestamp. Defaulting to zero here
  // would file the donation under 1970, which reads like data rather than like
  // a field Stripe did not send.
  it('reports an unusable timestamp as absent rather than as the epoch', () => {
    assert.equal(
      donationRecordFrom({ ...paidDonation, created: undefined })?.createdAtSeconds,
      null,
    );
    assert.equal(donationRecordFrom({ ...paidDonation, created: 'now' })?.createdAtSeconds, null);
  });

  // Stripe uses this for a zero-amount session; the amount check is what
  // refuses it, so the status itself is not treated as a failure.
  it('accepts `no_payment_required` only when there is still an amount', () => {
    assert.equal(
      donationRecordFrom({ ...paidDonation, payment_status: 'no_payment_required' })?.amount,
      500,
    );
    assert.equal(
      donationRecordFrom({
        ...paidDonation,
        payment_status: 'no_payment_required',
        amount_total: 0,
      }),
      null,
    );
  });
});
