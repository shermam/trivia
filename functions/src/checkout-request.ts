import { isDemoProject } from './environment';

/**
 * Validation of the two fields a client is allowed to put in a checkout-,
 * donation- or portal-session document, plus the other decisions a session
 * handler makes that are worth testing on their own: which of the customer's
 * stale Checkout Sessions to clear out of the way, and what a refused buyer is
 * told.
 *
 * `firestore.rules` bounds the *shape* of both fields (see
 * `isValidCheckoutSession` there), but shape is all rules can do: they cannot
 * know which hostnames belong to this deployment, and they cannot look a price
 * ID up in a catalog. So every value that reaches Stripe is checked a second
 * time here, against things only the server knows. Rules keep the junk out;
 * this keeps the plausible-but-wrong out.
 *
 * Kept pure and dependency-free so each decision is unit-tested directly,
 * same as `role.ts` and `account-policy.ts`.
 */

/**
 * A request this app refused, as opposed to a Stripe or Firestore failure.
 *
 * Its own message names the offending value, which is what a log wants and
 * exactly what should not reach the UI — telling a probing caller *which* of
 * their fields was rejected is free reconnaissance. `clientMessageFor` is the
 * only thing that decides what a user sees.
 */
export class RejectedRequestError extends Error {}

/**
 * What to write back onto the session document for the client to display.
 *
 * A refusal collapses to `refusalMessage`, which should say what to do rather
 * than what went wrong: the three ways to get here (a price that isn't ours,
 * an origin that isn't ours, a client still sending the old payload) are not
 * distinguishable to the person reading it and are not separately actionable.
 * A genuine backend failure keeps its own message — "No Stripe customer found
 * for this account yet." is worth more to a user than any generic — except
 * where Stripe's own wording is a worse answer than one this code can verify,
 * which so far is the currency conflict below.
 */
export function clientMessageFor(
  error: unknown,
  refusalMessage: string,
  purchase: PurchaseKind = 'pro',
): string {
  if (error instanceof RejectedRequestError) {
    return refusalMessage;
  }
  return (
    currencyConflictMessage(error, purchase) ??
    (error instanceof Error ? error.message : refusalMessage)
  );
}

/**
 * Which of the two things this Stripe account sells a message is about.
 *
 * Only the currency conflict needs to know: the sentence has to name what
 * cannot be bought in the other currency, and "Pro can only be bought in USD"
 * is simply false when the reader was trying to tip. Everything else here is
 * about the *request*, which is the same shape for both.
 */
export type PurchaseKind = 'pro' | 'donation';

/**
 * How each purchase names itself in the currency-conflict sentence — the
 * clause after "so".
 */
const CURRENCY_CONFLICT_CLAUSE: Record<PurchaseKind, (currency: string) => string> = {
  pro: (currency) => `Pro can only be bought in ${currency} from this account`,
  donation: (currency) => `a donation can only be made in ${currency} from this account`,
};

const CURRENCY_CONFLICT_CLAUSE_UNKNOWN: Record<PurchaseKind, string> = {
  pro: 'Pro can only be bought in that currency from this account',
  donation: 'a donation can only be made in that currency from this account',
};

/**
 * Stripe's refusal to mix currencies on one customer, rewritten as something
 * the person who clicked Subscribe — or Donate — can act on, or `null` when the
 * failure is anything else.
 *
 * A Stripe customer is billed in **one currency**, and the first thing that
 * commits them to it wins: a live subscription, an invoice item, a completed
 * payment — or merely an *open* subscription-mode Checkout Session, which
 * holds the currency for as long as it lives. That last one is an abandoned
 * attempt rather than a real commitment, which is why `createCheckoutSession`
 * expires those before it creates anything (`stack.md` §2.4). A refusal that
 * survives the expiry is therefore the real thing: this customer has actually
 * transacted in that currency and cannot be moved off it, so the honest
 * instruction is to buy in it.
 *
 * Stripe states that as a list of everything it might be — "You cannot
 * combine currencies on a single customer. This customer has an active
 * subscription, subscription schedule, discount, quote, invoice item or
 * active subscription mode checkout session with currency usd." — which is
 * accurate, unactionable, and otherwise shown verbatim to the buyer.
 *
 * Two things about *how* it is recognised, both of them §4.4 ("never narrate
 * a cause you did not verify") rather than style:
 *
 * - **Matched on the message, because there is no code to match on.** Stripe
 *   returns this as a plain `invalid_request_error` carrying no documented
 *   `code`, so the sentence is the only handle. That makes the match the part
 *   that can rot — and it rots safely: a reworded message stops matching, and
 *   the caller falls back to Stripe's own text rather than to a confident
 *   wrong story.
 * - **The currency is read out of that same sentence**, which is Stripe's own
 *   statement about this customer, made by the request that just refused —
 *   not from a second `customers.retrieve`, which is another round trip,
 *   another way to fail, and an answer to a question asked a moment later. If
 *   the phrase matches but no code can be read from it, the message says "a
 *   different currency" and names none: that the currencies differ is
 *   established by the refusal itself, which one is not.
 */
