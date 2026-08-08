import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAccountExport } from './account-export';

const user = {
  uid: 'user-1',
  email: 'player@example.com',
  displayName: 'Ada',
  emailVerified: true,
  providerData: [{ providerId: 'password' }, { providerId: 'google.com' }],
  metadata: { creationTime: 'Wed, 01 Jan 2025 00:00:00 GMT', lastSignInTime: null },
} as unknown as Parameters<typeof buildAccountExport>[0]['user'];

const base = {
  user,
  leaderboardEntry: null,
  contributedQuestions: [],
  stripeCustomerId: null,
  subscriptions: [],
  checkoutSessions: [],
  portalSessions: [],
  now: new Date('2026-01-01T00:00:00.000Z'),
};

test('includes every category of data the app actually holds', () => {
  const result = buildAccountExport({
    ...base,
    leaderboardEntry: { score: 7, totalQuestions: 10 },
    contributedQuestions: [{ question: 'Q1' }, { question: 'Q2' }],
    stripeCustomerId: 'cus_123',
    subscriptions: [{ status: 'active' }],
    checkoutSessions: [{ price: 'price_1' }],
    portalSessions: [{ return_url: 'https://example.test' }],
  });

  assert.equal(result.account.uid, 'user-1');
  assert.equal(result.account.email, 'player@example.com');
  assert.deepEqual(result.account.signInProviders, ['password', 'google.com']);
  assert.deepEqual(result.leaderboardEntry, { score: 7, totalQuestions: 10 });
  assert.equal(result.contributedQuestions.length, 2);
  assert.equal(result.billing.stripeCustomerId, 'cus_123');
  assert.equal(result.billing.subscriptions.length, 1);
  assert.equal(result.billing.checkoutSessions.length, 1);
  assert.equal(result.billing.portalSessions.length, 1);
  assert.equal(result.exportedAt, '2026-01-01T00:00:00.000Z');
});

test('represents "nothing here" as empty rather than omitting the section', () => {
  const result = buildAccountExport(base);
  // A missing key reads as "we are not telling you"; an explicit null or []
  // reads as "there is nothing". For an export, that difference matters.
  assert.equal(result.leaderboardEntry, null);
  assert.deepEqual(result.contributedQuestions, []);
  assert.equal(result.billing.stripeCustomerId, null);
  assert.deepEqual(result.billing.subscriptions, []);
});

test('normalises absent Auth metadata to null instead of undefined', () => {
  // undefined disappears through JSON.stringify, which would silently drop the
  // field from the delivered file rather than showing it as empty.
  const result = buildAccountExport(base);
  assert.equal(result.account.lastSignInAt, null);
  assert.ok(!JSON.stringify(result).includes('undefined'));
});

test('states what is deliberately not held, so gaps do not read as concealment', () => {
  const result = buildAccountExport(base);
  assert.ok(result.notHeldHere.length >= 3);
  assert.ok(result.notHeldHere.some((line) => /stripe/i.test(line)));
  assert.ok(result.notHeldHere.some((line) => /password/i.test(line)));
});
