import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
// The renderer's published contract, read here for its tag list — the list
// `render-contract.spec.ts` holds to the live sanitiser. Specs read it;
// nothing under `src/app` imports it, so it never reaches a bundle.
import contract from '../../../../render-contract.json';
import { renderMarkdown } from '../rendered-text/markdown-engine';
import { renderMath } from '../rendered-text/math-engine';
import { TermsOfServiceComponent } from './terms-of-service.component';

/**
 * `/terms` tells a contributor which formatting a Markdown question may use,
 * and then that **anything outside that list is removed rather than
 * displayed** — a statement about what the app does with submitted text, which
 * is only true while the list names everything the sanitiser keeps
 * (`CLAUDE.md` §4.0). It drifted once: the list ended at "fenced code blocks"
 * while the allowlist also kept paragraphs and hard line breaks, so the page
 * said two things were removed that every reader was shown.
 *
 * So the check runs from the allowlist to the page, not the other way: every
 * HTML element the published allowlist keeps must be named, in the words below,
 * and the MathML set as "formulas". An element added to the allowlist has no
 * words here and fails until the page says what it is. The opposite drift — the
 * page naming something the allowlist refuses — is not reachable from a tag
 * list, and stays a matter for review.
 *
 * The same section says HTML a contributor types is shown as typed, which is
 * true of markup and not of a character reference outside code and formulas —
 * the renderer decodes `&amp;` to `&` there, and shows it as typed in a code
 * span or inside a formula — so the second test asks the renderer both ways,
 * and holds the page to saying exactly that for as long as it does.
 *
 * Unlike `legal-pages.spec.ts`, this does pin copy, because the copy *is* the
 * claim: rewording a phrase means rewording its entry here, on purpose.
 */
const WORDS_FOR: Readonly<Record<string, string>> = {
  p: 'paragraphs',
  br: 'line breaks',
  strong: 'bold',
  em: 'italics',
  del: 'strikethrough',
  ul: 'bulleted',
  ol: 'numbered',
  li: 'lists',
  blockquote: 'quotes',
  code: 'inline code',
  pre: 'code blocks',
  a: 'links to https addresses',
};

/** Text as a reader hears it: one space between words, whatever the template did. */
const collapse = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ');

/** The text of the "Formatting a question" section: every element from its heading to the next. */
async function formattingSection(): Promise<string> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [TermsOfServiceComponent],
    providers: [provideRouter([])],
  }).compileComponents();
  const fixture = TestBed.createComponent(TermsOfServiceComponent);
  fixture.detectChanges();

  const heading = [...(fixture.nativeElement as HTMLElement).querySelectorAll('h3')].find(
    (element) => element.textContent?.trim() === 'Formatting a question',
  );
  const texts: string[] = [];
  for (
    let element = heading?.nextElementSibling;
    element && element.tagName !== 'H3';
    element = element.nextElementSibling
  ) {
    texts.push(element.textContent ?? '');
  }
  return collapse(texts.join(' '));
}

describe('/terms: the formatting a contribution may use', () => {
  it('names every element the renderer keeps', async () => {
    const section = await formattingSection();
    expect(section, 'the "Formatting a question" section').not.toBe('');

    // An HTML element is one the HTML parser knows; everything else on the
    // list is the MathML a formula compiles to.
    const tags = contract.dompurify.block.ALLOWED_TAGS;
    const html = tags.filter((tag) => !(document.createElement(tag) instanceof HTMLUnknownElement));
    expect(html.length).toBeLessThan(tags.length);

    for (const tag of html) {
      expect(WORDS_FOR[tag], `<${tag}> is kept, and this file has no words for it`).toBeDefined();
      expect(section, `<${tag}>`).toContain(WORDS_FOR[tag]);
    }
    expect(section, 'MathML').toContain('formulas');
  });

  it('says a character reference outside code and formulas is shown as its character, because the renderer decodes one only there', async () => {
    // What a contributed `&amp;` becomes: the character in prose, through the
    // instance a source with no formula renders with; itself in a code span,
    // and itself inside a formula, through the instance with KaTeX.
    const shown = (source: string, options: { renderMath?: typeof renderMath } = {}) => {
      const host = document.createElement('div');
      host.innerHTML = renderMarkdown(source, options);
      return host.textContent?.trim();
    };
    expect(shown('&amp;')).toBe('&');
    expect(shown('`&amp;`')).toBe('&amp;');
    expect(shown('$x &amp; y$', { renderMath })).toContain('&amp;');

    expect(await formattingSection()).toContain(
      'outside code and formulas, a character reference such as &amp; is shown as the character it stands for',
    );
  });
});
