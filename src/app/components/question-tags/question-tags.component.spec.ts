import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { QuestionTagsComponent } from './question-tags.component';

/**
 * The component's job is deciding **whether** to render at all and **what
 * survives** being rendered, so these drive the real element and read the real
 * DOM. Both interesting failures — a chip appearing for a value the rules would
 * have refused, an empty labelled list on the overwhelming majority of
 * questions — live in the template rather than in the class.
 */

@Component({
  standalone: true,
  imports: [QuestionTagsComponent],
  template: `<app-question-tags [tags]="tags()" />`,
})
class HostComponent {
  readonly tags = signal<readonly string[] | undefined>(undefined);
}

function render(tags?: readonly unknown[]) {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.tags.set(tags as readonly string[] | undefined);
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  return {
    list: el.querySelector<HTMLElement>('[data-cy="question-tags"]'),
    chips: [...el.querySelectorAll<HTMLElement>('[data-cy="question-tag"]')].map(
      (chip) => chip.textContent?.trim() ?? '',
    ),
  };
}

describe('QuestionTagsComponent', () => {
  it('renders one chip per tag, prefixed so it reads as a tag', () => {
    const { chips } = render(['world-war-2', 'treaties']);

    expect(chips).toEqual(['#world-war-2', '#treaties']);
  });

  it('gives the list an accessible name, since a bare row of words says nothing', () => {
    const { list } = render(['calculus']);

    expect(list?.tagName).toBe('UL');
    expect(list?.getAttribute('aria-label')).toBe('Tags');
  });

  /**
   * Almost every question in the app has none — everything from Open Trivia DB
   * by construction, and every contribution written before the field existed.
   * A heading over an empty row would appear on nearly all of them to report an
   * absence.
   */
  it('renders nothing at all when there are no tags', () => {
    expect(render(undefined).list).toBeNull();
    expect(render([]).list).toBeNull();
  });

  /**
   * `firestore.rules` refuses every one of these on any write the app can make
   * — and every one of them is writable straight into `custom_questions` from
   * the Firebase console, which the rules do not govern. The reader has to be
   * right regardless of the writer (`CLAUDE.md` §4.4).
   */
  it('drops anything a console-written document could hold', () => {
    const { chips } = render([
      'world-war-2',
      'Shouty',
      'has space',
      'a',
      42,
      null,
      { nested: true },
      'x'.repeat(33),
      'world-war-2',
    ]);

    expect(chips).toEqual(['#world-war-2']);
  });

  it('renders at most the eight tags a question may carry', () => {
    const { chips } = render(Array.from({ length: 30 }, (_, i) => `topic-${i}`));

    expect(chips).toHaveLength(8);
  });

  /**
   * A tag never goes through the Markdown renderer, whatever the question's
   * `format` says: it is a key the filter compares, not prose, and the moment a
   * tag could be Markdown it could be a link. Angular's interpolation escapes
   * it, and this is the row that would notice if somebody reached for
   * `innerHTML`.
   */
  it('renders a tag as text, never as markup', () => {
    // Not renderable as a tag at all under the shape rules, which is the first
    // line of defence; the assertion is that nothing was parsed either.
    const { list } = render(['<b>bold</b>', 'safe-tag']);

    expect(list?.querySelector('b')).toBeNull();
    expect(list?.textContent).toContain('#safe-tag');
  });
});
