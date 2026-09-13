/**
 * What a completed Stripe Checkout Session means for the donation record —
 * the billing decision this feature turns on, kept pure so it is unit-tested
 * directly rather than inferred from an integration run (`CLAUDE.md` §4.6,
 * same convention as `role.ts` and `account-policy.ts`).
 *
 * `checkout.session.completed` is emitted for **every** Checkout Session this
 * account completes, subscription and payment alike, so the routing map cannot
 * tell a donation from a Pro subscription starting — only the object can. Four
 * things have to hold before anything is written, and each one has a way of
 * being false in production rather than only in a test:
 *
 * - **`mode: 'payment'`** — a subscription completing is somebody buying Pro,
 *   which `subscriptions.ts` already mirrors from its own events.
 * - **The payment actually went through.** Stripe completes the session as soon
 *   as the buyer finishes the form, and for a delayed method (boleto and Pix
 *   are the ones that matter for a Brazilian account) `payment_status` is still
 *   `unpaid` at that point; the money arrives later, with
 *   `checkout.session.async_payment_succeeded`. Recording on completion alone
 *   would credit a donation nobody has paid.
 * - **A `firebaseUID` in the session's metadata.** A signed-out visitor may
 *   donate — that is deliberate, it is the lowest-friction path — but the
 *   session then carries no account to attribute it to, and the Privacy Policy
 *   says outright that a guest donation stores nothing in our database. No uid
 *   means no record, not a record under a guessed one.
 * - **An amount and a currency**, because a record of a donation that does not
 *   say how much is not worth writing.
 */

/** The fields of a `Stripe.Checkout.Session` this decision reads. */
export interface CompletedCheckoutSession {
  id?: unknown;
  mode?: unknown;
  payment_status?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  created?: unknown;
  metadata?: Record<string, unknown> | null;
}

/** One donation, as `customers/{uid}/donations/{sessionId}` records it. */
export interface DonationRecord {
  /** The Firebase account it belongs to, from the session's own metadata. */
  readonly uid: string;
  /** The Stripe Checkout Session id, which is also the document id. */
  readonly sessionId: string;
  /** The smallest unit of the currency — 500 for R$ 5,00 — exactly as Stripe reports it. */
  readonly amount: number;
  /** Lowercase ISO 4217, as Stripe stores it. */
  readonly currency: string;
  /**
   * When Stripe created the session, in epoch **seconds** — the unit Stripe
   * reports and the one `event-order.ts` already keeps its high-water mark in.
   *
   * `null` where the session carries no usable `created`, so the caller can
   * substitute the event's own timestamp rather than this inventing one. A
   * silent `new Date(0)` here would file every such donation under 1970, which
   * looks like data rather than like a missing field.
   */
  readonly createdAtSeconds: number | null;
}

/**
 * Payment statuses that mean the money is in.
 *
 * `no_payment_required` is included because Stripe uses it for a zero-amount
 * session; the amount check below is what actually keeps such a session from
 * being recorded as a donation, and treating the status itself as a failure
 * would be narrating a cause that is not the real one.
 */
const PAID_STATUSES = new Set(['paid', 'no_payment_required']);

export function donationRecordFrom(session: CompletedCheckoutSession): DonationRecord | null {
  if (session.mode !== 'payment') {
    return null;
  }
  if (typeof session.payment_status !== 'string' || !PAID_STATUSES.has(session.payment_status)) {
    return null;
  }
  const sessionId = session.id;
  const uid = session.metadata?.['firebaseUID'];
  if (typeof sessionId !== 'string' || !sessionId || typeof uid !== 'string' || !uid) {
    return null;
  }
  const amount = session.amount_total;
  const currency = session.currency;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  if (typeof currency !== 'string' || !currency) {
    return null;
  }
  return {
    uid,
    sessionId,
    amount,
    currency: currency.toLowerCase(),
    createdAtSeconds:
      typeof session.created === 'number' && Number.isFinite(session.created)
        ? session.created
        : null,
  };
}
