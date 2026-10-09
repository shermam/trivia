import katex from 'katex';

/**
 * The MathML token elements, which the HTML parser treats as **text
 * integration points**: a start tag inside one is parsed as HTML, whatever its
 * name, unless it is `mglyph` or `malignmark` — neither of which KaTeX emits.
 */
export const TOKEN_ELEMENTS: readonly string[] = ['mi', 'mn', 'mo', 'ms', 'mtext'];

/** A start, end or self-closing tag in KaTeX's markup: `<name …>`, `</name>`, `<name …/>`. */
const TAG = /<(\/?)([a-z][a-z0-9-]*)[^>]*>/gi;

/**
 * KaTeX's MathML with every token element that holds an element renamed
 * `mrow` — its attributes and children left exactly as they were.
 *
 * **Why a formula could render as less than it says.** Three of KaTeX
 * 0.18's MathML builders wrap a whole expression in a token element: a math
 * class (`\mathrel`, `\mathbin`, `\mathord` and the rest, which is also how
 * `\overset`, `\underset`, `\stackrel`, `\bmod` and the `\coloneqq` family are
 * built), an operator with a body (`\mathop{…}`), and an operator name that is
 * not plain text (`\operatorname{\underline{lim}}`, which is `\varliminf`).
 * `$a \overset{!}{=} b$` comes out as `<mo><mover><mo><mo>=</mo></mo>…`. The
 * HTML parser re-homes everything inside a token element in the HTML
 * namespace, so the `<mover>` arrives as an HTML element with a MathML name —
 * which is exactly what DOMPurify's namespace check exists to refuse, and it
 * removes the element with everything in it. Without the rename the formula
 * reads "ab", with no error anywhere; a browser given KaTeX's markup
 * unsanitised builds the same tree and sets the `=` and `!` side by side as
 * text.
 *
 * Renaming the wrapper is the smallest change that keeps every element in the
 * MathML namespace: `mrow` groups its children the way the token did, so a
 * script or a fraction around it keeps its arity, and an operator inside it is
 * still the operator the spacing comes from — Chromium sets
 * `a \overset{!}{=} b` exactly as wide as `a = b`. What is lost is only what
 * an `mrow` cannot carry: the `lspace`/`rspace` a math class puts on its
 * wrapper, which stay on the element and do nothing there.
 *
 * **On a string, before anything parses it**, because the parse is where the
 * namespace flips: by the time DOMPurify has a tree, the elements are already
 * HTML. The scan is exact for KaTeX's markup and only for it — KaTeX escapes
 * `<`, `>`, `&` and both quotes in every text and attribute value, so `<`
 * only ever starts a tag. Nothing else is fed to it, and nothing it returns
 * is trusted: DOMPurify still polices every element and attribute in it.
 *
 * Published in `render-contract.json` (`katex.postprocess`);
 * `render-contract.spec.ts` derives its behaviour from the file.
 */
export function renameTokensHoldingElements(markup: string): string {
  const open: { name: string; at: number }[] = [];
  const renamed = new Set<number>();
  for (const match of markup.matchAll(TAG)) {
    const [tag, closing, name] = match;
    if (closing) {
      const start = open.pop();
      if (start !== undefined && renamed.has(start.at)) {
        renamed.add(match.index);
      }
      continue;
    }
    const parent = open.at(-1);
    if (parent !== undefined && TOKEN_ELEMENTS.includes(parent.name)) {
      renamed.add(parent.at);
    }
    if (!tag.endsWith('/>')) {
      open.push({ name, at: match.index });
    }
  }
  if (renamed.size === 0) {
    return markup;
  }
  return markup.replace(TAG, (tag: string, closing: string, name: string, at: number) =>
    renamed.has(at) ? `<${closing}mrow${tag.slice(1 + closing.length + name.length)}` : tag,
  );
}

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
 *
 * KaTeX's markup then goes through {@link renameTokensHoldingElements}, without
 * which `\overset`, `\bmod`, `\coloneqq` and every other construct KaTeX wraps
 * in a token element would render as less than it says.
 *
 * The options are published in `render-contract.json`, with the KaTeX defaults
 * the renderer relies on by not passing them — `trust` above all — and the
 * rewrite after it. `render-contract.spec.ts` captures what this call actually
 * passes and fails when the two disagree.
 */
export function renderMath(tex: string, displayMode: boolean): string {
  return renameTokensHoldingElements(
    katex.renderToString(tex, {
      output: 'mathml',
      displayMode,
      throwOnError: false,
      strict: 'ignore',
    }),
  );
}
