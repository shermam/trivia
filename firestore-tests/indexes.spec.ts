import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards `firestore.indexes.json` against the one mistake that breaks the
 * production deploy pipeline *silently and permanently*.
 *
 * A composite index must **not** declare `__name__` among its fields, even
 * though Firestore's API reports it there and the index really does end with
 * it. The reason is a disagreement between the two `firebase-tools` majors this
 * repo runs (see `INFRASTRUCTURE.md` §6.3):
 *
 * - **@13**, which the deploy step uses, strips `__name__` out of every index
 *   it reads back from the project, then compares field counts against the file
 *   verbatim. A declared `__name__` therefore makes the file look like a
 *   *different* index from the one in production, so the CLI decides the live
 *   one should be deleted — and in non-interactive mode refuses to continue
 *   without `--force`.
 * - **@14** appends `__name__` to the spec when it is absent, so it matches
 *   either way.
 *
 * Omitting it is therefore correct under both, and declaring it is correct
 * under only one.
 *
 * What makes this worth a test rather than a comment is the failure's shape: it
 * does not fail the deploy that introduces it. That one creates the index and
 * succeeds. Every *subsequent* deploy then fails, on unrelated PRs, having
 * already shipped Hosting — so the pipeline breaks with a red step somewhere no
 * one is looking, on a change with nothing to do with indexes. `--dry-run` does
 * not catch it either: it validates the file, not the diff against the project.
 * Nothing else in the suite can see this, because the emulator does not enforce
 * index configuration at all.
 */

interface IndexSpec {
  indexes: { collectionGroup: string; fields: { fieldPath: string }[] }[];
  fieldOverrides: { collectionGroup: string; fieldPath: string; ttl?: boolean }[];
}

const spec = JSON.parse(readFileSync('firestore.indexes.json', 'utf8')) as IndexSpec;

describe('firestore.indexes.json', () => {
  it('never declares __name__ in a composite index', () => {
    const offenders = spec.indexes
      .filter((index) => index.fields.some((field) => field.fieldPath === '__name__'))
      .map((index) => index.collectionGroup);

    expect(offenders).toEqual([]);
  });

  it('gives every index at least two fields, since one is served automatically', () => {
    // A single equality filter ordered by document ID is served by Firestore's
    // automatic single-field index, and declaring a composite for it is
    // rejected as redundant.
    for (const index of spec.indexes) {
      expect(index.fields.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps a ttl field override on both Stripe session collections', () => {
    // These are what stop `checkout_sessions`/`portal_sessions` growing forever
    // (finding C2); losing one would be invisible until the collection did.
    const ttlGroups = spec.fieldOverrides
      .filter((override) => override.ttl === true && override.fieldPath === 'expiresAt')
      .map((override) => override.collectionGroup)
      .sort();

    expect(ttlGroups).toEqual(['checkout_sessions', 'portal_sessions']);
  });
});
