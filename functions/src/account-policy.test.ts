import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANONYMISED_AUTHOR, isCancellableStatus } from './account-policy';

test('cancels every status that still represents live billing', () => {
  for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused'] as const) {
    assert.equal(isCancellableStatus(status), true, `${status} should be cancelled`);
  }
});

test('leaves terminal statuses alone — cancelling them again can only fail', () => {
  for (const status of ['canceled', 'incomplete', 'incomplete_expired'] as const) {
    assert.equal(isCancellableStatus(status), false, `${status} should not be cancelled`);
  }
});

test('treats an unrecognised status as live, because a missed cancel keeps charging', () => {
  assert.equal(isCancellableStatus('some_future_status' as never), true);
});

test('the anonymised author sentinel cannot be mistaken for a real uid or a missing field', () => {
  // Firebase uids are alphanumeric, so the brackets guarantee no collision.
  assert.match(ANONYMISED_AUTHOR, /[^a-zA-Z0-9]/);
  assert.notEqual(ANONYMISED_AUTHOR, '');
  assert.equal(typeof ANONYMISED_AUTHOR, 'string');
});
