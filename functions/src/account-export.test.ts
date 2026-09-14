import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAccountExport, timestampToIso } from './account-export';

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

/**
 * The play history (`FEAT-049`). There is no history screen in the app, so this
 * file is the only place a player ever sees it — which makes its presence here
 * the feature rather than a completeness nicety.
 */
test('includes the play history, whole rather than summarised', () => {
  const result = buildAccountExport({
    ...base,
    playHistory: [
      {
        id: 'game-2',
        at: 1_757_900_000_000,
        answers: [{ questionId: 'q1', correct: true, ms: 3_000, difficulty: 'easy' }],
      },
      { id: 'game-1', at: 1_757_800_000_000, answers: [] },
    ],
  });

  assert.equal(result.playHistory.length, 2);
  assert.equal(result.playHistory[0]['id'], 'game-2');
  assert.deepEqual(result.playHistory[0]['answers'], [
    { questionId: 'q1', correct: true, ms: 3_000, difficulty: 'easy' },
  ]);
});

/**
 * Empty rather than absent, and empty rather than `null`. An account that has
 * never played signed in has no history, which is a normal state and not
 * something to answer with a missing key — the same convention every other
 * collection in this export follows. `gameplayStats` is `null` instead because
 * it is one document rather than a collection.
 */
test('represents an account with no play history as an empty list', () => {
  assert.deepEqual(buildAccountExport(base).playHistory, []);
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
 * `FEAT-028` added a board per country under each timing constraint, and an
 * export that returned only the global rows would answer a data-access request
 * with less than the app publishes — the regional entry carries the player's
 * name, score *and* the country they declared.
 *
 * Two rows on the same board is the shape worth pinning: `board` alone no
 * longer identifies an entry, so it is the document's own `region` field that
 * tells the global row from the Brazilian one, and it has to survive the
 * spread.
 */
test('carries a regional entry alongside the global one on the same board', () => {
  const result = buildAccountExport({
    ...base,
    leaderboardEntries: [
      { board: '15', score: 8, totalQuestions: 10 },
      { board: '15', region: 'BR', score: 8, totalQuestions: 10 },
    ],
  });

  assert.deepEqual(
    result.leaderboardEntries.map((entry) => entry['region']),
    [undefined, 'BR'],
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

/**
 * Donations are billing records, and the Privacy Policy promises the export
 * returns those. An export that quietly omitted them would be the same kind of
 * misstatement `notHeldHere` exists to prevent — worse, because the money is
 * the part a reader is most likely to be checking on.
 */
test('includes one-time donations and the date the account first gave', () => {
  const result = buildAccountExport({
    ...base,
    supporterSince: '2026-09-01T10:00:00.000Z',
    donations: [{ id: 'cs_1', amount: 500, currency: 'brl' }],
  });

  assert.equal(result.billing.supporterSince, '2026-09-01T10:00:00.000Z');
  assert.deepEqual(result.billing.donations, [{ id: 'cs_1', amount: 500, currency: 'brl' }]);
});

test('states an account that has never donated as empty rather than omitting it', () => {
  const result = buildAccountExport(base);

  assert.equal(result.billing.supporterSince, null);
  assert.deepEqual(result.billing.donations, []);
  assert.ok('donations' in result.billing);
});

/**
 * A Firestore `Timestamp` serialises to `{"_seconds":…,"_nanoseconds":…}`,
 * which answers nothing a person asked for. This is the one field on the
 * customer document that is one.
 */
test('renders a Firestore timestamp as ISO 8601, and anything else as null', () => {
  assert.equal(
    timestampToIso({ toDate: () => new Date('2026-09-01T10:00:00.000Z') }),
    '2026-09-01T10:00:00.000Z',
  );
  assert.equal(timestampToIso(undefined), null);
  assert.equal(timestampToIso(null), null);
  assert.equal(timestampToIso('2026-09-01'), null);
  assert.equal(timestampToIso({ toDate: () => new Date(Number.NaN) }), null);
});
