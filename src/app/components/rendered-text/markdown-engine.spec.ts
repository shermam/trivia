import { describe, expect, it } from 'vitest';
import { renderMarkdown, sanitizeHtml } from './markdown-engine';
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
