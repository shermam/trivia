import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { type AvatarRefusal, applyAvatarChoice, decideAvatarChoice } from './avatar-choice';

/**
 * Stores the caller's avatar choice on `users/{uid}` (`FEAT-038`).
 *
 * **A callable rather than a client write, for the reason `recordGameResult`
 * is one:** `users/{uid}` has no client write path at all, which is what keeps
 * it free of an exact-key `hasOnly()` allowlist and therefore able to gain a
 * field with a function change and nothing else (`CLAUDE.md` §4.2,
 * `docs/data-model.md`). Every check a rule would have made is made by
 * `decideAvatarChoice` instead — the caller, the kind, the seed, the switch —
 * and, for a built avatar, whether the player has unlocked its set, decided by
 * `lockedSetRefusal` against their stored XP inside the transaction that
 * writes the choice (`FEAT-041`).
 *
 * The uid comes from the verified token and is never read from the payload,
 * so a caller can only ever set their own — the same boundary as
 * `deleteAccount`, `exportAccountData` and `recordGameResult`.
 *
 * Returns the choice as stored, so the client can show what the server kept
 * rather than what it meant to send.
 */
export const setAvatar = onCall(async (request) => {
  const decision = decideAvatarChoice(request.auth, request.data);
  if (!decision.ok) {
    logger.info(`setAvatar refused (${decision.code}) for uid=${request.auth?.uid ?? 'none'}`);
    throw new HttpsError(decision.code, decision.message);
  }

  const firestore = getFirestore();
  const user = firestore.collection('users').doc(decision.uid);
  let refusal: AvatarRefusal | null;
  try {
    refusal = await firestore.runTransaction((transaction) =>
      applyAvatarChoice(transaction, user, decision.choice),
    );
  } catch (error) {
    logger.error(`Failed to save the avatar choice for ${decision.uid}`, error);
    throw new HttpsError('internal', 'Could not save your avatar.');
  }

  // Outside the `try`, so a locked set reaches the caller as the refusal it
  // is rather than as `internal`. The picker offers no locked set, so only a
  // request built outside the app — or a page still running a bundle from
  // before a threshold moved — is refused here.
  if (refusal) {
    logger.info(`setAvatar refused (${refusal.code}) for uid=${decision.uid}: a locked set`);
    throw new HttpsError(refusal.code, refusal.message);
  }

  return { avatar: decision.choice };
});
