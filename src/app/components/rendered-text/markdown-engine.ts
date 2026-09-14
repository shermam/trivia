import DOMPurify, { type Config } from 'dompurify';
import { Marked, type Token, type Tokens } from 'marked';
import { DISPLAY_MATH_BLOCK, DISPLAY_MATH_INLINE, INLINE_MATH } from './math-delimiters';

/**
 * Markdown source → sanitised HTML (`FEAT-019` §0, constraint 1).
 *
 * **The whole security boundary of the feature is in this file**, which is why
 * it is a module of plain functions rather than something spread across a
 * component: one allowlist, one place a payload suite can be pointed at, and no
 * way for the quiz loop and the review queue to end up sanitising differently.
 * `markdown-engine.spec.ts` is the suite; every payload in it is a named test,
 * so widening the allowlist fails loudly rather than quietly.
 *
 * Nothing imports this statically except its own spec — the component reaches
 * it through `import()` so that a `plain` question, which is every question in
 * the bank today and every question Open Trivia DB will ever serve, pays
 * nothing for a parser it does not use.
 *
 * ## The pipeline, and why it is in this order
 *
 * 1. **`marked` with raw HTML turned off.** The two tokenizers that recognise
 *    HTML are disabled below, so `<script>` in a contributed question reaches
 *    the sanitiser already escaped as text. That is deliberate belt and braces:
 *    it makes DOMPurify the second line of defence rather than the only one.
 * 2. **KaTeX, through a `marked` extension** rather than a pre-pass over the
 *    source. A pre-pass cannot tell a `$` in prose from a `$` inside a fenced
 *    code block; an extension is offered the source at token boundaries, so the
 *    fence tokenizer has already claimed the code block by the time math is
 *    considered. That is what makes a payload inside a fence render as text.
 * 3. **DOMPurify against an explicit allowlist**, below.
 * 4. The caller writes the result straight into an element. It does **not** go
 *    through Angular's sanitiser, which knows nothing of MathML and would throw
 *    every formula away — see the note in `rendered-text.component.ts` for why
 *    the write is a `textContent`-style assignment rather than a
 *    `bypassSecurityTrustHtml` binding, and what that costs.
 */

export type RenderMath = (tex: string, displayMode: boolean) => string;

export interface RenderOptions {
  /**
   * Render as a run of text rather than as a document: no paragraphs, no
   * lists, no fences. What an answer option is.
   */
  inline?: boolean;
  /**
   * The compiled-math renderer, when the caller managed to load it. Absent
   * means the KaTeX chunk was not fetched or did not arrive, and a formula
   * falls back to its own source in a code span — see {@link mathExtensions}.
   */
  renderMath?: RenderMath;
}

/**
 * Every tag that may reach the DOM. **An allowlist, never a denylist**, and
 * short on purpose: this is the set a contributed question can express, so
 * everything in it is something the product decided to support rather than
 * something that happened to be safe.
 *
 * Two groups. The prose tags are exactly `FEAT-019` §1's supported Markdown —
 * note the absence of `h1`–`h6`, `img`, `table` and `hr`: a heading inside a
 * question card would out-shout the card's own heading, and `img-src 'self'`
 * would refuse a contributor's image anyway, so it renders as nothing rather
 * than as a broken picture. Anything not listed is *stripped while its text is
 * kept*, which is the degradation §1 asks for.
 *
 * The MathML tags are what KaTeX's MathML renderer emits, plus the structural
 * elements around them. **`annotation-xml` is deliberately not among them**: it
 * is an HTML integration point, which makes it the classic mutation-XSS vector
 * (`<annotation-xml encoding="text/html">` re-opens HTML parsing inside a
 * MathML subtree), and KaTeX never emits one. DOMPurify drops both the element
 * and its contents — it is in DOMPurify's own `FORBID_CONTENTS` — so nothing
 * leaks out of it as text either.
 *
 * `annotation` — no `-xml` — *is* allowed, and has to be: KaTeX puts the
 * original TeX in one, `<semantics>` renders only its first child so it is
 * never displayed, and removing the element would leave that TeX behind as
 * visible text next to the formula.
 *
 * **Which MathML tags KaTeX emits is measured, not guessed** — an element left
 * off is not an error but a silent loss of meaning, which is how `\boxed{x}`
 * came to render as a bare `x`. `markdown-engine.spec.ts`'s census renders a
 * corpus of formulas and asserts the sanitised output keeps every element and
 * attribute KaTeX put there, so the next omission fails a test rather than
 * waiting to be noticed on a question.
 */