export function currencyConflictMessage(
  error: unknown,
  purchase: PurchaseKind = 'pro',
): string | null {
  const message = error instanceof Error ? error.message : '';
  if (!/cannot combine currencies/i.test(message)) {
    return null;
  }
  const currency = /\bwith currency ([a-z]{3})\b/i.exec(message)?.[1];
  if (!currency) {
    return (
      'Your account is already set up to pay in a different currency, so ' +
      `${CURRENCY_CONFLICT_CLAUSE_UNKNOWN[purchase]}.`
    );
  }
  const code = currency.toUpperCase();
  return `Your account is already set up to pay in ${code}, so ${CURRENCY_CONFLICT_CLAUSE[purchase](code)}.`;
}

const MAX_ORIGIN_LENGTH = 200;

/** Stripe price IDs are `price_` followed by an opaque alphanumeric handle. */
const PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]{1,100}$/;

/** `http://localhost:4200`, `http://127.0.0.1:5000`, with or without a port. */
const LOCAL_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

const PREVIEW_CHANNEL_PATTERN = /^[a-z0-9-]+$/;

/**
 * Origins this app is served from that cannot be derived from the project ID.
 *
 * Every Firebase project gets `{project}.web.app` and `.firebaseapp.com` for
 * free, and a preview channel is a predictable variation on the first — but a
 * custom domain is an arbitrary name attached in the Firebase console, and
 * nothing available to the runtime can enumerate them. So this is the one part
 * of the allowlist that is a constant, and therefore the one part that can go
 * stale.
 *
 * **Attaching a custom domain in the Firebase console means adding it here in
 * the same change.** Checkout is refused on any origin not on this list, so the
 * symptom of forgetting is narrow and easy to miss: the new domain quietly
 * sells nothing while every other one keeps working. Each refusal is logged
 * with the offending origin, which is the string to search for if it happens.
 *
 * `www` is listed alongside the apex whether or not Hosting currently serves
 * it. Both names belong to whoever owns the domain, so listing one that isn't
 * wired up costs nothing, while omitting one that is breaks checkout for
 * whoever lands on it.
 */
const CUSTOM_APP_ORIGINS = ['https://trivimind.com', 'https://www.trivimind.com'];

export function isPriceIdShaped(price: unknown): price is string {
  return typeof price === 'string' && PRICE_ID_PATTERN.test(price);
}

/**
 * Whether this origin is one of ours, and therefore somewhere Stripe may be
 * told to send the user back to.
 *
 * This is the field that actually matters: `success_url` used to be passed
 * through verbatim, so anyone who could write a session document could have
 * Stripe bounce the user to a host they controlled, arriving from a genuine
 * Stripe redirect with a real session ID in hand. The URL is now built by the
 * function from a bare origin, and the origin has to be on this list.
 *
 * The list is derived from the project ID rather than configured, so a new
 * deployment can't be one stale constant away from rejecting its own checkout:
 *
 * - `https://{project}.web.app` / `.firebaseapp.com` — the two hostnames
 *   Firebase Hosting serves every project on.
 * - `https://{project}--{channel}.web.app` — preview channels (§4.2a). Note
 *   Hosting truncates the project ID in that hostname if the whole thing would
 *   exceed the 63-character DNS label limit; `intellectura-3b26a` is short
 *   enough that it doesn't, but a longer project ID would need this widened.
 * - `CUSTOM_APP_ORIGINS` — the custom domain, which is the one entry that
 *   can't be derived and has to be maintained by hand. Not offered to a demo
 *   project, which by definition has no domain attached.
 * - localhost, **only** on a demo project — the emulator, where there is no
 *   real Stripe to redirect to in the first place.
 */
export function isAllowedRedirectOrigin(origin: unknown, projectId: string | undefined): boolean {
  if (typeof origin !== 'string' || origin.length > MAX_ORIGIN_LENGTH || !projectId) {
    return false;
  }
  if (
    origin === `https://${projectId}.web.app` ||
    origin === `https://${projectId}.firebaseapp.com`
  ) {
    return true;
  }
  if (isPreviewChannelOrigin(origin, projectId)) {
    return true;
  }
  if (isDemoProject(projectId)) {
    return LOCAL_ORIGIN_PATTERN.test(origin);
  }
  return CUSTOM_APP_ORIGINS.includes(origin);
}

