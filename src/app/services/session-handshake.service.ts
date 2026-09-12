import { Injectable, inject } from '@angular/core';
import { pollUntil } from '../utils/poll-until.util';
import {
  FirestoreRestClient,
  isFirestorePermissionDenied,
} from './firestore-rest/firestore-rest.client';

/**
 * The write-then-poll handshake every Stripe session in this app is started
 * by: the client creates a document under `customers/{uid}`, a Cloud Function
 * answers it with a `url` (or an `error`), and the browser is sent there.
 *
 * Three flows use it — Pro checkout, the billing portal and a donation — and
 * they share one implementation rather than three that can drift, because
 * every property worth having here is a property of the *protocol* rather than
 * of what is being bought: the document ID carries the volume cap, a failed
 * read is a not-yet rather than a failure, and the deadline is a budget spent
 * across the whole poll rather than granted afresh to each read.
 */

/** How long the whole handshake may take, and how long any one read inside it may. */
const SESSION_TIMEOUT_MS = 20_000;

/**
 * How often to re-read a session document while waiting for the Cloud Function
 * to write its URL back.
 *
 * This replaces an `onSnapshot` listener, because REST has no equivalent
 * (`FIRESTORE_SDK_VS_REST.md` §4). The trade is arithmetic: a checkout costs up
 * to 40 reads instead of about 2. That is irrelevant at any volume this app
 * will see — checkout is rare by definition, and a listener was never free
 * either, billing the initial read plus every change delivered for as long as
 * the tab stayed open.
 *
 * 500 ms rather than the 1 s the design document sketched, because this delay
 * is in front of a user who has just clicked and is looking at a spinner.
 */
const SESSION_POLL_INTERVAL_MS = 500;

/**
 * `firestore.rules` caps how many session documents one account can create —
 * and therefore how many Cloud Function invocations and Stripe API calls it
 * can trigger — by constraining the document ID to `{window}-{slot}`, where
 * the window is derived from *server* time and `create` (unlike a general
 * write) only ever applies to an ID that doesn't exist yet. Rules cannot count
 * a user's documents, so the ID is the only place the cap can live; these two
 * constants have to match `sessionWindow`/`isRateLimitedSessionId` there.
 *
 * The cap is counted **per subcollection**, so donations and Pro checkouts get
 * ten each and neither can spend the other's.
 */
export const SESSION_WINDOW_MS = 300_000;
const SESSION_SLOTS_PER_WINDOW = 10;

const CUSTOMERS_COLLECTION = 'customers';

/** The subcollections a client may start a handshake in. */
export type SessionCollection = 'checkout_sessions' | 'donation_sessions' | 'portal_sessions';

/** What the Cloud Function eventually writes back onto a session document. */
interface SessionOutcome {
  url?: string;
  error?: string;
}

/**
 * A failure this app can explain, with a message written for the person at the
 * screen.
 *
 * Every rejection of a checkout, a donation or the billing portal is one of
 * two kinds, and the type is how a component tells them apart. This one
 * carries a verified cause — the caller is signed out, nothing is on sale, the
 * volume cap in `firestore.rules` is spent, the Cloud Function wrote an error
 * back (its own client-facing message; see `clientMessageFor` in
 * `functions/src/checkout-request.ts`), or the handshake reached its deadline
 * with nothing written — and its message is the thing to show. Anything else
 * that escapes is a transport failure (`FirestoreRestError`: a dropped
 * connection, a refused read, a 500) whose cause nobody verified, so a
 * component keeps its generic message for it (`subscriptionFailureMessage`).
 *
 * The distinction matters most to whoever is standing up a new environment: an
 * empty catalog and a function that never ran both end in a red line under the
 * button, and "please try again" is the wrong instruction for either. Naming
 * the cause is what makes the difference visible from the screen instead of
 * from the function logs.
 */
export class SubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

/**
 * What a component shows for a rejected checkout, donation or billing-portal
 * request: the `SubscriptionError`'s own message, or `fallback` for a failure
 * nothing could explain.
 *
 * The client half of `clientMessageFor` (`functions/src/checkout-request.ts`),
 * applying the same rule from the other side: distinguish the cases or stay
 * generic (`CLAUDE.md` §4.4). An unexplained error is logged rather than
 * dropped — once the screen says "please try again", the console is the only
 * place its real cause survives.
 */
export function subscriptionFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof SubscriptionError) {
    return error.message;
  }
  console.error('[subscription] unexplained failure', error);
  return fallback;
}

@Injectable({ providedIn: 'root' })
export class SessionHandshakeService {
  private readonly rest = inject(FirestoreRestClient);

