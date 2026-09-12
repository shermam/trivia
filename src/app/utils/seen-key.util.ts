import { TriviaQuestion } from '../models/question.model';

/**
 * The identity a question is remembered by once it has been answered
 * (`FEAT-034`), and the key of the `seen-questions` object store.
 *
 * The two sources need different identities for the same reason the offline
 * pool's `dedupeKeyFor` gives them different identities, and the consequence
 * here is sharper:
 *
 * - **`custom`** questions carry a Firestore document id, which is stable
 *   across fetches and unique per document — so two contributors submitting
 *   the same wording stay two questions, and answering one does not suppress
 *   the other.
 * - **`open_trivia`** questions get an id minted at fetch time
 *   (`open-${Date.now()}-${index}`), so there is nothing durable to remember
 *   at all. The key is therefore a hash of the question's own text. That is
 *   not a fallback but the point of the feature: Open Trivia DB is where the
 *   repeats a player actually notices come from, and an id that changes every
 *   fetch would make every repeat look like a new question.
 *
 * The two prefixes are distinct (`custom:` / `otdb:`) so a hash can never
 * collide with a document id.
 */
export function seenKeyFor(question: TriviaQuestion): string {
  return question.source === 'custom'
    ? `custom:${question.id}`
    : `otdb:${hashQuestionText(question.question)}`;
}

/**
 * The text a hash is taken over: trimmed, whitespace-collapsed, case-folded.
 *
 * **HTML entities are deliberately not decoded here.** Open Trivia DB's text
 * is decoded at that source's adapter (`decodeOpenTriviaText` in
 * `TriviaService`), which is where a per-source transformation belongs
 * (`CLAUDE.md` §4.4) — and running `decodeHtmlEntities` a second time is not
 * a harmless no-op, because it is not idempotent: `&amp;amp;` decodes to
 * `&amp;` and then to `&`. Normalising the rest is worth doing because those
 * differences genuinely are noise — the same question with a stray double
 * space, or capitalised differently, is the same question to a player.
 */
export function normaliseQuestionText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A short, stable, non-cryptographic fingerprint of a question's wording.
 *
 * **FNV-1a, run twice with different offset bases and concatenated**, which
 * gives 64 bits rendered in base 36 — about 13 characters. One 32-bit pass
 * would have been simpler and is not enough: at the store's 2,000-entry cap a
 * single 32-bit hash collides with probability around 1 in 2,000, and a
 * collision here is silent and permanent for as long as the entry lives — a
 * question the player has never seen, never served again. Two passes put that
 * probability below one in a hundred million, which is cheaper than reasoning
 * about it.
 *
 * Not a cryptographic digest: nothing here is a security boundary, the input
 * is public question text, and `crypto.subtle.digest` is asynchronous, which
 * would push an `await` into every candidate comparison on the draw.
 */
export function hashQuestionText(text: string): string {
  const normalised = normaliseQuestionText(text);
  return `${fnv1a(normalised, 0x811c9dc5)}${fnv1a(normalised, 0x01234567)}`;
}

/** One FNV-1a pass over the string, rendered base 36 and zero-padded to a fixed width. */
function fnv1a(text: string, offsetBasis: number): string {
  let hash = offsetBasis;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    // `Math.imul` is what keeps the multiply in 32-bit integer space; a plain
    // `*` overflows into a float and silently stops being FNV after the first
    // few characters.
    hash = Math.imul(hash, 0x01000193);
  }
  // Padded so the two halves cannot slide into each other: without it,
  // `"1" + "23"` and `"12" + "3"` are the same string.
  return (hash >>> 0).toString(36).padStart(7, '0');
}
