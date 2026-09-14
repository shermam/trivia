import { describe, expect, it } from 'vitest';
import { ALLOWED_ATTR, SANITIZE_CONFIG, renderMarkdown, sanitizeHtml } from './markdown-engine';
import { renderMath } from './math-engine';

/**
 * The security suite for `FEAT-019`.
 *
 * **Every payload is its own named test on purpose.** A single "it strips bad
 * things" over a loop of inputs reports one failure whatever fails, and the
 * thing this file exists to make loud is *which* hole opened — a widened
 * `ALLOWED_TAGS`, an `ALLOWED_ATTR` entry added for one MathML formula that
 * also admits an event handler, a hook that stopped running. The names below
 * are the report.
 *
 * **Each payload is put through both layers**, via {@link bothLayers}. Raw HTML
 * is escaped by `marked` before the sanitiser ever sees it, so a suite pointed
 * only at `renderMarkdown` would keep passing with the sanitiser removed: the
 * parser would be doing all the work, and the gap would surface the day its
 * escaping changed or the day something other than `marked` produced input —
 * which is already true, because KaTeX emits raw HTML.
 *
 * **The assertions read the parsed DOM, not the HTML string.** A string check
 * for `'onerror'` fails on output where the payload survives as *escaped text*,
 * which is exactly the safe outcome; asking the DOM which elements and
 * attributes actually exist is the question the reader's browser will ask.
 *
 * Both engines are imported statically here. In the app they are two dynamic
 * imports, which is a bundling decision; a spec that reproduced it would be
 * testing the loader rather than the allowlist.
 */

/** The renderer as the app configures it: Markdown, with math compiled. */
function render(source: string): string {
  return renderMarkdown(source, { renderMath });
}

function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

function elements(host: HTMLElement): Element[] {
  return [...host.querySelectorAll('*')];
}

function tagNames(host: HTMLElement): string[] {
  return elements(host).map((element) => element.tagName.toLowerCase());
}

function attributeNames(host: HTMLElement): string[] {
  return elements(host).flatMap((element) =>
    [...element.attributes].map((attribute) => attribute.name.toLowerCase()),
  );
}

/**
 * Every `tag[attribute]` pair in the output.
 *
 * `attributeNames` alone cannot see the bug this exists for: DOMPurify's
 * allowlist is per *document*, so an attribute added for one element is legal
 * on every other, and a payload putting `href` on an `<mi>` produces exactly
 * the same attribute names as a legitimate link. The pair is the assertion.
 */
function attributePairs(host: HTMLElement): string[] {
  return elements(host).flatMap((element) =>
    [...element.attributes].map(
      (attribute) => `${element.tagName.toLowerCase()}[${attribute.name.toLowerCase()}]`,
    ),
  );
}

/**
 * The payload as the full pipeline renders it, and as the sanitiser alone
 * handles it. Both must be clean; asserting over the pair in one test keeps a
 * payload to one name while covering the two layers separately.
 */
function bothLayers(payload: string): HTMLElement[] {
  return [parse(render(payload)), parse(sanitizeHtml(payload))];
}

