/**
 * Runs the daily job's passes in turn, each on its own terms (`daily-sweep.ts`).
 *
 * The job carries two unrelated promises the Privacy Policy makes — twelve
 * months of play history, and a report's reporter removed thirty days after it
 * is filed — so a pass that fails must not cost the other its run. Each is
 * awaited in its own `try` and its outcome logged either way, and the run
 * still fails if any pass did: a broken pass is an error in the logs and a
 * failed invocation, never a silence, because a sweep that stops quietly is a
 * published promise that quietly stops being kept.
 *
 * Pure and free of `firebase-functions` so the isolation is unit-tested
 * directly; the logger is injected.
 */

/** One pass of the daily job. */
export interface SweepPass {
  /** What the pass is called in the logs. */
  name: string;
  /** Runs the pass and returns the line to log about what it did. */
  run(): Promise<string>;
}

/** The two calls of `firebase-functions/logger` this uses. */
export interface SweepLogger {
  info(message: string): void;
  error(message: string, error: unknown): void;
}

/**
 * Runs every pass, in order, whatever the others did, and rejects afterwards
 * with every failure if any pass failed.
 *
 * In order rather than all at once: the passes touch different collections,
 * so nothing would be gained by overlapping them, and one at a time keeps the
 * job's logs in the order the passes ran.
 */
export async function runSweepPasses(passes: SweepPass[], log: SweepLogger): Promise<void> {
  const failures: unknown[] = [];
  for (const pass of passes) {
    try {
      log.info(await pass.run());
    } catch (error) {
      log.error(`${pass.name} failed`, error);
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} of ${passes.length} sweep pass(es) failed`,
    );
  }
}