export const ALLOWED_TAGS: readonly string[] = [
  // Markdown prose (FEAT-019 §1).
  'p',
  'br',
  'strong',
  'em',
  'del',
  'blockquote',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'a',
  // MathML, as KaTeX's `output: 'mathml'` emits it.
  'math',
  'semantics',
  'annotation',
  'mrow',
  'mi',
  'mn',
  'mo',
  'ms',
  'mtext',
  'mspace',
  'msqrt',
  'mroot',
  'mstyle',
  'merror',
  'menclose',
  'mpadded',
  'mphantom',
  'mfrac',
  'msub',
  'msup',
  'msubsup',
  'munder',
  'mover',
  'munderover',
  'mmultiscripts',
  'mprescripts',
  'none',
  'mtable',
  'mtr',
  'mtd',
];

/**
 * The same set minus `<a>`, for a run of text inside a control.
 *
 * **An answer option is a `<button>`, and a link inside a button is nested
 * interactive content**: invalid HTML, announced by a screen reader as a link
 * within a button, and a click that both answers the question and opens
 * another site. The `link` renderer below already renders a Markdown link as
 * its own text in this mode, so nothing the parser produces needs this — it is
 * here because the parser is not the boundary and an `<a>` arriving by any
 * other route is the same defect.
 */
export const INLINE_ALLOWED_TAGS: readonly string[] = ALLOWED_TAGS.filter((tag) => tag !== 'a');

/**
 * Every attribute that may reach the DOM.
 *
 * `class` is here for one value only — the `language-…` marker `marked` puts on
 * a fenced code block — and the hook below enforces that, because a class is a
 * hook into the app's own stylesheet and a contributor should not be able to
 * pick one. `href` is here so links work, and is re-checked in the hook as
 * well, for the reason `SourceLinkComponent` re-checks its own: the reader has
 * to be right regardless of the writer.
 *
 * **A list is per document, never per element**, which is the thing about
 * DOMPurify's configuration most likely to be misread: an entry here is legal
 * on *every* allowed tag, not only on the one it was added for. `href` and
 * `title` were added for `<a>` and the hook below is what confines them to it.
 * That matters because MathML has an `href` of its own — Firefox turns any
 * MathML element carrying one into a link — so `<mi href>` would be a live
 * link that never passed the `https:` parse or collected a `rel`.
 *
 * The rest are MathML presentation attributes. None of them carries a URL or a
 * script; they carry lengths, alignments and the `display="block"` that tells
 * the stylesheet a formula is a display formula rather than an inline one.
 * Deliberately **not** among them: `mathcolor` and `mathbackground`, which are
 * a `style` attribute wearing MathML's clothes — a contributed question could
 * pin a colour that ignores the reader's theme, and on any element a
 * background is a filled block. KaTeX emits them on its error markup, which
 * this allowlist strips anyway, and on `\rule`, which is the one command whose
 * rendering the decision knowingly spoils: the rule keeps the space it
 * reserves and loses its ink. Also absent: `xlink:href`, `src` and
 * `background`, which carry URLs into elements that have no business fetching
 * anything.
 */
export const ALLOWED_ATTR: readonly string[] = [
  'href',
  'title',
  'class',
  // MathML.
  'xmlns',
  'display',
  'encoding',
  'mathvariant',
  'displaystyle',
  'scriptlevel',
  'stretchy',
  'symmetric',
  'separator',
  'fence',
  'form',
  'largeop',
  'minsize',
  'maxsize',
  'lspace',
  'rspace',
  'width',
  'height',
  'depth',
  'voffset',
  'linethickness',
  'accent',
  'accentunder',
  'movablelimits',
  'columnalign',
  'rowspacing',
  'columnspacing',
  'columnlines',
  'rowlines',
  'notation',
];

