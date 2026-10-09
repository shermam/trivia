/**
 * Reading a question's `provenance` (`FEAT-020`): whether a machine wrote it,
 * and which run of the generation pipeline did.
 *
 * **Re-checked here, never trusted.** The pipeline writes the map on the Admin
 * SDK and nothing in `firestore.rules` reads it, so the only thing that has
 * ever validated it is the program that wrote it — and `custom_questions` is a
 * public API the console can write any shape to. The reader has to be right
 * regardless of the writer (`CLAUDE.md` §4.4), so a value that is not a map, or
 * a map whose `source` is not exactly `'ai'`, reads as what an absent one
 * means: a question a person wrote.
 *
 * Both functions take the stored value rather than the question, so they serve
 * the document a reviewer reads and the `TriviaQuestion` a game carries alike.
 */

/** How many characters of a run id the review card shows before it elides the rest. */
export const RUN_ID_SHOWN = 32;

function asMap(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether a question's stored `provenance` says a machine generated it — the
 * one condition the "Machine-generated from …" label turns on.
 */
export function isMachineGenerated(provenance: unknown): boolean {
  return asMap(provenance)?.['source'] === 'ai';
}

/**
 * The id of the run that produced a question, as the review card names it:
 * trimmed, and cut to {@link RUN_ID_SHOWN} characters with an ellipsis when it
 * is longer — the pipeline allows a hundred, and the card's line holds one
 * line. `null` when there is no usable id, which the card reads as "say
 * nothing about the run" rather than as an error.
 *
 * The timestamp leads every id the pipeline mints (`20261009T120000Z-topic`),
 * so the part that survives the cut is the part that tells two runs apart.
 */
export function shownRunId(provenance: unknown): string | null {
  const runId = asMap(provenance)?.['runId'];
  if (typeof runId !== 'string') {
    return null;
  }
  const trimmed = runId.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > RUN_ID_SHOWN ? `${trimmed.slice(0, RUN_ID_SHOWN - 1)}…` : trimmed;
}