  /**
   * Writes a session document, waits for the Cloud Function to write a `url`
   * (or an `error`) back onto it, and returns that URL.
   *
   * The deadline used to be the delicate part. With `onSnapshot` it had to live
   * *inside* the promise rather than racing it from outside, because giving up
   * had to also mean detaching the listener — racing left the subscription
   * attached for the rest of the session, still receiving writes and still
   * billed for them, for a checkout nobody was waiting on. Polling has nothing
   * to detach: when `pollUntil` returns, the last request has already completed
   * and no timer is armed. That whole class of bug is gone by construction
   * rather than by care.
   */
  async run(
    uid: string,
    options: {
      collectionName: SessionCollection;
      payload: Record<string, string>;
      timeoutMessage: string;
      failureMessage: string;
    },
  ): Promise<string> {
    const sessionPath = await this.createSessionDoc(uid, options.collectionName, options.payload);

    // A read that fails is a not-yet, not a failure. The document is about to
    // be written and there is budget left to ask again, and `onSnapshot`
    // reconnected through a transient drop by itself — turning the payment
    // path into one-strike would be a regression the migration has no reason
    // to cause. The last error is kept rather than swallowed, so a deadline
    // reached while reads were failing reports *that* instead of narrating a
    // timeout it did not verify (`CLAUDE.md` §4.4); a read that succeeds
    // clears it, so only an unresolved failure is ever reported.
    let lastReadError: Error | null = null;
    const outcome = await pollUntil(
      async (remainingMs) => {
        try {
          const result = await this.readSessionOutcome(
            sessionPath,
            options.failureMessage,
            remainingMs,
          );
          lastReadError = null;
          return result;
        } catch (error) {
          lastReadError = error instanceof Error ? error : new Error(String(error));
          return null;
        }
      },
      { intervalMs: SESSION_POLL_INTERVAL_MS, timeoutMs: SESSION_TIMEOUT_MS },
    );

    if (!outcome) {
      // A deadline reached while the reads were answering (the document was
      // there, with no URL yet) is a cause this code verified, so it is named.
      // A deadline reached on a failing read is not: that error is handed on
      // as the transport's own type, and the component stays generic for it.
      throw lastReadError ?? new SubscriptionError(options.timeoutMessage);
    }
    if (outcome.error) {
      // Written by the function for exactly this purpose (`clientMessageFor`).
      throw new SubscriptionError(outcome.error);
    }
    return outcome.url!;
  }

  /**
   * One look at a session document: the URL if it has arrived, the failure if
   * the function reported one, and `null` for "still working" — which is both
   * the document not existing yet and it existing with neither field set.
   */
  private async readSessionOutcome(
    sessionPath: string,
    failureMessage: string,
    remainingMs: number,
  ): Promise<SessionOutcome | null> {
    // The budget left, not the whole budget. Giving each read the full
    // `SESSION_TIMEOUT_MS` composes two 20-second bounds into forty seconds of
    // wall clock, because an attempt that starts at 19.5s is still allowed its
    // own twenty — and the constant, the comments and the user-facing message
    // all say twenty.
    const document = await this.rest.getDocument(sessionPath, {
      timeoutMs: remainingMs,
    });
    const data = document?.data;
    if (!data) {
      return null;
    }
    const error = data['error'] as { message?: string } | undefined;
    if (error) {
      return { error: error.message ?? failureMessage };
    }
    return typeof data['url'] === 'string' ? { url: data['url'] } : null;
  }

  /**
   * Writes the session document at an ID the volume cap in `firestore.rules`
   * accepts: `{current 5-minute window}-{slot}`, and returns its path.
   *
   * Slots are tried from a random starting point, so two sessions inside the
   * same window don't both collide on slot 0 — a rejected slot is one that has
   * already been used this window, which for a real user only happens if they
   * genuinely started twice in five minutes. Running out of all ten is the cap
   * actually biting.
   *
   * The message deliberately doesn't name a cause. A refusal here has two
   * plausible ones — every slot used, or a client old enough to still be
   * sending a payload the rules no longer accept — and picking one to narrate
   * would be wrong half the time. Reloading and retrying is the answer to both.
   */
  private async createSessionDoc(
    uid: string,
    collectionName: SessionCollection,
    payload: Record<string, string>,
  ): Promise<string> {
    const currentWindow = Math.floor(Date.now() / SESSION_WINDOW_MS);
    const firstSlot = Math.floor(Math.random() * SESSION_SLOTS_PER_WINDOW);

    for (let attempt = 0; attempt < SESSION_SLOTS_PER_WINDOW; attempt++) {
      const slot = (firstSlot + attempt) % SESSION_SLOTS_PER_WINDOW;
      const sessionPath = `${CUSTOMERS_COLLECTION}/${uid}/${collectionName}/${currentWindow}-${slot}`;
      try {
        await this.rest.setDocument(sessionPath, payload, { timeoutMs: SESSION_TIMEOUT_MS });
        return sessionPath;
      } catch (error) {
        if (!isFirestorePermissionDenied(error)) {
          throw error;
        }
      }
    }

    throw new SubscriptionError(
      'Too many attempts just now. Reload the page and try again in a few minutes.',
    );
  }
}