/**
 * DOMPurify's own default, with every scheme but `https:` removed.
 *
 * **It cannot simply be `/^https:/`**, and that is worth stating because it
 * looks like it could be: DOMPurify runs this regexp against the value of
 * *every* allowed attribute that is not on its internal URI-safe list, not only
 * against hrefs. A pattern matching nothing but URLs would therefore delete
 * `display="block"`, `mathvariant="normal"` and every other MathML attribute,
 * and the formulas would render subtly wrong with nothing to explain it. The
 * shape below is the default's: refuse anything that looks like a scheme unless
 * that scheme is `https:`, and let a value that is not scheme-shaped through.
 *
 * That leniency is why the link hook exists as well — a *relative* href is not
 * scheme-shaped and passes here.
 */
export const ALLOWED_URI_REGEXP = /^(?:https:|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

/** The only class any of our own output can carry: `marked`'s fence language. */
const LANGUAGE_CLASS = /^language-[A-Za-z0-9#+._-]*$/;

/**
 * The sanitiser configuration, exported so the payload suite asserts against
 * the same object the renderer uses rather than a copy of it.
 *
 * **`USE_PROFILES` is deliberately absent**, against the obvious reading of
 * DOMPurify's documentation, and this is the one thing in the file worth
 * checking before changing. Measured against `dompurify@3.4.15`
 * (`_parseConfig`): when `USE_PROFILES` is set it **overwrites** `ALLOWED_TAGS`
 * and `ALLOWED_ATTR` outright rather than being intersected or merged with
 * them. A config passing both — `USE_PROFILES: { html: true, mathMl: true }`
 * *and* the lists above — would therefore run against DOMPurify's full HTML and
 * MathML profiles, `annotation-xml` and `<form>` included, and the explicit
 * lists would be silently discarded. It would look stricter than the default
 * and be looser than this. The suite pins the difference with an
 * `<annotation-xml>` payload the `mathMl` profile admits.
 *
 * `ALLOW_DATA_ATTR: false` because `data-*` is otherwise allowed wholesale
 * whatever `ALLOWED_ATTR` says, and this app addresses its own elements by
 * `data-cy` — a contributed question that can mint one can impersonate a test
 * hook. `ALLOW_ARIA_ATTR: false` for the same reason in the other direction:
 * nothing we emit needs ARIA, and a contributor should not be able to relabel
 * or hide part of a question from a screen reader.
 *
 * `FORBID_ATTR: ['style']` is not redundant with `ALLOWED_ATTR` omitting it.
 * DOMPurify checks the forbid list *before* the allow list, so this is what
 * still refuses an inline style on the day somebody widens `ALLOWED_ATTR` — the
 * failure mode `CLAUDE.md` §4.4 exists about, where a refused `style` attribute
 * stays in the DOM with its declarations silently dropped.
 */
export const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  ALLOWED_URI_REGEXP,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  FORBID_ATTR: ['style'],
};

/**
 * The same configuration for a run of text inside a control — see
 * {@link INLINE_ALLOWED_TAGS}. Spread from the one above rather than restated,
 * so a change to the allowlist cannot reach one mode and miss the other.
 *
 * A dropped element keeps its text, so a refused link renders as its label:
 * the reader loses the destination, not the answer.
 */
export const INLINE_SANITIZE_CONFIG: Config = {
  ...SANITIZE_CONFIG,
  ALLOWED_TAGS: [...INLINE_ALLOWED_TAGS],
};

/**
 * Whether a link really is an absolute `https:` URL.
 *
 * Parsed rather than prefix-matched, and rejected rather than rewritten: an
 * `<a>` with no `href` renders as its own text, which is a better outcome than
 * a dead link the reader cannot tell from a live one.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

let hooksInstalled = false;

/**
 * The three things the allowlist alone cannot express, all applied after
 * DOMPurify has finished with an element's attributes.
 *
 * **Classes are narrowed to the fence language.** `class` has to be allowed for
 * `<code class="language-js">` to survive, and allowing it wholesale would let
 * a contributor reach into the app's stylesheet. Only `marked` can emit a class
 * at all here — raw HTML is escaped upstream — but "only our own code can put
 * one there" is a property of today's pipeline rather than of the sanitiser,
 * and this is the sanitiser.
 *
 * **`href` and `title` are confined to `<a>`**, because `ALLOWED_ATTR` cannot
 * confine them itself: DOMPurify's allowlist is per document, so an entry added
 * for links is legal on every other allowed tag too. `href` is the one that
 * bites. MathML defines its own `href` and Firefox honours it on any MathML
 * element, so `<mi href="//evil.example">` was a real, clickable link — one
 * that never reached the `https:` parse below, never collected a `rel`, and
 * passed `ALLOWED_URI_REGEXP` because a protocol-relative URL is not
 * scheme-shaped. Nothing in today's pipeline can emit one — `marked` escapes
 * raw HTML and KaTeX runs untrusted, so `\href` compiles to an error — but
 * this file is the boundary, and a boundary that holds only because of what is
 * upstream of it is not one.
 *
 * **`target="_blank"` is added here, with its `rel`, and never trusted from the
 * source.** A contributed link leaves the app, so it opens in a new tab; a new
 * tab without `rel="noopener noreferrer"` hands the opened page a handle back
 * to this one. Adding both after sanitisation means they cannot be
 * half-specified by whatever was in the markdown.
 */
function installHooks(): void {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) {
      return;
    }

    const className = node.getAttribute('class');
    if (className !== null) {
      const kept = className.split(/\s+/).filter((name) => LANGUAGE_CLASS.test(name));
      if (kept.length > 0) {
        node.setAttribute('class', kept.join(' '));
      } else {
        node.removeAttribute('class');
      }
    }

    // An HTML `<a>`, and only that: DOMPurify refuses an `a` in the MathML
    // namespace outright, so anything reaching the branch below is a real
    // anchor rather than a MathML element wearing the name.
    if (node.tagName.toLowerCase() !== 'a') {
      node.removeAttribute('href');
      node.removeAttribute('title');
      return;
    }
    const href = node.getAttribute('href');
    if (href !== null && isHttpsUrl(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else {
      node.removeAttribute('href');
      node.removeAttribute('target');
      node.removeAttribute('rel');
    }
  });
}