describe('markdown engine: injection payloads', () => {
  it('strips a <script> tag', () => {
    for (const out of bothLayers('Before <script>alert(1)</script> after')) {
      expect(tagNames(out)).not.toContain('script');
    }
    expect(parse(render('Before <script>alert(1)</script> after')).textContent).toContain('Before');
  });

  it('strips a javascript: URL in a link', () => {
    for (const out of bothLayers('<a href="javascript:alert(1)">click</a>')) {
      expect(attributeNames(out)).not.toContain('href');
    }
    const markdown = parse(render('[click](javascript:alert(1))'));
    expect(attributeNames(markdown)).not.toContain('href');
    // The label survives: a refused link degrades to its own text rather than
    // to a dead anchor the reader cannot tell from a live one.
    expect(markdown.textContent).toContain('click');
  });

  it('strips a data: URL in a link', () => {
    const payload = 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==';
    for (const out of bothLayers(`<a href="${payload}">click</a>`)) {
      expect(attributeNames(out)).not.toContain('href');
    }
    expect(attributeNames(parse(render(`[click](${payload})`)))).not.toContain('href');
  });

  it('strips a relative link, because only https is offered', () => {
    const out = parse(render('[settings](/account)'));
    expect(attributeNames(out)).not.toContain('href');
    expect(out.textContent).toContain('settings');
  });

  it('keeps an https link and gives it target and rel', () => {
    const link = parse(render('[docs](https://example.org/a)')).querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.org/a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('strips an <img> with an onerror handler', () => {
    for (const out of bothLayers('<img src=x onerror="alert(1)">')) {
      expect(tagNames(out)).not.toContain('img');
      expect(attributeNames(out)).not.toContain('onerror');
    }
  });

  it('strips a markdown image, because img-src would refuse it anyway', () => {
    expect(tagNames(parse(render('![alt](https://example.org/x.png)')))).not.toContain('img');
  });

  it('strips an <iframe>', () => {
    for (const out of bothLayers('<iframe src="https://evil.example/"></iframe>')) {
      expect(tagNames(out)).not.toContain('iframe');
    }
  });

  it('strips an <object>', () => {
    for (const out of bothLayers('<object data="https://evil.example/x.swf"></object>')) {
      expect(tagNames(out)).not.toContain('object');
    }
  });

  it('strips an <embed>', () => {
    for (const out of bothLayers('<embed src="https://evil.example/x.swf">')) {
      expect(tagNames(out)).not.toContain('embed');
    }
  });

  it('strips an <svg> with an onload handler', () => {
    for (const out of bothLayers('<svg onload="alert(1)"><circle r="10"/></svg>')) {
      expect(tagNames(out)).not.toContain('svg');
      expect(attributeNames(out)).not.toContain('onload');
    }
  });

  /**
   * The mutation-XSS classic: `annotation-xml` is an HTML integration point, so
   * a parser re-entering HTML inside it is how a MathML subtree smuggles markup
   * past a sanitiser that only checked MathML. It is not in `ALLOWED_TAGS`, and
   * DOMPurify's own `FORBID_CONTENTS` drops what is inside it as well.
   *
   * **This is also the test that pins the `USE_PROFILES` decision.** DOMPurify's
   * `mathMl` profile allows `annotation-xml`, and setting `USE_PROFILES`
   * silently replaces the explicit allowlist rather than intersecting with it —
   * so a config that looked stricter would fail here.
   */
  it('strips <math><annotation-xml encoding="text/html"> and its contents', () => {
    const payload =
      '<math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></math>';
    for (const out of bothLayers(payload)) {
      expect(tagNames(out)).not.toContain('annotation-xml');
      expect(tagNames(out)).not.toContain('img');
      expect(attributeNames(out)).not.toContain('onerror');
    }
  });

  /**
   * The other classic: `<style>` inside foreign content re-opens parsing.
   *
   * The declarations survive as *text* through the full pipeline, because
   * `marked` escapes the whole payload — which is the safe outcome, and why the
   * "no CSS came through" half of this is asserted against the sanitiser, where
   * `<style>` is one of the tags DOMPurify drops the contents of as well as the
   * element.
   */
  it('strips <svg><style> and its contents', () => {
    for (const out of bothLayers('<svg><style>{}*{-o-link:attr(href)}</style></svg>')) {
      expect(tagNames(out)).not.toContain('style');
      expect(tagNames(out)).not.toContain('svg');
    }
    expect(
      parse(sanitizeHtml('<svg><style>{}*{-o-link:attr(href)}</style></svg>')).textContent,
    ).not.toContain('-o-link');
  });

  it('strips a MathML element carrying an event handler', () => {
    for (const out of bothLayers('<math><mi onclick="alert(1)">x</mi></math>')) {
      expect(attributeNames(out)).not.toContain('onclick');
    }
  });

  it('strips a <form> with its inputs and buttons', () => {
    const payload =
      '<form action="https://evil.example/"><input name="p"><button>Go</button></form>';
    for (const out of bothLayers(payload)) {
      expect(tagNames(out)).not.toContain('form');
      expect(tagNames(out)).not.toContain('input');
      expect(tagNames(out)).not.toContain('button');
    }
  });

  it('strips a style attribute', () => {
    for (const out of bothLayers('<p style="position:fixed;inset:0">covering</p>')) {
      expect(attributeNames(out)).not.toContain('style');
    }
    expect(parse(sanitizeHtml('<p style="position:fixed;inset:0">covering</p>')).textContent).toBe(
      'covering',
    );
  });

  it('strips a data attribute, so a payload cannot mint a test hook', () => {
    for (const out of bothLayers('<p data-cy="answer-option">not an option</p>')) {
      expect(attributeNames(out)).not.toContain('data-cy');
    }
  });

  it('strips an aria attribute, so a payload cannot relabel the question', () => {
    for (const out of bothLayers('<p aria-label="Correct answer: B">text</p>')) {
      expect(attributeNames(out)).not.toContain('aria-label');
    }
  });

  it('strips a class that is not a fence language', () => {
    for (const out of bothLayers('<p class="fixed inset-0 bg-white">covering</p>')) {
      expect(attributeNames(out)).not.toContain('class');
    }
  });

  it('keeps the fence language class, which is the only class it may have', () => {
    expect(parse(render('```js\nconst a = 1;\n```')).querySelector('code')?.className).toBe(
      'language-js',
    );
  });

  it('strips an entity-escaped script tag rather than decoding it into one', () => {
    expect(tagNames(parse(render('&lt;script&gt;alert(1)&lt;/script&gt;')))).not.toContain(
      'script',
    );
  });

  it('strips a numeric-entity-escaped img payload', () => {
    const out = parse(render('&#60;img src=x onerror=alert(1)&#62;'));
    expect(tagNames(out)).not.toContain('img');
    expect(attributeNames(out)).not.toContain('onerror');
  });

  it('renders an unclosed fence as text rather than breaking', () => {
    const out = parse(render('unclosed ```js\nconst a = 1;'));
    expect(out.textContent).toContain('const a = 1;');
    expect(tagNames(out)).not.toContain('script');
  });

  /**
   * The one payload whose *content* has to survive, because a question about
   * HTML injection is a question somebody will write.
   */
  it('renders a payload inside a fenced code block as visible text', () => {
    const out = parse(render('```html\n<script>alert(1)</script>\n```'));
    expect(tagNames(out)).toContain('pre');
    expect(tagNames(out)).not.toContain('script');
    expect(out.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders a payload inside an inline code span as visible text', () => {
    const out = parse(render('Type `<img src=x onerror=alert(1)>` to break it.'));
    expect(tagNames(out)).toContain('code');
    expect(tagNames(out)).not.toContain('img');
    expect(out.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

/**
 * The allowlist is a *document-wide* list, so "this attribute is safe" is never
 * the whole question — "safe on which element" is. Every test here puts an
 * attribute on an element it was not added for.
 */
describe('markdown engine: the allowlist is per document, not per element', () => {
  /**
   * MathML has an `href` of its own and **Firefox honours it on any MathML
   * element**, so an `<mi href>` is a live link. This one shipped: `href` was on
   * the allowlist for `<a>`, the hook that parses it for `https:` and attaches
   * `rel` returned early on anything else, and `ALLOWED_URI_REGEXP` passes a
   * protocol-relative URL because it is not scheme-shaped. The result was a
   * clickable off-site link inside a question, with no `rel` and no scheme
   * check. Unreachable through today's parser — but this file is the boundary,
   * and a boundary that holds because of what is upstream is not one.
   */
  it('strips href from a MathML element, which Firefox would otherwise make a link', () => {
    for (const payload of [
      '<math><mi href="javascript:alert(1)">x</mi></math>',
      '<math><mi href="https://evil.example">x</mi></math>',
      '<math><mi href="//evil.example">x</mi></math>',
      '<math><mtext href="/account">x</mtext></math>',
    ]) {
      for (const out of bothLayers(payload)) {
        expect(attributeNames(out)).not.toContain('href');
      }
    }
  });

  it('strips href from a prose element that is not a link', () => {
    for (const payload of ['<p href="https://evil.example">x</p>', '<code href="/x">y</code>']) {
      for (const out of bothLayers(payload)) {
        expect(attributeNames(out)).not.toContain('href');
      }
    }
  });

  /** A tooltip on arbitrary elements is a channel `marked` never opens. */
  it('strips title from anything that is not a link', () => {
    for (const out of bothLayers('<p title="not a tooltip"><code title="nor this">x</code></p>')) {
      expect(attributeNames(out)).not.toContain('title');
    }
    // …and keeps the one place it means something: a Markdown link title.
    const link = parse(render('[docs](https://example.org/a "Reference")')).querySelector('a');
    expect(link?.getAttribute('title')).toBe('Reference');
  });

  /**
   * The pair, rather than the name: a suite asserting only that `href` exists
   * somewhere passes just as happily when it is on an `<mi>`.
   */
  it('leaves href and title only on anchors, across a payload carrying both', () => {
    const out = parse(
      sanitizeHtml(
        '<a href="https://example.org/a" title="ok">link</a>' +
          '<math><mi href="https://evil.example" title="tip">x</mi></math>' +
          '<p href="https://evil.example" title="tip">y</p>',
      ),
    );
    expect(attributePairs(out).filter((pair) => pair.endsWith('[href]'))).toEqual(['a[href]']);
    expect(attributePairs(out).filter((pair) => pair.endsWith('[title]'))).toEqual(['a[title]']);
  });

  it('strips xlink:href wherever it appears', () => {
    for (const payload of [
      '<a xlink:href="javascript:alert(1)">x</a>',
      '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    ]) {
      for (const out of bothLayers(payload)) {
        expect(attributeNames(out)).not.toContain('xlink:href');
      }
    }
  });

  /**
   * `mathcolor` and `mathbackground` are `style` under another name — they
   * would survive `FORBID_ATTR: ['style']` untouched. KaTeX emits `mathcolor`
   * on exactly one thing, the error markup, which this allowlist strips anyway.
   */
  it('strips mathcolor and mathbackground, which are a style attribute renamed', () => {
    const payload =
      '<math><mstyle mathcolor="red" mathbackground="url(https://evil.example/x)"><mi>x</mi></mstyle></math>';
    for (const out of bothLayers(payload)) {
      expect(attributeNames(out)).not.toContain('mathcolor');
      expect(attributeNames(out)).not.toContain('mathbackground');
    }
  });

  it('strips a URL-bearing MathML length attribute', () => {
    for (const out of bothLayers('<math><mspace width="javascript:alert(1)"></mspace></math>')) {
      expect(attributeNames(out)).not.toContain('width');
    }
  });

  /**
   * `<annotation>` has to be allowed — KaTeX puts the source TeX in one — and
   * `annotation-xml`, the HTML integration point, does not. The pair is the
   * distinction worth pinning: `annotation` with an HTML `encoding` is inert
   * because the parser only re-enters HTML for `annotation-xml`.
   */
  it('cannot smuggle markup through <annotation encoding="text/html">', () => {
    const payload =
      '<math><semantics><annotation encoding="text/html"><img src=x onerror=alert(1)></annotation></semantics></math>';
    for (const out of bothLayers(payload)) {
      expect(tagNames(out)).not.toContain('img');
      expect(attributeNames(out)).not.toContain('onerror');
    }
  });

  it('strips <annotation-xml> with the XHTML encoding as well as the HTML one', () => {
    const payload =
      '<math><annotation-xml encoding="application/xhtml+xml"><img src=x onerror=alert(1)></annotation-xml></math>';
    for (const out of bothLayers(payload)) {
      expect(tagNames(out)).not.toContain('annotation-xml');
      expect(tagNames(out)).not.toContain('img');
    }
  });

  /**
   * `<mglyph>` and `<malignmark>` inside a text integration point are the
   * mutation-XSS family that turns a MathML subtree back into HTML parsing
   * mid-stream. Neither is on the allowlist; the `<table>` form is the one
   * that historically escaped sanitisers that re-serialised their output.
   */
  it('strips <mglyph> and the <mtext><table><mglyph> mutation form', () => {
    for (const payload of [
      '<math><mtext><mglyph></mglyph></mtext></math>',
      '<math><mtext><malignmark></malignmark></mtext></math>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    ]) {
      for (const out of bothLayers(payload)) {
        expect(tagNames(out)).not.toContain('mglyph');
        expect(tagNames(out)).not.toContain('malignmark');
        expect(tagNames(out)).not.toContain('img');
        expect(attributeNames(out)).not.toContain('onerror');
      }
    }
  });

  /**
   * The output is a *string* that the component re-parses into an element, so
   * anything the serialiser writes ambiguously gets a second chance to become
   * markup. Sanitising the output again has to be a no-op, on every payload
   * whose quoting could be misread.
   */
  it('is stable under a second pass, which is what the re-parse amounts to', () => {
    for (const payload of [
      '<a href="https://x.example" title="</a><img src=x onerror=alert(1)>">t</a>',
      '<code title="</code><img src=x onerror=alert(1)>">t</code>',
      '<math><mtext><a title="</mtext><img src=x onerror=alert(1)>">t</a></mtext></math>',
      '<math><mi>&lt;/math&gt;&lt;img src=x onerror=alert(1)&gt;</mi></math>',
    ]) {
      const once = sanitizeHtml(payload);
      expect(sanitizeHtml(once)).toBe(once);
      const out = parse(once);
      expect(tagNames(out)).not.toContain('img');
      expect(attributeNames(out)).not.toContain('onerror');
    }
  });

  /**
   * A scheme split by a control character is the oldest filter bypass there is,
   * and DOMPurify strips `ATTR_WHITESPACE` before testing the URI — but only
   * for attributes it treats as URLs, which is why the anchor hook re-parses
   * rather than pattern-matching.
   */
  it('strips a scheme split by a tab, a newline or a numeric entity', () => {
    for (const payload of [
      '<a href="java\tscript:alert(1)">click</a>',
      '<a href="java\nscript:alert(1)">click</a>',
      '<a href="&#106;avascript:alert(1)">click</a>',
      '<a href="JaVaScRiPt:alert(1)">click</a>',
      '<a href="//evil.example">click</a>',
    ]) {
      for (const out of bothLayers(payload)) {
        expect(attributeNames(out)).not.toContain('href');
      }
    }
    expect(attributeNames(parse(render('[x](&#106;avascript:alert&lpar;1&rpar;)')))).not.toContain(
      'href',
    );
    // A reference-style link is a second syntax reaching the same renderer.
    expect(attributeNames(parse(render('[x][r]\n\n[r]: javascript:alert(1)')))).not.toContain(
      'href',
    );
  });

  /**
   * `target` is set by the hook, never taken from the source: a `_top` or a
   * named frame would let a contributed link replace the whole app rather than
   * open beside it.
   */
  it('overwrites a target the source asked for, and always pairs it with rel', () => {
    const link = parse(
      sanitizeHtml('<a href="https://x.example" target="_top" rel="opener">click</a>'),
    ).querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('strips a class from a link, where no fence language can legitimately be', () => {
    const link = parse(
      sanitizeHtml('<a href="https://x.example" class="fixed inset-0">click</a>'),
    ).querySelector('a');
    expect(link?.hasAttribute('class')).toBe(false);
  });

  it('keeps only the language class when a fence carries a second one', () => {
    for (const out of bothLayers('<pre><code class="language-js x-evil">x</code></pre>')) {
      const code = out.querySelector('code');
      if (code) {
        expect(code.getAttribute('class')).toBe('language-js');
      }
    }
    expect(parse(render('```js x-evil\nconst a = 1;\n```')).querySelector('code')?.className).toBe(
      'language-js',
    );
  });

  /**
   * The configuration itself, read from the object the renderer uses rather
   * than restated here — a copy would keep passing after the real one changed.
   * Each of the three does something `ALLOWED_ATTR` alone cannot: `data-*` and
   * `aria-*` are admitted wholesale unless switched off, and `FORBID_ATTR` is
   * checked *before* the allowlist, so it is what still refuses `style` on the
   * day somebody widens the list.
   */
  it('is configured the way the payloads above assume', () => {
    expect(SANITIZE_CONFIG.ALLOW_DATA_ATTR).toBe(false);
    expect(SANITIZE_CONFIG.ALLOW_ARIA_ATTR).toBe(false);
    expect(SANITIZE_CONFIG.FORBID_ATTR).toEqual(['style']);
    expect(SANITIZE_CONFIG.USE_PROFILES).toBeUndefined();
    expect(SANITIZE_CONFIG.ALLOWED_TAGS).not.toContain('annotation-xml');
    // Nothing on the list may carry a URL, a script or a style effect anywhere
    // but on an anchor, which the hook enforces. This is the list to re-argue
    // if an entry is ever added.
    expect(
      ALLOWED_ATTR.filter((name) =>
        ['src', 'background', 'mathcolor', 'mathbackground', 'style', 'dir', 'target'].includes(
          name,
        ),
      ),
    ).toEqual([]);
    expect(ALLOWED_ATTR.filter((name) => name.startsWith('xlink:'))).toEqual([]);
    expect(ALLOWED_ATTR.filter((name) => name.startsWith('on'))).toEqual([]);
  });
});

describe('markdown engine: supported formatting', () => {
  it('renders the supported inline marks', () => {
    expect(tagNames(parse(render('**b** *i* ~~s~~ `c`')))).toEqual(
      expect.arrayContaining(['strong', 'em', 'del', 'code']),
    );
  });

  it('renders lists and blockquotes', () => {
    expect(tagNames(parse(render('> quoted\n\n- one\n- two\n\n1. first')))).toEqual(
      expect.arrayContaining(['blockquote', 'ul', 'ol', 'li']),
    );
  });

  /**
   * Headings are not in the allowlist, so the tag goes and the words stay. A
   * heading inside a question card would out-shout the card's own.
   */
  it('drops a heading tag and keeps its words', () => {
    const out = parse(render('# Shouting'));
    expect(tagNames(out)).not.toContain('h1');
    expect(out.textContent).toContain('Shouting');
  });

  it('parses no block constructs in inline mode', () => {
    const out = parse(renderMarkdown('- one\n- two', { inline: true, renderMath }));
    expect(tagNames(out)).not.toContain('ul');
    expect(tagNames(out)).not.toContain('li');
  });

  it('still renders emphasis and code in inline mode', () => {
    const out = parse(renderMarkdown('**b** and `c`', { inline: true, renderMath }));
    expect(tagNames(out)).toEqual(expect.arrayContaining(['strong', 'code']));
  });
});

describe('markdown engine: math', () => {
  it('compiles inline math to MathML', () => {
    expect(tagNames(parse(render('The area is $x^2$ exactly.')))).toEqual(
      expect.arrayContaining(['math', 'msup']),
    );
  });

  /**
   * **The assertion that catches a future KaTeX upgrade changing its default
   * renderer.** KaTeX's HTML output positions every glyph with an inline
   * `style`, which `style-src 'self'` refuses *silently* — the attribute stays
   * and its declarations are dropped, so the formula renders as a heap of
   * overlapping characters with nothing in any console (`CLAUDE.md` §4.4).
   */
  it('renders math with no style attribute and no stylesheet anywhere', () => {
    const out = parse(render('$$\\frac{a}{b} = \\sum_{i=1}^{n} x_i$$'));
    expect(attributeNames(out)).not.toContain('style');
    expect(tagNames(out)).not.toContain('style');
    expect(tagNames(out)).not.toContain('link');
  });

  it('marks a display formula as display="block" for the scroll container', () => {
    expect(parse(render('$$x^2$$')).querySelector('math')?.getAttribute('display')).toBe('block');
  });

  it('leaves an inline formula undisplayed, so it sits in the run of the text', () => {
    expect(parse(render('cost $x^2$ here')).querySelector('math')?.hasAttribute('display')).toBe(
      false,
    );
  });

  /**
   * A malformed formula must not blank the question. KaTeX emits its own error
   * markup — a `<span class="katex-error" style="color:#cc0000">` — and the
   * sanitiser drops the span and its style and keeps the source text. That the
   * *style* goes is the half worth testing: it is the one place in the pipeline
   * where an inline style is generated rather than injected.
   */
  it('falls back to the source text when a formula will not compile', () => {
    const out = parse(render('$\\frac{$'));
    expect(attributeNames(out)).not.toContain('style');
    expect(out.textContent).toContain('\\frac{');
  });

  it('shows a formula as its own source when the math engine did not load', () => {
    const out = parse(renderMarkdown('The area is $x^2$ exactly.'));
    expect(tagNames(out)).not.toContain('math');
    expect(out.querySelector('code')?.textContent).toBe('$x^2$');
  });

  /**
   * The reason the delimiters are as fussy as they are: a question about prices
   * is a normal trivia question, and a naive `$…$` turns two of them into a
   * formula reading "5 and".
   */
  it('leaves currency amounts alone', () => {
    const out = parse(render('Cost is $5 and $6 today.'));
    expect(tagNames(out)).not.toContain('math');
    expect(out.textContent).toContain('Cost is $5 and $6 today.');
  });

  it('does not compile a formula inside a fenced code block', () => {
    const out = parse(render('```js\nconst price = "$x^2$";\n```'));
    expect(tagNames(out)).not.toContain('math');
    expect(out.textContent).toContain('$x^2$');
  });

  it('does not compile a formula inside an inline code span', () => {
    expect(tagNames(parse(render('Write `$x^2$` to get a formula.')))).not.toContain('math');
  });
});

/**
 * KaTeX has an escape hatch out of maths and into HTML — `\href`, `\url`,
 * `\includegraphics` and the `\html*` family — governed by a single `trust`
 * option that defaults to `false`. **Asserted rather than assumed**, because
 * the default is the only thing switching it off: nothing in `math-engine.ts`
 * names it, so a future `trust: true` added for one convenience would open all
 * of them at once and no other test in this file would notice.
 *
 * Behaviour rather than configuration on purpose. Reading the options object
 * back would prove what was passed; these prove what the compiler *did* with
 * it, which is the thing a KaTeX upgrade could change without the option
 * moving.
 */
describe('markdown engine: KaTeX runs untrusted', () => {
  it.each([
    ['\\href with a javascript: URL', String.raw`$\href{javascript:alert(1)}{x}$`, '\\href'],
    ['\\href with an https: URL', String.raw`$\href{https://evil.example}{x}$`, '\\href'],
    ['\\url', String.raw`$\url{javascript:alert(1)}$`, '\\url'],
    [
      '\\includegraphics',
      String.raw`$\includegraphics[height=1em]{https://evil.example/x.png}$`,
      '\\includegraphics',
    ],
    ['\\htmlStyle', String.raw`$\htmlStyle{position:fixed;inset:0}{x}$`, '\\htmlStyle'],
    ['\\htmlClass', String.raw`$\htmlClass{fixed inset-0}{x}$`, '\\htmlClass'],
    ['\\htmlId', String.raw`$\htmlId{body}{x}$`, '\\htmlId'],
    ['\\htmlData', String.raw`$\htmlData{cy=answer-option}{x}$`, '\\htmlData'],
  ])(
    'refuses %s, so no link, image, class or style comes out of a formula',
    (_name, source, command) => {
      const out = parse(render(source));
      expect(tagNames(out)).not.toContain('a');
      expect(tagNames(out)).not.toContain('img');
      expect(attributeNames(out)).not.toContain('href');
      expect(attributeNames(out)).not.toContain('style');
      expect(attributeNames(out)).not.toContain('class');
      // It degrades the way every other unsupported command does — the command
      // name as text, not a blank space where a formula was.
      expect(out.textContent).toContain(command);
    },
  );

  /**
   * `\def` is real TeX and KaTeX supports it, so a contributor can write a
   * macro that expands into another that expands into another. `maxExpand`
   * (1000 by default) is what stops the classic billion-laughs; a formula that
   * hits it raises a `ParseError`, which `throwOnError: false` turns into the
   * same source-text fallback a typo produces.
   */
  it('stops a macro expansion bomb instead of hanging on it', () => {
    const bomb = String.raw`\def\a{\b\b\b\b\b\b\b\b\b\b}\def\b{\c\c\c\c\c\c\c\c\c\c}\def\c{\d\d\d\d\d\d\d\d\d\d}\def\d{\e\e\e\e\e\e\e\e\e\e}\def\e{x}\a`;
    const started = Date.now();
    const out = parse(render(`$${bomb}$`));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(tagNames(out)).not.toContain('math');
    expect(out.textContent).toContain('\\def');
  });

  it('stops a self-recursive macro', () => {
    const started = Date.now();
    const out = parse(render(String.raw`$\def\x{\x}\x$`));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.textContent).toContain('\\def');
  });

  /**
   * A macro defined in one formula must not exist in the next. KaTeX builds a
   * fresh namespace per `renderToString` unless a `macros` object is shared
   * between calls — and `markdown-engine.ts` memoizes a `Marked` instance per
   * renderer, which is exactly the shape that would share one by accident.
   */
  it('does not carry a macro from one formula into the next', () => {
    render(String.raw`$\gdef\evil{HACKED}$`);
    expect(parse(render(String.raw`$\evil$`)).textContent).toContain('\\evil');
  });

  /**
   * A 500-character question is the largest a contributor can write
   * (`firestore.rules`, `data-model.md` §3), so the input is bounded before it
   * reaches KaTeX. This checks the bound is enough — that the worst formula
   * that fits does not lock the tab up.
   */
  it('compiles the deepest formula a 500-character question can hold, quickly', () => {
    const depth = 160;
    const started = Date.now();
    const out = parse(render(`$${'x^{'.repeat(depth)}a${'}'.repeat(depth)}$`));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(tagNames(out)).toContain('math');
  });
});

/**
 * A `$` is an ordinary character in a trivia question, and the tokenizer has to
 * be able to say where a formula stops. These are the boundaries where a
 * payload would be smuggled out of a maths token and back into markup.
 */
describe('markdown engine: math delimiter boundaries', () => {
  it.each([
    ['$$\n<script>alert(1)</script>\n$$'],
    ['$<script>alert(1)</script>$'],
    ['$$a$$<script>alert(1)</script>$$b$$'],
    ['$x$ and <script>alert(1)</script>'],
    ['`$<script>alert(1)</script>$`'],
    ['```\n$<script>alert(1)</script>$\n```'],
    ['**$<img src=x onerror=alert(1)>$**'],
    ['> $$<script>alert(1)</script>$$'],
    ['[$x^2$](https://example.org/a)'],
  ])('keeps %j inside the token it belongs to', (source) => {
    const out = parse(render(source));
    expect(tagNames(out)).not.toContain('script');
    expect(tagNames(out)).not.toContain('img');
    expect(attributeNames(out)).not.toContain('onerror');
  });

  /**
   * The fallback path is a second renderer with a second escaping decision in
   * it — the source goes into a `<code>` span rather than to KaTeX — so it gets
   * its own payload rather than being assumed safe because the compiled path
   * is.
   */
  it('escapes a payload in the no-math fallback, where the source is echoed back', () => {
    const out = parse(renderMarkdown('$<script>alert(1)</script>$'));
    expect(tagNames(out)).not.toContain('script');
    expect(out.querySelector('code')?.textContent).toBe('$<script>alert(1)</script>$');
  });
});
