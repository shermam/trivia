import katex from 'katex';

/**
 * The MathML token elements, which the HTML parser treats as **text
 * integration points**: a start tag inside one is parsed as HTML, whatever its
 * name, unless it is `mglyph` or `malignmark` — neither of which KaTeX emits.
 */
export const TOKEN_ELEMENTS: readonly string[] = ['mi', 'mn', 'mo', 'ms', 'mtext'];

/**
 * When a token holding an element is collapsed rather than renamed: it is the
 * `wrapper`, and its one child is a token named in `inner` holding one
 * character and carrying exactly the attributes listed for it.
 *
 * Narrower than "any token around one character" on purpose. An `mo` is set
 * upright and spaced as an operator, so collapsing into one keeps a glyph's
 * look only when the glyph was upright already: an `mi` with
 * `mathvariant="normal"`, an `mo`, an `mn` or an `mtext`. A bare `mi` holding
 * a letter is italic — `\stackrel{a}{b}`'s `b`, `\mathop{x}`'s `x` — and an
 * `ms` draws quotes around its text, so those keep the `mrow` rename.
 */
export const COLLAPSE = {
  wrapper: 'mo',
  inner: {
    mi: { mathvariant: 'normal' },
    mn: {},
    mo: {},
    mtext: {},
  } as Readonly<Record<string, Readonly<Record<string, string>>>>,
};

/** What a token holding elements is renamed to when it is not collapsed. */
export const RENAME_TO = 'mrow';

/**
 * The largest size KaTeX's sizing commands set — `\Huge`'s 2.488 — as a
 * multiple of the formula's own size, and the most any `mathsize` may come to
 * however its elements nest.
 */
export const LARGEST_SIZE = 2.488;

/** A start, end or self-closing tag in KaTeX's markup: `<name …>`, `</name>`, `<name …/>`. */
const TAG = /<(\/?)([a-z][a-z0-9-]*)[^>]*>/gi;

/** An attribute in a start tag as KaTeX writes one: ` name="value"`, or ` class ="value"`. */
const ATTRIBUTE = /\s([^\s=/>]+)\s*=\s*"([^"]*)"/g;

/** The five references KaTeX escapes text and attribute values with. */
const REFERENCES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
};

interface MarkupElement {
  name: string;
  /** The start tag exactly as written, rewritten in place when the element is. */
  start: string;
  /** The end tag as written; empty for a self-closing element. */
  end: string;
  readonly children: MarkupNode[];
}

/** An element, or a run of text exactly as written, references and all. */
type MarkupNode = MarkupElement | string;

const isElement = (node: MarkupNode): node is MarkupElement => typeof node !== 'string';

/**
 * KaTeX's markup as a tree, every tag and run of text kept as written so that
 * an untouched part serialises back byte for byte. `null` when the tags do not
 * balance, which KaTeX's never fail to: the markup is then left as it is.
 */
function parseMarkup(markup: string): MarkupNode[] | null {
  const root: MarkupNode[] = [];
  const open: MarkupElement[] = [];
  const into = (): MarkupNode[] => open.at(-1)?.children ?? root;
  let last = 0;
  for (const match of markup.matchAll(TAG)) {
    const [tag, closing, name] = match;
    if (match.index > last) {
      into().push(markup.slice(last, match.index));
    }
    last = match.index + tag.length;
    if (closing) {
      const element = open.pop();
      if (element?.name !== name) {
        return null;
      }
      element.end = tag;
      continue;
    }
    const element: MarkupElement = { name, start: tag, end: '', children: [] };
    into().push(element);
    if (!tag.endsWith('/>')) {
      open.push(element);
    }
  }
  if (last < markup.length) {
    into().push(markup.slice(last));
  }
  return open.length === 0 ? root : null;
}

const serialise = (nodes: readonly MarkupNode[]): string =>
  nodes
    .map((node) => (isElement(node) ? node.start + serialise(node.children) + node.end : node))
    .join('');

function attributesOf(start: string): Record<string, string> {
  return Object.fromEntries([...start.matchAll(ATTRIBUTE)].map(([, name, value]) => [name, value]));
}