/** `&`, `<`, `>` — enough to make arbitrary text safe as HTML text content. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `marked`'s two HTML tokenizers, switched off.
 *
 * Returning `undefined` from a tokenizer means "this is not mine", so the text
 * tokenizer takes the run instead and the renderer escapes it. The effect is
 * that raw HTML in a contributed question is *shown* rather than parsed —
 * which is what a question about HTML wants anyway — and DOMPurify never sees
 * a tag the source asked for.
 */
const noRawHtml = {
  tokenizer: {
    html(): undefined {
      return undefined;
    },
    tag(): undefined {
      return undefined;
    },
  },
};

/**
 * A Markdown link rendered as nothing but its own text.
 *
 * Inline mode only, and the reason is the host element rather than the markup:
 * an answer option is a `<button>` (see {@link INLINE_ALLOWED_TAGS}). The
 * children are re-parsed rather than the raw text emitted, so emphasis and
 * inline code inside a link label survive — losing the destination is the
 * point, losing the formatting would be collateral.
 */
const linkAsText = {
  renderer: {
    link(this: { parser: { parseInline(tokens: Token[]): string } }, token: Tokens.Link) {
      return this.parser.parseInline(token.tokens);
    },
  },
};

interface MathToken extends Tokens.Generic {
  type: 'math';
  text: string;
  displayMode: boolean;
  /**
   * The delimiter the contributor actually typed, kept separately from
   * {@link displayMode} because inline mode compiles a `$$…$$` formula
   * undisplayed and the no-engine fallback still has to echo the source back
   * as it was written.
   */
  fence: '$' | '$$';
}

/**
 * `$…$` and `$$…$$` as first-class tokens.
 *
 * Two tokenizers rather than one because `marked` asks block and inline
 * questions separately: a display formula alone on its own lines is a block, so
 * it renders outside any paragraph and the stylesheet can give it a scroll
 * container of its own; the inline pass then still has to recognise `$$…$$`
 * because a formula in the middle of a sentence is written the same way.
 *
 * When `renderMath` is absent — the KaTeX chunk did not load — the token falls
 * back to its own source in a code span, delimiters included. A reader gets the
 * formula as the contributor wrote it, which is exactly what the same fallback
 * inside KaTeX produces for a formula that will not compile.
 *
 * **In inline mode nothing is ever displayed**, whichever delimiter was
 * written. `display="block"` makes the stylesheet give a formula a block box
 * with margins and a scroll container of its own, and inside an answer
 * `<button>` that is a block dropped into a line of text. A `$$…$$` in an
 * answer therefore compiles as inline math: smaller, in the run of the text,
 * and no taller than the line.
 */
