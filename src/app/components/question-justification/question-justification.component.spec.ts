import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { QuestionJustificationComponent } from './question-justification.component';

/**
 * The component's whole job is deciding *whether* to render at all and what
 * the rendered text is, so these drive the real element and read the real DOM.
 * The interesting failures — a labelled empty box on every question in the
 * app, or a contributor's line breaks collapsed into one run-on paragraph —
 * live in the template rather than in the class.
 */

@Component({
  standalone: true,
  imports: [QuestionJustificationComponent],
  template: `<app-question-justification [text]="text()" />`,
})
class HostComponent {
  readonly text = signal<string | undefined>(undefined);
}

function render(text?: string) {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.text.set(text);
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  return {
    root: el.querySelector<HTMLElement>('[data-cy="question-justification"]'),
    html: el.innerHTML,
  };
}

describe('QuestionJustificationComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders nothing when the question carries no justification', () => {
    // The common case by far, and the one it would be worst to get wrong: a
    // labelled empty box on every Open Trivia DB question in the app.
    expect(render(undefined).root).toBeNull();
  });

  it('renders nothing for an empty string', () => {
    expect(render('').root).toBeNull();
  });

  /**
   * `firestore.rules` refuses an empty `explanation`, but `size()` counts
   * characters rather than non-space ones, so `"   "` is a document the rules
   * accept. `CLAUDE.md` §4.4 — the reader has to be right regardless of the
   * writer.
   */
  it('renders nothing for a whitespace-only justification the rules would accept', () => {
    expect(render('   \n  ').root).toBeNull();
  });

  it('shows the justification under a heading naming it', () => {
    const { root } = render('The Tropic of Capricorn runs through São Paulo state.');

    expect(root).not.toBeNull();
    expect(root!.textContent).toContain('Justification');
    expect(root!.textContent).toContain('Tropic of Capricorn');
  });

  it('trims the surrounding whitespace it renders', () => {
    const { root } = render('  Because the sum is 12.  ');

    expect(root!.textContent).toContain('Because the sum is 12.');
    expect(root!.textContent).not.toContain('  Because');
  });

  /**
   * A justification is prose and is very often several paragraphs, so the
   * line breaks are part of what was written. `pre-line` is what keeps them;
   * without it the whole thing renders as one block.
   */
  it('keeps the line breaks the contributor typed', () => {
    const { root } = render('First reason.\nSecond reason.');

    const body = root!.querySelector('p:last-of-type');
    expect(body?.className).toContain('whitespace-pre-line');
    expect(body?.textContent).toBe('First reason.\nSecond reason.');
  });

  /**
   * User-generated content rendered to other users. Interpolation escapes it,
   * and this is the test that notices the day somebody reaches for
   * `[innerHTML]` to get the line breaks a `<br>` would give.
   */
  it('renders markup in a justification as text, never as HTML', () => {
    const { root, html } = render('<img src=x onerror="alert(1)"> is not a tag here');

    expect(root!.querySelector('img')).toBeNull();
    expect(html).toContain('&lt;img');
    expect(root!.textContent).toContain('is not a tag here');
  });
});
