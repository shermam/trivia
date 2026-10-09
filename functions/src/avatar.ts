import { getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { applyAvatarChoice, decideAvatarChoice } from './avatar-choice';

/**
 * Stores the caller's avatar choice on `users/{uid}` (`FEAT-038`).
 *
 * **A callable rather than a client write, for the reason `recordGameResult`
 * is one:** `users/{uid}` has no client write path at all, which is what keeps
 * it free of an exact-key `hasOnly()` allowlist and therefore able to gain a
 * field with a function change and nothing else (`CLAUDE.md` §4.2,
 * `docs/data-model.md`). Every check a rule would have made is made by
 * `decideAvatarChoice` instead — the caller, the kind, the seed, the switch.
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

  try {
    await applyAvatarChoice(getFirestore().collection('users').doc(decision.uid), decision.choice);
  } catch (error) {
    logger.error(`Failed to save the avatar choice for ${decision.uid}`, error);
    throw new HttpsError('internal', 'Could not save your avatar.');
  }

  return { avatar: decision.choice };
});
