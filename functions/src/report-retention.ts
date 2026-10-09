/**
 * How long a report keeps the identity of the account that filed it
 * (`FEAT-042`): thirty days from its `createdAt`, after which the daily pass
 * copies it without `reportedBy` and deletes the original
 * (`report-anonymisation.ts`). Long enough for a reviewer to follow a fresh
 * report up — to tell one account reporting everything from many players
 * reporting one question — and short enough to be a number the Privacy Policy
 * can state.
 *
 * **The policy's number is this constant.** `legal-pages.spec.ts` imports it
 * and requires the Privacy Policy and the Terms to state it, so changing the
 * period here fails the app's unit suite until both documents say the new one
 * (`CLAUDE.md` §4.0). That is also why this module is free of every import:
 * the app's test build reaches it across the package boundary, and must not
 * pull `firebase-admin` in with it.
 */
export const REPORTER_RETENTION_DAYS = 30;

export const REPORTER_RETENTION_MS = REPORTER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
