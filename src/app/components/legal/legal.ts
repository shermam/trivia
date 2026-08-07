/**
 * Shared state for the /privacy and /terms pages.
 *
 * These documents were drafted from what the application verifiably does —
 * every factual claim about data handling was written by reading the source,
 * not from a template. What could *not* be derived from source is anything
 * requiring legal judgement (retention periods, jurisdiction, refund terms,
 * liability, whether the service is offered to children). Those are marked
 * inline with `<app-review-required>` and must be resolved by a human before
 * this ships.
 *
 * `LEGAL_IS_DRAFT` gates a loud banner on both pages. Flipping it to `false`
 * is the deliberate act of saying "a person has reviewed this" — leave it
 * `true` until that has actually happened, and set `LEGAL_LAST_UPDATED` to
 * the review date at the same time.
 */
export const LEGAL_IS_DRAFT = true;

/** Displayed as the document date. Set this when `LEGAL_IS_DRAFT` goes false. */
export const LEGAL_LAST_UPDATED = 'Draft — not yet published';

/**
 * Structure and tone are adapted from Basecamp's open-sourced policies
 * (https://github.com/basecamp/policies), used under CC BY 4.0, which
 * requires attribution. The attribution line rendered at the foot of each
 * page satisfies that — don't remove it while the structure remains derived.
 * Note the licence is CC BY (attribution only), *not* the share-alike
 * CC BY-SA that Automattic's equivalent documents carry, which would have
 * obliged us to license these pages the same way.
 */
export const LEGAL_ATTRIBUTION_URL = 'https://github.com/basecamp/policies';
