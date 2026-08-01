import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveClaimRole } from './role';

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
