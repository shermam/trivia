import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_GAMES_PER_WINDOW,
  MAX_QUESTIONS_PER_GAME,
  type GameResultSubmission,
  type UserStats,
  isValidSubmission,
  nextUserStats,
} from './game-stats';

const NOW = 1_756_300_000_000;
const HOUR = 60 * 60 * 1000;

function submission(overrides: Partial<GameResultSubmission> = {}): GameResultSubmission {
  return { gameId: 'game-1', totalQuestions: 10, correctAnswers: 7, bestStreak: 4, ...overrides };
}

function stored(overrides: Partial<UserStats> = {}): UserStats {
  return {
    gamesPlayed: 5,
    questionsAnswered: 50,
    correctAnswers: 30,
    bestStreak: 6,
    lastGameId: 'game-0',
    statsSince: NOW - 10 * HOUR,
    updatedAt: NOW - HOUR,
    rateWindowStart: NOW - 10 * 60 * 1000,
    gamesInWindow: 3,
    ...overrides,
  };
}

function accept(decision: ReturnType<typeof nextUserStats>): UserStats {
  assert.equal(decision.accepted, true, `expected accepted, got ${JSON.stringify(decision)}`);
  assert.ok(decision.accepted);
  return decision.stats;
}

// ---------------------------------------------------------------------------
// Accept cases first, deliberately. `CLAUDE.md` §4.6: a suite of nothing but
// reject cases passes against a decision function that refuses everything, and
// that has already shipped once in this repo.
// ---------------------------------------------------------------------------

test('creates the document on a first game, starting the lifetime clock', () => {
  const stats = accept(nextUserStats(null, submission(), NOW));

  assert.equal(stats.gamesPlayed, 1);
  assert.equal(stats.questionsAnswered, 10);
  assert.equal(stats.correctAnswers, 7);
  assert.equal(stats.bestStreak, 4);
  assert.equal(stats.lastGameId, 'game-1');
  assert.equal(stats.statsSince, NOW);
  assert.equal(stats.updatedAt, NOW);
  assert.equal(stats.gamesInWindow, 1);
  assert.equal(stats.rateWindowStart, NOW);
});

test('adds one game to existing totals', () => {
  const stats = accept(nextUserStats(stored(), submission(), NOW));

  assert.equal(stats.gamesPlayed, 6);
  assert.equal(stats.questionsAnswered, 60);
  assert.equal(stats.correctAnswers, 37);
  assert.equal(stats.gamesInWindow, 4);
});

// `statsSince` is what makes "lifetime" honest — every existing player starts
// at zero on ship day, and without the marker a long-standing account's first
// post-launch game silently reads as their whole history.
test('never rewrites statsSince, even when the clock has gone backwards', () => {
  const original = NOW - 10 * HOUR;
  const stats = accept(
    nextUserStats(stored({ statsSince: original }), submission(), NOW - 20 * HOUR),
  );

  assert.equal(stats.statsSince, original);
});

test('keeps the better streak, whichever side it is on', () => {
  assert.equal(
    accept(nextUserStats(stored({ bestStreak: 9 }), submission({ bestStreak: 4 }), NOW)).bestStreak,
    9,
  );
  assert.equal(
    accept(nextUserStats(stored({ bestStreak: 2 }), submission({ bestStreak: 4 }), NOW)).bestStreak,
    4,
  );
});

/**
 * The all-correct maximal game: three bounds simultaneously at their inclusive
 * edge. Written because an off-by-one in any of them turns a legitimate
 * perfect game into a rejection, and a reject-only suite would never notice.
 */
test('accepts a perfect 25-question game, every bound at its inclusive edge', () => {
  const stats = accept(
    nextUserStats(
      null,
      submission({ totalQuestions: 25, correctAnswers: 25, bestStreak: 25 }),
      NOW,
    ),
  );

  assert.equal(stats.questionsAnswered, MAX_QUESTIONS_PER_GAME);
  assert.equal(stats.correctAnswers, 25);
  assert.equal(stats.bestStreak, 25);
});

test('accepts a game with nothing right', () => {
  const stats = accept(nextUserStats(null, submission({ correctAnswers: 0, bestStreak: 0 }), NOW));

  assert.equal(stats.correctAnswers, 0);
  assert.equal(stats.bestStreak, 0);
  assert.equal(stats.gamesPlayed, 1);
});

/**
 * A game saved before `FEAT-001` shipped restores with `answerHistory: []` —
 * an additive field with no `SCHEMA_VERSION` bump, by design — so the client
 * derives `bestStreak: 0` while `correctAnswers` is genuinely 7. That is a
 * knowing under-report, not a rejection: pinned so the behaviour is chosen
 * rather than discovered.
 */
