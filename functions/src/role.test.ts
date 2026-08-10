import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseStripeRole, deriveClaimRole } from './role';

test('grants the role for active/trialing subscriptions', () => {
  assert.equal(deriveClaimRole('active', 'pro'), 'pro');
  assert.equal(deriveClaimRole('trialing', 'pro'), 'pro');
});

test('withholds the role once a subscription lapses', () => {
  const lapsedStatuses = [
    'past_due',
    'canceled',
    'incomplete',
    'incomplete_expired',
    'unpaid',
    'paused',
  ] as const;
  for (const status of lapsedStatuses) {
    assert.equal(deriveClaimRole(status, 'pro'), null);
  }
});

test('returns null when the price has no firebaseRole metadata, regardless of status', () => {
  assert.equal(deriveClaimRole('active', null), null);
});

test('chooseStripeRole: a granting subscription wins regardless of position', () => {
  assert.equal(
    chooseStripeRole([
      { status: 'canceled', role: 'pro' },
      { status: 'active', role: 'pro' },
    ]),
    'pro',
  );
});

test('chooseStripeRole: an unrelated cancellation cannot clobber a still-active subscription', () => {
  // The reason the claim is recomputed from *all* docs: the webhook may be
  // processing the cancelled subscription's event, and the answer must still
  // be 'pro' because a different, active one exists.
  assert.equal(
    chooseStripeRole([
      { status: 'active', role: 'pro' },
      { status: 'canceled', role: 'pro' },
    ]),
    'pro',
  );
});

test('chooseStripeRole: all lapsed means no role', () => {
  assert.equal(
    chooseStripeRole([
      { status: 'canceled', role: 'pro' },
      { status: 'unpaid', role: 'pro' },
    ]),
    null,
  );
});

test('chooseStripeRole: no subscriptions means no role', () => {
  assert.equal(chooseStripeRole([]), null);
});

test('chooseStripeRole: tolerates documents missing the fields entirely', () => {
  // Raw Firestore data — nothing guarantees the shape at this boundary.
  assert.equal(chooseStripeRole([{}, { status: 'active' }, { role: 'pro' }]), null);
});
