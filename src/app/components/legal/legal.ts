/**
 * Shared state for the /privacy and /terms pages.
 *
 * These documents were drafted from what the application verifiably does —
 * every factual claim about data handling was written by reading the source,
 * not from a template.
 *
 * What could *not* be derived from source is anything requiring legal
 * judgement. Those passages were originally marked inline with an
 * `<app-review-required>` callout rendered on the page; that component is
 * gone. **The open questions did not go with it** — they moved to
 * `BACKLOG.md` §5, which is where work needing a human already lives. The
 * reasoning is that an unresolved-item notice is a message to the
 * maintainer, and the live page is the wrong place to hold a maintainer's
 * to-do list: a reader cannot act on it, and it invites them to discount the
 * rest of the document. The page-level banner still discloses the one thing
 * a reader genuinely needs — that no lawyer has reviewed this.
 *
 * **Keeping them true is part of changing the app.** A policy that misstates
 * its own product is worse than one with gaps: a gap is honest, a stale claim
 * is a misstatement about data handling, which is the exact risk publishing a
 * policy is supposed to close. This has already happened once — the first
 * draft sat unmerged while the code moved underneath it, and by the time it
 * was picked up it was claiming the app hot-linked Google Fonts (self-hosted
 * since), that contributions recorded no author (they do), and that there was
 * no way to delete your account or export your data (both shipped). See
 * `docs/known-gaps.md` and `CLAUDE.md` §2.
 */

/**
 * Whether these documents are still waiting on a professional legal review.
 *
 * Gates a banner on both pages. Note what the banner does **not** say: it does
 * not call the documents drafts. They are in force — the Terms have to be, to
 * bind anyone at all, and a document that introduces itself as a draft is a
 * poor candidate for a contract. What is honestly disclosed instead is the
 * narrower and true thing: no lawyer has read them yet.
 *
 * Set to `false` when one actually has, and set `LEGAL_LAST_UPDATED` in the
 * same commit.
 */
export const LEGAL_AWAITING_PROFESSIONAL_REVIEW = true;

/**
 * The document date. Both GDPR and LGPD expect a notice to carry an effective
 * date, and "Draft — not yet published" (what this said while the branch sat
 * open) is not one, least of all on a page that is published.
 */
export const LEGAL_LAST_UPDATED = '27 August 2026';

/**
 * The single published contact route, used by both documents for privacy
 * requests, content takedowns, refunds and everything else.
 *
 * One address rather than four role addresses: one inbox actually gets read,
 * and GDPR Art 13(1)(a) asks for "contact details", not a postal address. It
 * has to keep working — a published address that bounces is worse than no
 * address, because several sections here promise a reply to it.
 */
export const LEGAL_CONTACT_EMAIL = 'quizloop.trivia@gmail.com';

/**
 * The legal entity behind Trivimind: the controller under the LGPD and the
 * GDPR, and the party you are contracting with under the Terms.
 *
 * Naming it is not decoration. GDPR Art 13(1)(a) requires the controller's
 * *identity*, and Brazil's e-commerce decree (7.962/2013) separately requires
 * a supplier to display its corporate name and CNPJ where a consumer can see
 * them before buying. "Operated from Brazil" satisfied neither; it was a
 * location, not an identification.
 *
 * The CNPJ is published deliberately. It is public record, it is what makes
 * the corporate name verifiable rather than a claim, and a consumer-facing
 * Brazilian business is expected to show it.
 *
 * Still missing, and a live gap rather than an oversight: the decree also
 * wants a **physical address**. That is a decision about what the owner is
 * willing to publish (a caixa postal or escritório virtual are the usual
 * answers to not publishing a home address), and Stripe will require one at
 * go-live regardless — see `docs/known-gaps.md`.
 */
export const LEGAL_ENTITY_NAME = 'TRIVIMIND TECNOLOGIA INOVA SIMPLES (I.S.)';

/** Brazilian company registration number, shown alongside {@link LEGAL_ENTITY_NAME}. */
export const LEGAL_ENTITY_CNPJ = '68.278.108/0001-84';

/**
 * Structure and tone are adapted from Basecamp's open-sourced policies
 * (https://github.com/basecamp/policies), used under CC BY 4.0, which
 * requires attribution and requires that adaptations are indicated as such.
 * The line rendered at the foot of each page satisfies both — don't remove it
 * while the structure remains derived, and don't reword it into anything that
 * implies 37signals endorses this app or that their legal review extends to
 * it, which CC BY separately forbids.
 *
 * Note the licence is CC BY (attribution only), *not* the share-alike
 * CC BY-SA that Automattic's equivalent documents carry, which would have
 * obliged these pages to be licensed the same way.
 *
 * Worth knowing when these are next revised: the Basecamp repository was
 * archived in December 2023 and is no longer maintained, so it is a source of
 * *structure*, never of currency. The three sections that matter most here —
 * the contributed-content licence, consumer withdrawal rights, and Brazilian
 * law — are precisely the three a US B2B SaaS template does not cover, and
 * were written from scratch.
 */
export const LEGAL_ATTRIBUTION_URL = 'https://github.com/basecamp/policies';