test('accepts a zero streak alongside a non-zero score, which is what a pre-recap save yields', () => {
  const stats = accept(nextUserStats(null, submission({ correctAnswers: 7, bestStreak: 0 }), NOW));

  assert.equal(stats.correctAnswers, 7);
  assert.equal(stats.bestStreak, 0);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('refuses a game id already banked', () => {
  const decision = nextUserStats(
    stored({ lastGameId: 'game-1' }),
    submission({ gameId: 'game-1' }),
    NOW,
  );

  assert.deepEqual(decision, { accepted: false, reason: 'duplicate' });
});

/**
 * **The ordering test.** The duplicate check must run *before* the rate
 * window, or a player reloading `/game-over` on a flaky connection burns an
 * hour's budget on one game — and the reload is a supported action, not an
 * edge case. Getting this backwards yields `rate-limited` here, which is both
 * the wrong reason and the wrong outcome.
 */
test('a duplicate at a full window is refused as a duplicate, and consumes no budget', () => {
  const current = stored({ lastGameId: 'game-1', gamesInWindow: MAX_GAMES_PER_WINDOW });
  const decision = nextUserStats(current, submission({ gameId: 'game-1' }), NOW);

  assert.deepEqual(decision, { accepted: false, reason: 'duplicate' });
  assert.equal(current.gamesInWindow, MAX_GAMES_PER_WINDOW, 'the stored counter must not move');
});

// ---------------------------------------------------------------------------
// The rolling window. Not §4.1's quota cap — see the constant's comment — but
// it is what bounds stat inflation from a loop of fresh game ids.
// ---------------------------------------------------------------------------

test('refuses a game once the window is full', () => {
  const decision = nextUserStats(
    stored({ gamesInWindow: MAX_GAMES_PER_WINDOW }),
    submission(),
    NOW,
  );

  assert.deepEqual(decision, { accepted: false, reason: 'rate-limited' });
});

test('accepts the last game that fits in the window', () => {
  const stats = accept(
    nextUserStats(stored({ gamesInWindow: MAX_GAMES_PER_WINDOW - 1 }), submission(), NOW),
  );

  assert.equal(stats.gamesInWindow, MAX_GAMES_PER_WINDOW);
});

test('rolls the window once an hour has passed, and starts counting again', () => {
  const stats = accept(
    nextUserStats(
      stored({ gamesInWindow: MAX_GAMES_PER_WINDOW, rateWindowStart: NOW - HOUR }),
      submission(),
      NOW,
    ),
  );

  assert.equal(stats.gamesInWindow, 1);
  assert.equal(stats.rateWindowStart, NOW);
});

test('does not roll the window one millisecond early', () => {
  const decision = nextUserStats(
    stored({ gamesInWindow: MAX_GAMES_PER_WINDOW, rateWindowStart: NOW - HOUR + 1 }),
    submission(),
    NOW,
  );

  assert.deepEqual(decision, { accepted: false, reason: 'rate-limited' });
});

// ---------------------------------------------------------------------------
// Bounds. These are the "hard-bounded" half of §4.1 — the payload is
// client-supplied, so each of these is a number somebody could send.
// ---------------------------------------------------------------------------

test('refuses more questions than a game can hold', () => {
  const decision = nextUserStats(
    null,
    submission({ totalQuestions: MAX_QUESTIONS_PER_GAME + 1 }),
    NOW,
  );

  assert.deepEqual(decision, { accepted: false, reason: 'invalid' });
});

test('refuses a game with no questions', () => {
  assert.deepEqual(nextUserStats(null, submission({ totalQuestions: 0 }), NOW), {
    accepted: false,
    reason: 'invalid',
  });
});

test('refuses more correct answers than questions', () => {
  assert.deepEqual(nextUserStats(null, submission({ totalQuestions: 5, correctAnswers: 6 }), NOW), {
    accepted: false,
    reason: 'invalid',
  });
});

/**
 * Bounded against `correctAnswers`, not `totalQuestions`. The looser check
 * would admit a 25-long streak on a game with three right answers, which is
 * the shape of claim this bound exists to refuse.
 */
test('refuses a streak longer than the number of correct answers', () => {
  assert.deepEqual(
    nextUserStats(null, submission({ totalQuestions: 10, correctAnswers: 3, bestStreak: 4 }), NOW),
    { accepted: false, reason: 'invalid' },
  );
});

test('refuses negative and fractional numbers', () => {
  for (const bad of [
    submission({ correctAnswers: -1 }),
    submission({ bestStreak: -1 }),
    submission({ totalQuestions: -5 }),
    submission({ totalQuestions: 10.5 }),
    submission({ correctAnswers: 1.5 }),
  ]) {
    assert.deepEqual(nextUserStats(null, bad, NOW), { accepted: false, reason: 'invalid' });
  }
});

test('refuses a missing, empty or over-long game id', () => {
  for (const bad of [
    submission({ gameId: '' }),
    submission({ gameId: 'x'.repeat(129) }),
    { ...submission(), gameId: undefined } as unknown as GameResultSubmission,
    { ...submission(), gameId: 42 } as unknown as GameResultSubmission,
  ]) {
    assert.deepEqual(nextUserStats(null, bad, NOW), { accepted: false, reason: 'invalid' });
  }
});

test('accepts a game id at exactly the length limit', () => {
  assert.equal(
    accept(nextUserStats(null, submission({ gameId: 'x'.repeat(128) }), NOW)).lastGameId.length,
    128,
  );
});

// The callable hands `request.data` straight through, and that is `unknown` —
// anything at all can arrive on the wire.
test('refuses a payload that is not an object', () => {
  for (const bad of [null, undefined, 'game', 42, []]) {
    assert.equal(isValidSubmission(bad), false);
    assert.deepEqual(nextUserStats(null, bad as unknown as GameResultSubmission, NOW), {
      accepted: false,
      reason: 'invalid',
    });
  }
});

test('isValidSubmission accepts a well-formed payload', () => {
  assert.equal(isValidSubmission(submission()), true);
});
