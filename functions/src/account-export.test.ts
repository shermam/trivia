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
  leaderboardEntries: [],
  gameplayStats: null,
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
    leaderboardEntries: [{ score: 7, totalQuestions: 10 }],
    contributedQuestions: [{ question: 'Q1' }, { question: 'Q2' }],
    stripeCustomerId: 'cus_123',
    subscriptions: [{ status: 'active' }],
    checkoutSessions: [{ price: 'price_1' }],
    portalSessions: [{ return_url: 'https://example.test' }],
  });

  assert.equal(result.account.uid, 'user-1');
  assert.equal(result.account.email, 'player@example.com');
  assert.deepEqual(result.account.signInProviders, ['password', 'google.com']);
  assert.deepEqual(result.leaderboardEntries, [{ score: 7, totalQuestions: 10 }]);
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
  assert.deepEqual(result.leaderboardEntries, []);
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

/**
 * Finding G7 split one leaderboard into three, so an export has to answer for
 * all of them. A player holding a score on two boards and not the third is the
 * ordinary case, and it is the case that catches the tempting implementation:
 * filtering the snapshots before pairing them with their board renumbers the
 * survivors, so the second board's entry gets reported as the first's.
 */
test('keeps each leaderboard entry labelled with the board it came from', () => {
  const result = buildAccountExport({
    ...base,
    leaderboardEntries: [
      { board: '30', score: 8, totalQuestions: 10 },
      { board: 'unlimited', score: 10, totalQuestions: 10 },
    ],
  });

  assert.deepEqual(
    result.leaderboardEntries.map((entry) => entry['board']),
    ['30', 'unlimited'],
  );
});

/**
 * The lifetime totals from `users/{uid}`. Two rows, because the absent case is
 * the one that matters: the document is created lazily on the first completed
 * game, so an account that has never finished one legitimately has nothing —
 * and an export that dropped the key would read as "we are not telling you"
 * rather than "there is nothing", which is the distinction this file's
 * `notHeldHere` exists to make everywhere else.
 */
test('includes lifetime gameplay totals when the account has them', () => {
  const result = buildAccountExport({
    ...base,
    gameplayStats: { gamesPlayed: 12, questionsAnswered: 120, correctAnswers: 84, bestStreak: 9 },
  });

  assert.deepEqual(result.gameplayStats, {
    gamesPlayed: 12,
    questionsAnswered: 120,
    correctAnswers: 84,
    bestStreak: 9,
  });
});

test('reports an explicit null, not an absent key, when no game has been finished', () => {
  const result = buildAccountExport({ ...base, gameplayStats: null });

  assert.equal(result.gameplayStats, null);
  assert.ok('gameplayStats' in result, 'the key must be present so its emptiness is stated');
});
