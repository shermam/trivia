/**
 * The shape of the daily report pass's query (`FEAT-042`), and nothing else.
 *
 * **A module of its own, with no imports, because two suites read it.**
 * `report-anonymisation.ts` builds the query from these constants, and
 * `firestore-tests/indexes.spec.ts` derives from them the composite index the
 * query needs and fails unless `firestore.indexes.json` declares exactly that
 * one. The emulator answers the query with or without the index, so a query and
 * an index that had drifted apart would be green in every local suite and fail
 * only in production — as a sweep that never runs, and reporters who stay named
 * past the thirty days the Privacy Policy promises. Deriving the index from the
 * query, rather than restating it in the test, is what makes the check about
 * the query the sweep actually sends (`src/app/models/contributions-query.ts`
 * does the same for the contributions index).
 */

export const QUESTION_REPORTS_COLLECTION = 'question_reports';

/** When a report was filed: the field the daily range runs over. */
export const REPORT_FILED_AT_FIELD = 'createdAt';

/** Who filed it: present on every report as filed, absent from every anonymised copy. */
export const REPORT_REPORTER_FIELD = 'reportedBy';

/**
 * The daily pass's ordering, every field ascending.
 *
 * **The range's field first**, because Firestore requires a range filter's
 * field to be the first ordering. **Then the reporter, which is what leaves the
 * copies out**: an ordering on a field also filters for that field's existence,
 * and an anonymised copy has no `reportedBy`. So the pass reads only reports
 * that still name somebody, however many copies sit in the same range — and
 * each page it anonymises leaves the result set, which is why it can re-query
 * from the start rather than carry a cursor.
 *
 * This is the ordering that needs the `(createdAt ASC, reportedBy ASC)`
 * composite index. Firestore appends the `__name__` tiebreaker itself, and the
 * index file does not, and must not, name it (`indexes.spec.ts` says why).
 */
export const EXPIRED_REPORTS_ORDER = [REPORT_FILED_AT_FIELD, REPORT_REPORTER_FIELD] as const;
