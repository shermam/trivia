import { msg, verbatim, type Message } from '../i18n/message';

/**
 * A difficulty as a reader sees it. The stored value is the contract with
 * `firestore.rules`, Open Trivia DB and the pipeline, and is never translated;
 * what is shown for it is a label, and labels are (`docs/app.md` §1.16).
 *
 * A value outside the three — a document written through the Firebase console
 * never meets `firestore.rules` — is shown as it is stored rather than hidden.
 */
export function difficultyLabel(value: string): Message {
  switch (value) {
    case 'easy':
      return msg('difficulty.easy', 'easy');
    case 'medium':
      return msg('difficulty.medium', 'medium');
    case 'hard':
      return msg('difficulty.hard', 'hard');
    default:
      return verbatim(value);
  }
}
