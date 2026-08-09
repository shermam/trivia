/**
 * When a Stripe session document stops being worth keeping.
 *
 * `customers/{uid}/checkout_sessions` and `customers/{uid}/portal_sessions`
 * are pure handshake scratch space: the client creates a document, this
 * backend writes a URL back onto it, the browser redirects, and nothing ever
 * reads it again. Nothing deleted them, so they accumulated for the life of
 * the project — one per checkout attempt, forever (finding C2).
 *
 * A Firestore **TTL policy** does the deleting, driven by the `expiresAt`
 * field this computes. The policy itself is declared in
 * `firestore.indexes.json` (`fieldOverrides` with `ttl: true`) and ships
 * through the same `firebase deploy --only firestore:indexes` step as every
 * index, so it is version-controlled rather than a console setting somebody
 * has to remember.
 */

/**
 * How long a session document survives after it is created.
 *
 * Matched to Stripe's own Checkout Session expiry (24 hours) rather than
 * chosen freely. The handshake it exists for finishes in seconds, so almost
 * any value works for the happy path; what a longer window buys is a readable
 * record while the session it describes is still live on Stripe's side, which
 * is exactly when someone would be looking at it to debug a failed payment.
 * Shortening it below Stripe's own expiry would delete the document while the
 * thing it points at still exists.
 */
export const SESSION_DOC_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The instant a session document created at `createdAt` becomes eligible for
 * deletion.
 *
 * Firestore deletes on a best-effort sweep rather than at the stroke of the
 * timestamp — typically within 24 hours of expiry — so a document's real
 * lifetime is this window *plus* the sweep delay. That is fine for scratch
 * space and worth stating, because it means this value is a floor on how long
 * data is retained, never a promise about when it is gone.
 */
export function sessionExpiryAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + SESSION_DOC_TTL_MS);
}
