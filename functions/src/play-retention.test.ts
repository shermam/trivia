import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PLAY_HISTORY_RETENTION_MS,
  PLAY_SWEEP_BATCH_SIZE,
  PLAY_SWEEP_MAX_PASSES,
  type PlaySweepStore,
  isExpiredPlay,
  playRetentionCutoff,
  sweepExpiredPlays,
} from './play-retention';

const NOW = 1_757_900_000_000;
const DAY = 24 * 60 * 60 * 1000;

test('keeps twelve months of history', () => {
  assert.equal(PLAY_HISTORY_RETENTION_MS, 365 * DAY);
});

test('the cutoff is one retention period behind now', () => {
  assert.equal(playRetentionCutoff(NOW), NOW - PLAY_HISTORY_RETENTION_MS);
});

// ---------------------------------------------------------------------------
// The boundary. Both sides of it, because a predicate that answered "expired"
// to everything would satisfy a suite of nothing but expired cases.
// ---------------------------------------------------------------------------

test('a game banked a day inside the period survives', () => {
  assert.equal(isExpiredPlay(NOW - PLAY_HISTORY_RETENTION_MS + DAY, NOW), false);
});

test('a game banked today survives, and so does one banked a moment ago', () => {
  assert.equal(isExpiredPlay(NOW, NOW), false);
  assert.equal(isExpiredPlay(NOW - 1, NOW), false);
});

/**
 * Exactly twelve months old is **not** expired, and the direction is pinned
 * rather than left to whichever comparison somebody writes next: the sweep's
 * own query is `where('at', '<', cutoff)`, and a predicate disagreeing with it
 * would describe a boundary the code does not have.
 */
test('a game banked exactly one retention period ago survives one more run', () => {
  assert.equal(isExpiredPlay(playRetentionCutoff(NOW), NOW), false);
});

test('a game banked one millisecond earlier than that is expired', () => {
  assert.equal(isExpiredPlay(playRetentionCutoff(NOW) - 1, NOW), true);
});

test('a game banked two years ago is expired', () => {
  assert.equal(isExpiredPlay(NOW - 2 * PLAY_HISTORY_RETENTION_MS, NOW), true);
});

// ---------------------------------------------------------------------------
// The sweep. Driven against a fake store, so the paging is exercised without an
// emulator — which is the half of this that a boundary test cannot reach.
// ---------------------------------------------------------------------------

interface FakePlay {
  id: string;
  at: number;
}

/** A store over a fixed set of plays, recording how it was asked for them. */
function fakeStore(plays: FakePlay[]): PlaySweepStore<FakePlay> & {
  readonly remaining: FakePlay[];
  readonly pages: number[];
  readonly cutoffs: number[];
} {
  const remaining = [...plays];
  const pages: number[] = [];
  const cutoffs: number[] = [];

  return {
    remaining,
    pages,
    cutoffs,
    async findExpired(cutoff, limit) {
      cutoffs.push(cutoff);
      return remaining.filter((play) => play.at < cutoff).slice(0, limit);
    },
    async deleteAll(handles) {
      pages.push(handles.length);
      for (const handle of handles) {
        remaining.splice(remaining.indexOf(handle), 1);
      }
    },
  };
}

const expired = (count: number, from = 0): FakePlay[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `old-${from + i}`,
    at: NOW - PLAY_HISTORY_RETENTION_MS - DAY,
  }));

test('deletes nothing, and writes nothing, when no play has expired', async () => {
  const store = fakeStore([{ id: 'fresh', at: NOW - DAY }]);

  assert.equal(await sweepExpiredPlays(store, NOW), 0);
  assert.deepEqual(store.pages, [], 'no batch is committed for an empty page');
  assert.deepEqual(
    store.remaining.map((p) => p.id),
    ['fresh'],
  );
});

test('deletes a single short page in one pass', async () => {
  const store = fakeStore([...expired(3), { id: 'fresh', at: NOW - DAY }]);

  assert.equal(await sweepExpiredPlays(store, NOW), 3);
  assert.deepEqual(store.pages, [3]);
  assert.deepEqual(
    store.remaining.map((p) => p.id),
    ['fresh'],
    'the fresh play is untouched',
  );
});

/**
 * **The batching.** 1,200 expired documents cannot go in one `WriteBatch` —
 * Firestore caps it at 500 — so the sweep has to page, and a full page has to
 * be followed by another query rather than taken as the end of the run.
 */
test('pages a backlog larger than one batch, 500 at a time', async () => {
  const store = fakeStore([...expired(1_200), { id: 'fresh', at: NOW }]);

  assert.equal(await sweepExpiredPlays(store, NOW), 1_200);
  assert.deepEqual(store.pages, [PLAY_SWEEP_BATCH_SIZE, PLAY_SWEEP_BATCH_SIZE, 200]);
  assert.deepEqual(
    store.remaining.map((p) => p.id),
    ['fresh'],
  );
});

/**
 * A page that comes back exactly full and empties the collection still costs
 * one more query — the sweep cannot tell "500 and nothing else" from "500 of
 * many" without asking.
 */
test('asks once more after a page that is exactly full', async () => {
  const store = fakeStore(expired(PLAY_SWEEP_BATCH_SIZE));

  assert.equal(await sweepExpiredPlays(store, NOW), PLAY_SWEEP_BATCH_SIZE);
  assert.deepEqual(store.pages, [PLAY_SWEEP_BATCH_SIZE]);
  assert.equal(store.cutoffs.length, 2);
});

/**
 * The run stops itself rather than running until the platform kills it. Nothing
 * is lost by stopping: tomorrow's run picks up where this one left off, which
 * is the property that makes a ceiling safe at all.
 */
test('stops after the pass ceiling, leaving the rest for the next run', async () => {
  const backlog = PLAY_SWEEP_BATCH_SIZE * (PLAY_SWEEP_MAX_PASSES + 2);
  const store = fakeStore(expired(backlog));

  const deleted = await sweepExpiredPlays(store, NOW);

  assert.equal(deleted, PLAY_SWEEP_BATCH_SIZE * PLAY_SWEEP_MAX_PASSES);
  assert.equal(store.pages.length, PLAY_SWEEP_MAX_PASSES);
  assert.equal(store.remaining.length, backlog - deleted);
});

test('asks for every page against the same cutoff', async () => {
  const store = fakeStore(expired(600));

  await sweepExpiredPlays(store, NOW);

  assert.deepEqual(new Set(store.cutoffs), new Set([playRetentionCutoff(NOW)]));
});
