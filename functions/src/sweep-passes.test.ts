import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type SweepLogger, type SweepPass, runSweepPasses } from './sweep-passes';

/**
 * The daily job's two passes are unrelated promises (`daily-sweep.ts`): twelve
 * months of play history, and a report's reporter removed once its question is
 * decided. What is pinned here is that one failing cannot cost the other its
 * run, and that a failure still fails the run rather than vanishing into a log
 * line nobody reads.
 */

function recordingLogger(): SweepLogger & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    errors,
    info(message) {
      infos.push(message);
    },
    error(message) {
      errors.push(message);
    },
  };
}

const pass = (name: string, outcome: string | Error, ran: string[]): SweepPass => ({
  name,
  run: () => {
    ran.push(name);
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  },
});

test('runs every pass in order and logs what each did', async () => {
  const ran: string[] = [];
  const log = recordingLogger();

  await runSweepPasses(
    [pass('plays', 'deleted 3 plays', ran), pass('reports', 'anonymised 2 reports', ran)],
    log,
  );

  assert.deepEqual(ran, ['plays', 'reports']);
  assert.deepEqual(log.infos, ['deleted 3 plays', 'anonymised 2 reports']);
  assert.deepEqual(log.errors, []);
});

test('a pass that fails does not stop the one after it, and still fails the run', async () => {
  const ran: string[] = [];
  const log = recordingLogger();
  const missingIndex = new Error('FAILED_PRECONDITION: the query requires an index');

  await assert.rejects(
    runSweepPasses(
      [pass('plays', missingIndex, ran), pass('reports', 'anonymised 2 reports', ran)],
      log,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [missingIndex]);
      assert.match(error.message, /1 of 2/);
      return true;
    },
  );

  assert.deepEqual(ran, ['plays', 'reports'], 'the second pass ran anyway');
  assert.deepEqual(log.infos, ['anonymised 2 reports']);
  assert.deepEqual(log.errors, ['plays failed']);
});

test('every failure is carried, not only the first', async () => {
  const ran: string[] = [];
  const first = new Error('first');
  const second = new Error('second');

  await assert.rejects(
    runSweepPasses([pass('plays', first, ran), pass('reports', second, ran)], recordingLogger()),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [first, second]);
      assert.match(error.message, /2 of 2/);
      return true;
    },
  );
});
