/**
 * Where LaTeX starts and stops in a Markdown source, and nothing else
 * (`FEAT-019`).
 *
 * **A module of its own because it is the one part of the math pipeline the
 * initial bundle can afford.** `RenderedTextComponent` has to decide whether a
 * question needs KaTeX *before* it fetches it — the whole point of loading the
 * math engine lazily is that a question with no formula in it never pays for
 * one — and it cannot ask the engine, because asking is the cost. So the
 * delimiters live here, dependency-free, imported statically by the component
 * and by `markdown-engine.ts` alike, and the tokenizer that consumes them and
 * the detector that peeks for them are guaranteed to agree about what a
 * delimiter is.
 *
 * **The inline rule is Pandoc's, and the reason is a currency symbol.** A bare
 * `/\$(.+?)\$/` turns *"Cost is $5 and $6 today"* into a formula reading
 * `5 and`, which is not a hypothetical — it is the first thing a trivia
 * question about prices does. Three conditions between them make that
 * unreachable: the opening `$` may not be followed by whitespace, the closing
 * `$` may not be preceded by whitespace, and the closing `$` may not be
 * followed by a digit. `$x^2$` satisfies all three; `$5 and $6` fails the
 * second, `$ x $` the first, `$5$6` the third.
 */

/** `$$…$$` — a display formula, set on its own line. */
const DISPLAY_MATH_SOURCE = String.raw`\$\$([\s\S]+?)\$\$`;

/** `$…$` — a formula set in the run of the text. */
const INLINE_MATH_SOURCE = String.raw`\$(?![\s$])([^$\n]*?[^\s$])\$(?!\d)`;

/**
 * The anchored forms the `marked` extensions tokenize with. A tokenizer is
 * handed the *remainder* of the source and must match at its start or not at
 * all, so these carry `^`; the detector below deliberately does not.
 *
 * The block form also swallows the newlines after the closing `$$`, which is
 * what makes a display formula a block of its own rather than the first thing
 * in a paragraph that continues after it.
 */
export const DISPLAY_MATH_BLOCK = new RegExp(`^${DISPLAY_MATH_SOURCE}(?:\\n+|$)`);
export const DISPLAY_MATH_INLINE = new RegExp(`^${DISPLAY_MATH_SOURCE}`);
export const INLINE_MATH = new RegExp(`^${INLINE_MATH_SOURCE}`);

const ANY_MATH = new RegExp(`${DISPLAY_MATH_SOURCE}|${INLINE_MATH_SOURCE}`);

/**
 * Whether this source is worth fetching KaTeX for.
 *
 * Deliberately approximate in one direction only: it reads the raw text, so a
 * `$…$` inside a fenced code block counts as math here and is then correctly
 * left as code by the parser. That costs a module fetch and renders nothing
 * differently. The opposite error — missing a formula and rendering its source
 * — is the one that would be visible to a reader, and the shared delimiters
 * above are what make it impossible.
 */
export function containsMath(source: string): boolean {
  return ANY_MATH.test(source);
}
