import { TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { SourceLinkComponent } from './source-link.component';

/**
 * The component's whole job is deciding *whether* to render a link and *what*
 * it says, so the tests drive the real element and read the real DOM rather
 * than poking at the computed signals — the interesting failures (an anchor
 * that renders for a `javascript:` value, a missing `rel`) live in the
 * template, not in the class.
 */

@Component({
  standalone: true,
  imports: [SourceLinkComponent],
  template: `<app-source-link [url]="url()" [title]="title()" />`,
})
class HostComponent {
  readonly url = signal<string | undefined>(undefined);
  readonly title = signal<string | undefined>(undefined);
}

function render(url?: string, title?: string) {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.url.set(url);
  fixture.componentInstance.title.set(title);
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  return {
    fixture,
    root: el.querySelector<HTMLElement>('[data-cy="question-source"]'),
    anchor: el.querySelector<HTMLAnchorElement>('[data-cy="question-source-link"]'),
    text: el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  };
}

describe('SourceLinkComponent', () => {
  it('renders nothing when the question carries no source at all', () => {
    const { root, anchor } = render(undefined, undefined);

    // The common case by far, and the one it would be worst to get wrong:
    // an empty box or an "unverified" badge on every Open Trivia DB question.
    expect(root).toBeNull();
    expect(anchor).toBeNull();
  });

  it('renders nothing when both fields are present but blank', () => {
    const { root } = render('   ', '  ');

    expect(root).toBeNull();
  });

  it('links to an https source and labels it with the title', () => {
    const { anchor } = render('https://example.org/article', 'Example Journal');

    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute('href')).toBe('https://example.org/article');
    expect(anchor!.textContent).toContain('Example Journal');
  });

  it('opens in a new tab safely, and says so', () => {
    const { anchor } = render('https://example.org/article', 'Example Journal');

    expect(anchor!.getAttribute('target')).toBe('_blank');
    // Both tokens: `noopener` is the one with security consequence, and it is
    // the one a copy-paste drops.
    expect(anchor!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor!.textContent).toContain('opens in a new tab');
  });

  it('falls back to the hostname when there is a URL but no title', () => {
    const { anchor } = render('https://www.britannica.com/science/photosynthesis');

    // `www.` stripped: it is noise, and the point of the fallback is to tell
    // the reader which publication they are about to open.
    expect(anchor!.textContent).toContain('britannica.com');
    expect(anchor!.textContent).not.toContain('www.');
  });

  it('renders a title with no URL as plain text, not as a dead link', () => {
    const { root, anchor, text } = render(undefined, 'Feynman Lectures, Vol. II');

    expect(root).not.toBeNull();
    expect(anchor).toBeNull();
    expect(text).toContain('Feynman Lectures, Vol. II');
  });

  /**
   * `firestore.rules` refuses all three of these on write, which is exactly
   * why they are tested here: `CLAUDE.md` §4.4 asks the reader to be right
   * regardless of the writer, and a rule is one deploy away from being
   * widened. A dead `unsafe:` anchor would be a worse outcome than no anchor.
   */
  it.each([
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['plain http', 'http://example.org/article'],
    ['something that is not a URL', 'see the book'],
  ])('refuses to link %s', (_label, url) => {
    const { anchor } = render(url, 'A title');

    expect(anchor).toBeNull();
  });

  it('still shows the title when the URL is unusable', () => {
    const { root, text } = render('javascript:alert(1)', 'A title');

    // The citation is the contributor's work; a bad link is no reason to
    // discard it.
    expect(root).not.toBeNull();
    expect(text).toContain('A title');
  });

  it('renders nothing when the URL is unusable and there is no title', () => {
    const { root } = render('javascript:alert(1)');

    expect(root).toBeNull();
  });
});