function isPreviewChannelOrigin(origin: string, projectId: string): boolean {
  const prefix = `https://${projectId}--`;
  const suffix = '.web.app';
  if (!origin.startsWith(prefix) || !origin.endsWith(suffix)) {
    return false;
  }
  // Matched by slicing rather than by interpolating the project ID into a
  // regular expression — the project ID is data, and data does not belong in
  // a pattern.
  const channel = origin.slice(prefix.length, origin.length - suffix.length);
  return channel.length > 0 && PREVIEW_CHANNEL_PATTERN.test(channel);
}

/**
 * Whether a mirrored catalog entry is something this app actually sells.
 *
 * The catalog (`products`/`prices`) is written only by `stripeWebhook` via the
 * Admin SDK and is unwritable by any client, so it is a trustworthy answer to
 * "is this price real" — which is the question `firestore.rules` structurally
 * cannot ask. An archived price, or a price belonging to some other product in
 * the same Stripe account, is rejected here even though its ID is perfectly
 * well-formed.
 */
export function isSellableProPrice(
  product: Record<string, unknown> | undefined,
  price: Record<string, unknown> | undefined,
): boolean {
  return (
    product?.['active'] === true &&
    product?.['role'] === 'pro' &&
    product?.['kind'] !== DONATION_KIND &&
    price?.['active'] === true
  );
}

/**
 * The metadata value that marks a Stripe Product — and each of its Prices — as
 * something this app takes as a one-time donation.
 *
 * A convention rather than a Stripe concept: Stripe has no notion of "this
 * product is a tip jar", so the catalog says so in metadata and the mirror
 * copies it into `products/{id}.kind` and `products/{id}/prices/{id}.kind`
 * (`functions/src/products.ts`). The Dashboard steps that create it are in
 * `docs/stack.md` §2.4.
 */
export const DONATION_KIND = 'donation';

/**
 * Whether a mirrored catalog entry is something this app accepts as a
 * donation — the same catalog lookup `isSellableProPrice` performs, for the
 * other thing this Stripe account sells.
 *
 * **The two predicates are mutually exclusive by construction, and that is
 * checked rather than assumed.** A donation price reaching the Pro path would
 * be a one-off payment granting a subscription's claim; a Pro price reaching
 * the donation path would charge a recurring price as a one-off. Neither is a
 * hypothetical the Dashboard prevents — `firebaseRole` and `kind` are two free
 * text fields on the same object — so each predicate refuses the other's
 * marker outright, and `checkout-request.test.ts` pins both directions.
 *
 * `type` is checked on the price as well. Stripe would refuse a recurring
 * price in `mode: 'payment'` itself, but the refusal arrives as an opaque
 * Stripe error on the buyer's click; naming it here keeps the catalog's own
 * mistakes out of the checkout path.
 */
export function isSellableDonationPrice(
  product: Record<string, unknown> | undefined,
  price: Record<string, unknown> | undefined,
): boolean {
  return (
    product?.['active'] === true &&
    product?.['kind'] === DONATION_KIND &&
    product?.['role'] !== 'pro' &&
    price?.['active'] === true &&
    price?.['kind'] === DONATION_KIND &&
    price?.['type'] === 'one_time'
  );
}

/**
 * Which of the customer's Checkout Sessions to expire before a new one is
 * created, given the sessions Stripe listed.
 *
 * **Every open one, not only the ones in another currency.** Two reasons, and
 * the second is what makes this more than housekeeping:
 *
 * - A click on Subscribe is a request for a *fresh* session. Anything still
 *   open belongs to an attempt already abandoned — a card declined twice, a
 *   tab closed — and nobody is going back to it; Stripe would expire it
 *   itself, up to 24 hours later.
 * - Deciding "another currency" needs a currency to compare against, and a
 *   listed session's own `currency` is not that value: it is unset until
 *   Checkout has settled on one, and Adaptive Pricing can present a session
 *   in a currency that is not its price's. Filtering on it would be a guess,
 *   and a guess that spares one session spares the currency pin with it —
 *   a single open session is enough to block the customer, so a partial
 *   clear is no clear at all.
 *
 * `status` is checked here as well as passed to `list`, because `expire`
 * accepts only an open session and errors on anything else. The caller's
 * query parameter is a request; this function's contract should not rest on
 * the remote end having honoured it.
 */
export function openCheckoutSessionIdsToExpire(
  sessions: readonly { id?: unknown; status?: unknown }[],
): string[] {
  return sessions
    .filter((session) => session.status === 'open')
    .map((session) => session.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}
