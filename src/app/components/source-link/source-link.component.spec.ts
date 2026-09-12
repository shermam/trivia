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
  template: `<app-source-link [url]="url()" [title]="title()" [showHost]="showHost()" />`,
})
class HostComponent {
  readonly url = signal<string | undefined>(undefined);
  readonly title = signal<string | undefined>(undefined);
  readonly showHost = signal(false);
}

function render(url?: string, title?: string, showHost = false) {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.url.set(url);
  fixture.componentInstance.title.set(title);
  fixture.componentInstance.showHost.set(showHost);
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  return {
    fixture,
    root: el.querySelector<HTMLElement>('[data-cy="question-source"]'),
    anchor: el.querySelector<HTMLAnchorElement>('[data-cy="question-source-link"]'),
    host: el.querySelector<HTMLElement>('[data-cy="question-source-host"]'),
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
   * **The one that matters on `/review`.** The label is `sourceTitle` — text
   * the contributor typed — so without the host a citation reading
   * "Wikipedia" can point anywhere at all, on the screen whose entire job is
   * approving on evidence. The host goes *inside* the anchor, so it is part
   * of the link's accessible name and there is no way to read or hear the
   * link without its destination.
   */
  it('discloses the host beside a title that does not match it, when asked to', () => {
    const { anchor, host } = render('https://not-wikipedia.example/page', 'Wikipedia', true);

    expect(anchor!.textContent).toContain('Wikipedia');
    expect(host?.textContent).toContain('not-wikipedia.example');
    // The whole accessible name, pinned rather than sampled: the point of the
    // disclosure is that the destination cannot be separated from the title,
    // and a `toContain` on each half would still pass if they rendered as two
    // adjacent links or in two different paragraphs.
    expect(anchor!.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Wikipedia — not-wikipedia.example (opens in a new tab)',
    );
    // Inside the link, not merely next to it.
    expect(anchor!.querySelector('[data-cy="question-source-host"]')).not.toBeNull();
  });

  it('leaves the host out by default, which is the player-facing recap', () => {
    const { anchor, host } = render('https://not-wikipedia.example/page', 'Wikipedia');

    expect(anchor!.textContent).toContain('Wikipedia');
    expect(host).toBeNull();
    expect(anchor!.textContent).not.toContain('not-wikipedia.example');
  });

  /**
   * Disclosure, not repetition: with no title the label already *is* the
   * host, and printing it twice would be noise rather than evidence.
   */
  it('does not repeat the host when it is already the label', () => {
    const { anchor, host } = render(
      'https://www.britannica.com/science/photosynthesis',
      undefined,
      true,
    );

    expect(anchor!.textContent).toContain('britannica.com');
    expect(host).toBeNull();
  });

  it('shows no host on a citation with no usable link', () => {
    const { root, host } = render('javascript:alert(1)', 'A title', true);

    expect(root).not.toBeNull();
    expect(host).toBeNull();
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
