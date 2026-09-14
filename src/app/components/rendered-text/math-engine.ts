import katex from 'katex';

/**
 * LaTeX → **MathML**, and nothing else (`FEAT-019` §0, constraint 2).
 *
 * Its own module, and one nothing imports statically, because this is the
 * expensive half of the renderer: `RenderedTextComponent` fetches it only when
 * the source it is about to render actually contains a delimiter
 * (`math-delimiters.ts`), so a question with no formula in it — which is every
 * question in the bank today — never downloads KaTeX at all.
 *
 * **`output: 'mathml'` is a security setting here, not a preference.** KaTeX's
 * default renderer positions every glyph with an inline `style` attribute, and
 * this app is served under `style-src 'self'`, which refuses those. The way a
 * CSP refuses an inline style is the worst available: the attribute stays on
 * the element and its declarations are silently dropped (`CLAUDE.md` §4.4), so
 * the formula would render as a heap of overlapping characters with nothing in
 * any console, any Lighthouse run or any e2e to say why. MathML positions
 * nothing itself — the browser lays it out — so there is no style to refuse and
 * no stylesheet to load.
 *
 * `throwOnError: false` keeps a malformed formula from taking the question down
 * with it: KaTeX emits its own error markup instead, which is a
 * `<span class="katex-error" style="color:#cc0000">` wrapping the source text —
 * an inline style of exactly the kind above. The sanitiser drops the span and
 * keeps the text, so a reader sees the LaTeX they typed. That is the intended
 * outcome and `markdown-engine.spec.ts` pins it, because it is also the place a
 * widened allowlist would start shipping `style` attributes.
 *
 * `strict: 'ignore'` because the alternative is a `console.warn` per formula
 * for things like a Unicode character in text mode, on content this app does
 * not control and cannot fix.
 */
export function renderMath(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, {
    output: 'mathml',
    displayMode,
    throwOnError: false,
    strict: 'ignore',
  });
}
