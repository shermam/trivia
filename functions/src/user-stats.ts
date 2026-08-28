import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { type UserStats, nextUserStats } from './game-stats';

/**
 * Banks one completed game into the caller's lifetime totals at
 * `users/{uid}`.
 *
 * **A callable rather than a client write, and that is the whole design.**
 * `firestore.rules` gives `users/{uid}` no client write path at all, which is
 * what keeps it free of an exact-key `hasOnly()` allowlist — and therefore
 * free of the A10 one-way door, so a future feature can add `xp`, `region` or
 * an avatar map by changing this function and nothing else (`CLAUDE.md` §4.2).
 * Five roadmap specs want fields here and none of their field sets agree yet;
 * freezing a key set now would be the wall on the collection least able to
 * afford it.
 *
 * The uid comes from the verified token and is never read from the payload —
 * the same authorisation boundary as `deleteAccount` and `exportAccountData`.
 * The *numbers*, though, are client-supplied and are bounded rather than
 * attested (see `isValidSubmission`). That is audit decision A1 taken
 * deliberately: this does not make the totals true, it makes them cheap to
 * bound. Reopening it means building the signed game token A1 deferred.
 */
export const recordGameResult = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign in before recording a game.');
  }

  /**
   * Anonymous sessions get no document, and this is where that is enforced —
   * there is no client write rule for the gate to live in.
   *
   * Not tidiness: `deleteAccount` never runs for an anonymous account, and
   * Firebase's auto-deletion of dormant anonymous accounts removes the Auth
   * record only. A document per guest would therefore accumulate with nothing
   * able to delete it, and the Privacy Policy's claim that nothing is attached
   * to an anonymous session would stop being true on the first page load after
   * deploy.
   *
   * Read from the token rather than from `request.auth.token.firebase`
   * defensively — the shape is documented, but a missing provider must fail
   * closed rather than admit the caller.
   */
  const provider = request.auth?.token?.firebase?.sign_in_provider;
  if (provider !== 'password' && provider !== 'google.com' && provider !== 'facebook.com') {
    // An allowlist rather than `!== 'anonymous'`: a provider this deployment
    // has never enabled should not silently start creating documents the day
    // somebody turns it on in the console.
    logger.info(`recordGameResult skipped for uid=${uid}: provider=${provider}`);
    return { recorded: false, reason: 'unsupported-provider' };
  }

  const firestore = getFirestore();
  const ref = firestore.collection('users').doc(uid);

  try {
    // A transaction, because the duplicate check and the increments have to be
    // atomic against each other. Two `/game-over` reloads racing would
    // otherwise both read "no such game id" and both bank it — which is
    // precisely the case `lastGameId` exists to stop.
    const outcome = await firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const current = snapshot.exists ? (snapshot.data() as UserStats) : null;

      const decision = nextUserStats(current, request.data, Date.now());
      if (!decision.accepted) {
        return decision;
      }

      tx.set(ref, decision.stats);
      return decision;
    });

    if (!outcome.accepted) {
      // Not an error to the caller. A duplicate is the ordinary consequence of
      // reloading `/game-over`, which the app supports on purpose; a rejection
      // that surfaced as a failure would make a supported action look broken.
      logger.info(`recordGameResult declined for uid=${uid}: ${outcome.reason}`);
      return { recorded: false, reason: outcome.reason };
    }

    return { recorded: true };
  } catch (error) {
    logger.error(`Failed to record game result for ${uid}`, error);
    throw new HttpsError('internal', 'Could not record this game.');
  }
});
