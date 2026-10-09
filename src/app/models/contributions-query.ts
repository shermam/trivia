/**
 * The one query that reads an account's contributions to the shared bank:
 * an equality on the author, newest first, with the document id breaking ties.
 * Two screens send it — an author's own `/my-questions` (`FEAT-007`) and a
 * reviewer's view of everything one account contributed (`FEAT-006`) — at
 * different page sizes, and nothing else about the query differs between them.
 *
 * **A module of its own, with nothing Angular in it, because two suites read
 * it.** `FirebaseService` builds both author queries from it, and
 * `firestore-tests/indexes.spec.ts` derives from it the composite index the
 * query needs and fails unless `firestore.indexes.json` declares exactly that
 * one. The emulator answers the query with or without the index, so a query
 * and an index that had drifted apart would be green in every local suite and
 * fail only in production, as a screen that never loads (D3). Deriving the
 * index from the query, rather than restating it in the test, is what makes the
 * check about the query the app actually sends.
 *
 * The ordering is what needs the `(createdBy ASC, createdAt DESC)` composite.
 * Firestore appends the `__name__` tiebreaker in the direction of the last
 * declared field, so the tiebreaker here is descending too — and the index file
 * does not, and must not, name it (`indexes.spec.ts` says why).
 */
export const CONTRIBUTIONS_COLLECTION = 'custom_questions';

/**
 * The field the query filters on. **Rules are not filters**: it is this
 * equality that lets Firestore prove the author's branch of the read rule for
 * an author reading their own; a reviewer's read is admitted by the reviewer
 * branch whatever the filter, and sends it to name whose contributions it wants.
 */
export const CONTRIBUTIONS_AUTHOR_FIELD = 'createdBy';

/**
 * Newest first, the document id breaking ties — `'__name__'` is Firestore's
 * name for the document-id pseudo-field, written out here because the REST
 * client's constant lives beside Angular and this module may not import it.
 *
 * The tiebreaker is not decoration: two questions submitted in the same
 * millisecond put one of them at a page boundary and its twin immediately
 * after the cursor value, where an exclusive `startAfter` on `createdAt` alone
 * steps straight over it (measured on `question_reports`).
 */
export const CONTRIBUTIONS_ORDER = [
  { field: 'createdAt', direction: 'DESCENDING' },
  { field: '__name__', direction: 'DESCENDING' },
] as const;
