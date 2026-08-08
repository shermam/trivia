import { isDemoProject } from './environment';

/**
 * Validation of the two fields a client is allowed to put in a checkout- or
 * portal-session document.
 *
 * `firestore.rules` bounds the *shape* of both (see `isValidCheckoutSession`
 * there), but shape is all rules can do: they cannot know which hostnames
 * belong to this deployment, and they cannot look a price ID up in a catalog.
 * So every value that reaches Stripe is checked a second time here, against
 * things only the server knows. Rules keep the junk out; this keeps the
 * plausible-but-wrong out.
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
 * for this account yet." is worth more to a user than any generic.
 */
export function clientMessageFor(error: unknown, refusalMessage: string): string {
  if (error instanceof RejectedRequestError) {
    return refusalMessage;
  }
  return error instanceof Error ? error.message : refusalMessage;
}

const MAX_ORIGIN_LENGTH = 200;

/** Stripe price IDs are `price_` followed by an opaque alphanumeric handle. */
const PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]{1,100}$/;

/** `http://localhost:4200`, `http://127.0.0.1:5000`, with or without a port. */
const LOCAL_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

const PREVIEW_CHANNEL_PATTERN = /^[a-z0-9-]+$/;

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
  return isDemoProject(projectId) && LOCAL_ORIGIN_PATTERN.test(origin);
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
  return product?.['active'] === true && product?.['role'] === 'pro' && price?.['active'] === true;
}