/** Whether `child` may be collapsed into its `mo` wrapper — see {@link COLLAPSE}. */
function collapsible(child: MarkupNode): child is MarkupElement {
  if (!isElement(child) || child.children.some(isElement)) {
    return false;
  }
  if (!Object.hasOwn(COLLAPSE.inner, child.name)) {
    return false;
  }
  const allowed = COLLAPSE.inner[child.name];
  const attributes = Object.entries(attributesOf(child.start));
  const text = (child.children as string[])
    .join('')
    .replace(/&(?:amp|lt|gt|quot|#x27);/g, (reference) => REFERENCES[reference]);
  return (
    [...text].length === 1 &&
    attributes.length === Object.keys(allowed).length &&
    attributes.every(([name, value]) => allowed[name] === value)
  );
}

/**
 * Every token element holding an element, innermost first: collapsed when it
 * is an `mo` around one upright character, which it then holds itself, and
 * otherwise renamed `mrow`.
 */
function untangleTokens(nodes: readonly MarkupNode[]): void {
  for (const node of nodes) {
    if (!isElement(node)) {
      continue;
    }
    untangleTokens(node.children);
    if (!TOKEN_ELEMENTS.includes(node.name) || !node.children.some(isElement)) {
      continue;
    }
    const [only] = node.children;
    if (node.name === COLLAPSE.wrapper && node.children.length === 1 && collapsible(only)) {
      node.children.splice(0, 1, ...only.children);
    } else {
      node.start = `<${RENAME_TO}${node.start.slice(1 + node.name.length)}`;
      node.end = `</${RENAME_TO}>`;
      node.name = RENAME_TO;
    }
  }
}

/** KaTeX's own formatting of a length in em: four decimals at most, no trailing zeros. */
const em = (size: number): string => `${+size.toFixed(4)}em`;

/**
 * Every `mathsize`, rewritten relative to the nearest enclosing element that
 * carries one and capped at {@link LARGEST_SIZE}; a value that is not a
 * positive number of em is removed. `enclosing` is the size in force around
 * `nodes`, as a multiple of the formula's own.
 */
function boundSizes(nodes: readonly MarkupNode[], enclosing: number): void {
  for (const node of nodes) {
    if (!isElement(node)) {
      continue;
    }
    let size = enclosing;
    const value = attributesOf(node.start)['mathsize'];
    if (value !== undefined) {
      const written = /^(\d+(?:\.\d+)?)em$/.exec(value);
      if (written !== null && Number(written[1]) > 0) {
        size = Math.min(Number(written[1]), LARGEST_SIZE);
        node.start = node.start.replace(
          /(\smathsize\s*=\s*")[^"]*"/,
          (_attribute: string, prefix: string) => `${prefix}${em(size / enclosing)}"`,
        );
      } else {
        node.start = node.start.replace(/\smathsize\s*=\s*"[^"]*"/, '');
      }
    }
    boundSizes(node.children, size);
  }
}

/**
 * KaTeX's MathML made to render as KaTeX meant it, in two rewrites of the
 * string `renderToString` returns.
 *
 * **A token element holding elements is collapsed or renamed.** Three of
 * KaTeX 0.18's MathML builders wrap a whole expression in a token element: a
 * math class (`\mathrel`, `\mathbin`, `\mathord` and the rest, which is also
 * how `\overset`, `\underset`, `\stackrel`, `\bmod` and the `\coloneqq` family
 * are built), an operator with a body (`\mathop{…}`), and an operator name
 * that is not plain text (`\operatorname{\underline{lim}}`, which is
 * `\varliminf`). `$a \overset{!}{=} b$` comes out as
 * `<mo><mover><mo><mo>=</mo></mo>…`. The HTML parser re-homes everything
 * inside a token element in the HTML namespace, so the `<mover>` arrives as an
 * HTML element with a MathML name — which is exactly what DOMPurify's
 * namespace check exists to refuse, and it removes the element with
 * everything in it. Untouched, the formula reads "ab", with no error
 * anywhere; a browser given KaTeX's markup unsanitised builds the same tree
 * and sets the `=` and `!` side by side as text.
 *
 * Where the wrapper is an `mo` around one upright character — `\coloneqq` is
 * `<mo><mi mathvariant="normal">≔</mi></mo>` — the `mo` takes the character
 * itself ({@link COLLAPSE}): it is then exactly the operator KaTeX meant, and
 * spaced as one. Any other wrapper is renamed `mrow`, which keeps every
 * element MathML and groups its children the way the token did, so a script
 * or a fraction around it keeps its arity, and an operator inside it is still
 * the operator the spacing comes from — Chromium sets `a \overset{!}{=} b`
 * exactly as wide as `a = b`. What an `mrow` cannot carry is lost: the
 * `lspace`/`rspace` a math class puts on its wrapper, which stay on it and do
 * nothing there, and the operator spacing of a wrapper whose content is no
 * operator. Innermost first, so `<mo><mo><mo>:</mo></mo></mo>` comes out
 * `<mo>:</mo>`.
 *
 * **A `mathsize` is made relative to the one around it, and capped.** KaTeX
 * writes each sizing command's size as a multiple of the formula's own — its
 * `\Huge` is `mathsize="2.488em"` wherever it appears — but an `em` is the
 * parent's size, so nested sizes compound: `\Huge{\Huge{\Huge x}}` would be
 * 15.4 times the text rather than 2.488, and ten levels reach the largest font
 * Chromium will draw. Each value is rewritten as KaTeX's size over the size
 * already in force, and no size comes to more than {@link LARGEST_SIZE},
 * whatever the nesting; a value that is not a positive number of em goes. It
 * reads every value as KaTeX writes one and writes it relative to its parent,
 * so it runs once, on what `renderToString` returned.
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
export function postprocessMathML(markup: string): string {
  const tree = parseMarkup(markup);
  if (tree === null) {
    return markup;
  }
  untangleTokens(tree);
  boundSizes(tree, 1);
  return serialise(tree);
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
 * KaTeX's markup then goes through {@link postprocessMathML}, without which
 * `\overset`, `\bmod`, `\coloneqq` and every other construct KaTeX wraps in a
 * token element would render as less than it says, and nested sizes would
 * compound.
 *
 * The options are published in `render-contract.json`, with the KaTeX defaults
 * the renderer relies on by not passing them — `trust` above all — and the
 * rewrite after it. `render-contract.spec.ts` captures what this call actually
 * passes and fails when the two disagree.
 */
export function renderMath(tex: string, displayMode: boolean): string {
  return postprocessMathML(
    katex.renderToString(tex, {
      output: 'mathml',
      displayMode,
      throwOnError: false,
      strict: 'ignore',
    }),
  );
}
