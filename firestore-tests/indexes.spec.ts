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

interface FieldOverrideIndex {
  order?: 'ASCENDING' | 'DESCENDING';
  arrayConfig?: 'CONTAINS';
  queryScope?: 'COLLECTION' | 'COLLECTION_GROUP';
}

interface IndexSpec {
  indexes: { collectionGroup: string; fields: IndexField[] }[];
  fieldOverrides: {
    collectionGroup: string;
    fieldPath: string;
    ttl?: boolean;
    indexes?: FieldOverrideIndex[];
  }[];
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
   * The tag filter's query shapes (`FEAT-021`). `getCustomQuestions` sends
   * `status`, an optional `difficulty`, and an `array-contains-any` on `tags`
   * when the player has chosen topics — `status+tags` and
   * `status+difficulty+tags`, with the array field last because Firestore
   * requires equalities before it.
   *
   * The two shapes that also name `category` are what a browser still on the
   * bundle from before topics replaced the category picker sends (`FEAT-052`),
   * and they stay declared until nothing can: removing a declaration does not
   * delete an index, and the deploy refuses a live index the file does not
   * declare (the block comment above, and `docs/data-model.md`).
   *
   * Asserted here rather than left to the deploy, because the emulator cannot
   * enforce index configuration at all: a missing one is green in every local
   * suite and fails only in production, as a filtered draw that returns nothing
   * and looks like an empty bank.
   */
  it('declares a tags index for every shape a filtered draw sends, stale bundles included', () => {
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

  /**
   * The quiz list's index (`FEAT-024`). `QuizService.listPublished` sends
   * `where('isPublished','==',true)` — which the read rule needs before it will
   * serve the query at all — ordered by `createdAt` descending, newest first,
   * and an equality on one field ordered by another is exactly what the
   * automatic single-field indexes cannot serve.
   *
   * Asserted by shape and by direction rather than left to the deploy: the
   * emulator answers the query without it, so a missing or ascending index is
   * green in every local suite and fails in production as a list that never
   * loads — on the home screen, under the card, where nobody is looking.
   */
  it('declares the index the published-quiz list queries', () => {
    const quizzes = spec.indexes.filter((index) => index.collectionGroup === 'quizzes');

    expect(quizzes).toHaveLength(1);
    expect(quizzes[0].fields).toEqual([
      { fieldPath: 'isPublished', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
    ]);
  });

  /**
   * The retention sweep's index (`FEAT-049`). `sweepPlayHistory` runs
   * `collectionGroup('plays').where('at','<',cutoff)`, and **Firestore's
   * automatic single-field indexes are collection-scoped only** — a
   * collection-group query over one field still needs its index declared. Get
   * this wrong and the sweep fails with `FAILED_PRECONDITION` on a schedule
   * nobody is watching, so the twelve months the Privacy Policy promises
   * quietly stops being enforced.
   *
   * The two collection-scoped entries come with it because a `fieldOverrides`
   * entry **replaces** automatic indexing for that field rather than adding to
   * it: declaring only the collection-group scope would take away the ordinary
   * `orderBy('at')` that `exportAccountData` uses.
   *
   * Asserted here rather than left to the deploy, because the emulator enforces
   * no index configuration at all — a missing one is green in every local suite.
   */
  it('declares the collection-group index the play-history sweep queries', () => {
    const override = spec.fieldOverrides.find(
      (entry) => entry.collectionGroup === 'plays' && entry.fieldPath === 'at',
    );

    expect(override, 'plays.at field override').toBeDefined();
    expect(override?.ttl).toBeUndefined();
    expect(override?.indexes).toEqual([
      { order: 'ASCENDING', queryScope: 'COLLECTION' },
      { order: 'DESCENDING', queryScope: 'COLLECTION' },
      { order: 'ASCENDING', queryScope: 'COLLECTION_GROUP' },
    ]);
  });

  /**
   * The report sweeps' queries (`FEAT-042`). The daily pass reads the reports
   * that still name somebody — `where('reportedBy','>','')`, ordered by
   * `reportedBy` then the document id, from a cursor — and `deleteAccount` and
   * `exportAccountData` read one account's with an equality on the same field.
   * Firestore's automatic single-field index on `reportedBy` serves all three,
   * so nothing needs declaring, and that is exactly why this pins that nothing
   * takes it away: a `fieldOverrides` entry *replaces* automatic indexing for
   * its field, and before these sweeps nothing queried this one, so exempting
   * it looked free. The emulator enforces no index configuration at all, so
   * every local suite would stay green while both sweeps failed in production
   * with `FAILED_PRECONDITION` — and reporters stayed named.
   */
  it('leaves question_reports.reportedBy to its automatic single-field index', () => {
    const override = spec.fieldOverrides.find(
      (entry) => entry.collectionGroup === 'question_reports' && entry.fieldPath === 'reportedBy',
    );

    expect(override).toBeUndefined();
  });
});