function mathExtensions(renderMath: RenderMath | undefined, inline: boolean) {
  const render = (token: MathToken): string => {
    if (!renderMath) {
      return `<code>${escapeHtml(`${token.fence}${token.text}${token.fence}`)}</code>`;
    }
    return renderMath(token.text, token.displayMode);
  };

  return {
    extensions: [
      {
        name: 'mathBlock',
        level: 'block' as const,
        start(src: string) {
          return src.indexOf('$$');
        },
        tokenizer(src: string): MathToken | undefined {
          const match = DISPLAY_MATH_BLOCK.exec(src);
          return match
            ? {
                type: 'math',
                raw: match[0],
                text: match[1].trim(),
                displayMode: !inline,
                fence: '$$',
              }
            : undefined;
        },
        renderer: render,
      },
      {
        name: 'math',
        level: 'inline' as const,
        start(src: string) {
          return src.indexOf('$');
        },
        tokenizer(src: string): MathToken | undefined {
          const display = DISPLAY_MATH_INLINE.exec(src);
          if (display) {
            return {
              type: 'math',
              raw: display[0],
              text: display[1].trim(),
              displayMode: !inline,
              fence: '$$',
            };
          }
          const match = INLINE_MATH.exec(src);
          return match
            ? {
                type: 'math',
                raw: match[0],
                text: match[1].trim(),
                displayMode: false,
                fence: '$',
              }
            : undefined;
        },
        renderer: render,
      },
    ],
  };
}

/**
 * One `Marked` instance per (math renderer, mode) pair, of which there are only
 * ever four: the compiled math renderer or `undefined` for the source-text
 * fallback, each in prose and inline form.
 *
 * Memoized rather than rebuilt per call because a recap screen renders one of
 * these per question and per answer, and because the alternative — one shared
 * instance reconfigured before each parse — is mutable state shared by every
 * caller, which is a race the day anything here becomes async.
 *
 * **Keyed on the mode as well as the renderer**, because inline mode is not a
 * parse flag the caller passes at the end: the link renderer and the math
 * tokenizers differ, and both are baked into the instance when it is built.
 */
const instances = {
  prose: new Map<RenderMath | undefined, Marked>(),
  inline: new Map<RenderMath | undefined, Marked>(),
};

function markedFor(renderMath: RenderMath | undefined, inline: boolean): Marked {
  const cache = inline ? instances.inline : instances.prose;
  let instance = cache.get(renderMath);
  if (!instance) {
    instance = inline
      ? new Marked({ gfm: true }, noRawHtml, linkAsText, mathExtensions(renderMath, true))
      : new Marked({ gfm: true }, noRawHtml, mathExtensions(renderMath, false));
    cache.set(renderMath, instance);
  }
  return instance;
}

/**
 * The allowlist applied to a string of HTML — the second line of defence, on
 * its own.
 *
 * Exported because it has to be **tested on its own**. Everything the parser
 * hands it has already had raw HTML escaped, so a payload suite pointed only at
 * `renderMarkdown` would pass with the sanitiser deleted: `marked` would be
 * doing all the work and nobody would know until the day its escaping changed,
 * or the day something other than `marked` produced input — which is already
 * the case, since KaTeX's output is raw HTML this has to police.
 */
export function sanitizeHtml(html: string, options: { inline?: boolean } = {}): string {
  installHooks();
  return DOMPurify.sanitize(html, options.inline ? INLINE_SANITIZE_CONFIG : SANITIZE_CONFIG);
}

/**
 * Markdown in, HTML that is safe to insert in, with no state left behind.
 *
 * The return value is written to an element directly rather than bound, and
 * either way it must not meet Angular's own sanitiser: that one knows nothing
 * of MathML and would throw every formula away. The allowlist above is the
 * boundary — see `rendered-text.component.ts` for what the direct write buys
 * over a `bypassSecurityTrustHtml` binding, which is bytes rather than safety.
 */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const inline = options.inline ?? false;
  const marked = markedFor(options.renderMath, inline);
  const html = inline ? marked.parseInline(source) : marked.parse(source);
  // `marked` is synchronous unless an async extension is registered, and none
  // is; the union in its return type is what the `async` option would produce.
  return sanitizeHtml(html as string, { inline });
}
