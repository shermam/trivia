import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { gameResultRefusal } from './caller-gate';
import { applyGameResult } from './game-result';

/**
 * Banks one completed game into the caller's lifetime totals at
 * `users/{uid}`, the round itself into `users/{uid}/plays/{gameId}`, each
 * community question's outcome into that question's difficulty counters
 * (`FEAT-023`), and what the game earned into the player's XP (`FEAT-041`).
 *
 * **A callable rather than a client write, and that is the whole design.**
 * `firestore.rules` gives `users/{uid}` no client write path at all, which is
 * what keeps it free of an exact-key `hasOnly()` allowlist — and therefore
 * free of the A10 one-way door, so a feature adds a field — the avatar map,
 * `xp` — by changing a function and nothing else (`CLAUDE.md` §4.2). Its
 * fields still arrive one roadmap spec at a time, and freezing a key set would
 * put the wall on the collection least able to afford it.
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
   * The shared caller gate (`caller-gate.ts`), and this is where it is applied
   * — there is no client write rule for it to live in. Every account the app
   * signs in is banked, a password account whose address is not verified yet
   * included (`gameResultRefusal` says why); anonymous sessions and any
   * provider the app does not offer get no document.
   *
   * The refusal names its reason, because the client acts on the difference:
   * an anonymous session is refused on every game by design and says nothing,
   * while a signed-in account refused is the gap this gate once had — five of
   * the eight providers banked nothing, silently — and the client logs it and
   * tells the player on `/profile` (`AccountService.recordGameResult`).
   */
  const refusal = gameResultRefusal(request.auth?.token);
  if (refusal) {
    const line = `recordGameResult skipped for uid=${uid}: ${refusal.reason}, provider=${refusal.provider}`;
    // A guest is refused on every game they finish, so that line is routine;
    // a signed-in account refused is never supposed to happen.
    if (refusal.reason === 'anonymous') {
      logger.info(line);
    } else {
      logger.warn(line);
    }
    return refusal;
  }

  const firestore = getFirestore();
  const ref = firestore.collection('users').doc(uid);

  try {
    // A transaction, because the duplicate check, the two budgets and the
    // increments have to be atomic against each other. Two `/game-over`
    // reloads racing would otherwise both read "no such game id" and both bank
    // it — which is precisely the case the ring of recent game ids exists to
    // stop — and two calls racing at the 199th game of the day would both read
    // room for one more. The question counters are inside it for the same
    // reason: a game counted into a question by a call that was then refused
    // as a duplicate would be counted twice.
    const outcome = await firestore.runTransaction((tx) =>
      applyGameResult(
        tx,
        {
          user: ref,
          play: (gameId) => ref.collection('plays').doc(gameId),
          question: (questionId) => firestore.collection('custom_questions').doc(questionId),
        },
        request.data,
        Date.now(),
      ),
    );

    if (!outcome.accepted) {
      // Not an error to the caller. A duplicate is the ordinary consequence of
      // reloading `/game-over`, which the app supports on purpose; a rejection
      // that surfaced as a failure would make a supported action look broken.
      // The reason is the answer, because the client says something different
      // for each: nothing for a duplicate, and for `daily-limit` that the count
      // starts again at midnight UTC (`AccountService`, `/profile`).
      const line = `recordGameResult declined for uid=${uid}: ${outcome.reason}`;
      // The daily ceiling sits where no honest player arrives
      // (`daily-ceiling.ts`), so an account reaching it is worth seeing in the
      // logs rather than among the reloads.
      if (outcome.reason === 'daily-limit') {
        logger.warn(line);
      } else {
        logger.info(line);
      }
      return { recorded: false, reason: outcome.reason };
    }

    // The player's own XP after this game, and what the game added, so the
    // client can tell a level crossed by this game without reading the
    // document back — the caller's own numbers, and nobody else's.
    return { recorded: true, xp: outcome.xp.total, xpGained: outcome.xp.gained };
  } catch (error) {
    logger.error(`Failed to record game result for ${uid}`, error);
    throw new HttpsError('internal', 'Could not record this game.');
  }
});
