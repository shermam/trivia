import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SESSION_DOC_TTL_MS, sessionExpiryAt } from './session-expiry';

test('expires a session document a fixed window after it was created', () => {
  const createdAt = new Date('2026-08-09T12:00:00.000Z');

  assert.equal(sessionExpiryAt(createdAt).toISOString(), '2026-08-10T12:00:00.000Z');
});

test('never expires a document before the Stripe session it describes', () => {
  // Stripe Checkout Sessions expire after 24 hours. A shorter TTL here would
  // delete the document while the thing it points at is still live — exactly
  // when someone debugging a failed payment would go looking for it.
  const STRIPE_CHECKOUT_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

  assert.ok(SESSION_DOC_TTL_MS >= STRIPE_CHECKOUT_SESSION_LIFETIME_MS);
});

test('always moves forward, so a document cannot be created already expired', () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');

  assert.ok(sessionExpiryAt(createdAt).getTime() > createdAt.getTime());
});

test('does not mutate the date it is given', () => {
  const createdAt = new Date('2026-08-09T12:00:00.000Z');
  const before = createdAt.getTime();

  sessionExpiryAt(createdAt);

  assert.equal(createdAt.getTime(), before);
});
