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

interface IndexField {
  fieldPath: string;
  order?: 'ASCENDING' | 'DESCENDING';
  /** An array field is indexed by containment rather than by order. */
  arrayConfig?: 'CONTAINS';
}

interface IndexSpec {
  indexes: { collectionGroup: string; fields: IndexField[] }[];
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

  it('gives every field either an order or an arrayConfig, and never both', () => {
    // The two are alternatives in Firestore's index spec: an ordinary field
    // carries `order`, an array field indexed for `array-contains`/
    // `array-contains-any` carries `arrayConfig: CONTAINS`. A field with
    // neither, or with both, is rejected by the deploy — which, per the block
    // comment above, is a failure that lands on somebody else's PR.
    for (const index of spec.indexes) {
      for (const field of index.fields) {
        expect(Boolean(field.order) !== Boolean(field.arrayConfig)).toBe(true);
      }
    }
  });

  /**
   * The tag filter's four query shapes (`FEAT-021`). `getCustomQuestions` sends
   * `status` plus an optional `category` and `difficulty`, and adds an
   * `array-contains-any` on `tags` when the player has selected some — so every
   * combination of the two optional equalities needs its own composite, with
   * the array field last because Firestore requires equalities before it.
   *
   * Asserted here rather than left to the deploy, because the emulator cannot
   * enforce index configuration at all: a missing one is green in every local
   * suite and fails only in production, as a filtered draw that returns nothing
   * and looks like an empty bank.
   */
  it('declares a tags index beside each shape the filtered draw runs', () => {
    const shapes = spec.indexes
      .filter(
        (index) =>
          index.collectionGroup === 'custom_questions' &&
          index.fields.some((field) => field.fieldPath === 'tags'),
      )
      .map((index) => index.fields.map((field) => field.fieldPath).join('+'))
      .sort();

    expect(shapes).toEqual([
      'status+category+difficulty+tags',
      'status+category+tags',
      'status+difficulty+tags',
      'status+tags',
    ]);

    for (const index of spec.indexes) {
      const tags = index.fields.find((field) => field.fieldPath === 'tags');
      if (tags) {
        expect(tags.arrayConfig).toBe('CONTAINS');
        expect(index.fields.at(-1)?.fieldPath).toBe('tags');
      }
    }
  });

  it('keeps a ttl field override on every Stripe session collection', () => {
    // These are what stop the session collections growing forever (finding
    // C2); losing one would be invisible until the collection did. A new
    // handshake path is a new collection group, so it belongs here the day it
    // ships rather than the day somebody notices the documents piling up.
    const ttlGroups = spec.fieldOverrides
      .filter((override) => override.ttl === true && override.fieldPath === 'expiresAt')
      .map((override) => override.collectionGroup)
      .sort();

    expect(ttlGroups).toEqual(['checkout_sessions', 'donation_sessions', 'portal_sessions']);
  });
});
