import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TagSelectorComponent } from './tag-selector.component';

/**
 * Everything here drives the **real elements** — typing into the input,
 * pressing Enter, clicking a chip's remove button — rather than calling the
 * component's methods. That is the same lesson `[ngValue]` taught (`CLAUDE.md`
 * §4.4): this is a `ControlValueAccessor`, so the accessor *is* the thing under
 * test, and a spec that called `add()` directly would prove nothing about
 * whether the form control ever sees the value.
 */

@Component({
  standalone: true,
  imports: [ReactiveFormsModule, TagSelectorComponent],
  template: `<app-tag-selector
    [formControl]="control"
    [max]="max()"
    [suggestions]="suggestions()"
    [disabledReason]="disabledReason()"
  />`,
})
class HostComponent {
  readonly control = new FormControl<string[]>([], { nonNullable: true });
  readonly max = signal(8);
  readonly suggestions = signal<readonly string[]>(['world-war-2', 'calculus']);
  readonly disabledReason = signal<string | null>(null);
}

function render() {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  const host = fixture.componentInstance;

  const input = () => el.querySelector<HTMLInputElement>('[data-cy="tag-input"]')!;

  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  const press = (key: string) => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    fixture.detectChanges();
  };

  const enter = (text: string) => {
    type(text);
    press('Enter');
  };

  const click = (selector: string) => {
    el.querySelector<HTMLButtonElement>(selector)!.click();
    fixture.detectChanges();
  };

  return {
    fixture,
    host,
    input,
    type,
    press,
    enter,
    click,
    chips: () =>
      [...el.querySelectorAll<HTMLElement>('[data-cy="selected-tag"]')].map(
        (chip) => chip.textContent?.trim().split(/\s+/)[0] ?? '',
      ),
    feedback: () =>
      el.querySelector<HTMLElement>('[data-cy="tag-feedback"]')?.textContent?.trim() ?? '',
    status: () =>
      el.querySelector<HTMLElement>('[data-cy="tag-status"]')?.textContent?.trim() ?? '',
    suggestion: (tag: string) =>
      el.querySelector<HTMLButtonElement>(`[data-cy="suggest-tag-${tag}"]`)!,
    el,
  };
}

describe('TagSelectorComponent — what reaches the form control', () => {
  it('writes the normalised form of what was typed, not what was typed', () => {
    const { host, enter, chips } = render();

    enter('World War 2');

    expect(host.control.value).toEqual(['world-war-2']);
    expect(chips()).toEqual(['#world-war-2']);
  });

  it('accepts a comma as well as Enter, because both are what people type', () => {
    const { host, type, press } = render();

    type('cold war');
    press(',');

    expect(host.control.value).toEqual(['cold-war']);
  });

  /**
   * A half-typed tag left in the box when the reader moves on to Save is a tag
   * they believe they added.
   */
  it('commits what is left in the box on blur', () => {
    const { host, type, input, fixture } = render();

    type('treaties');
    input().dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(host.control.value).toEqual(['treaties']);
  });

  it('removes a chip through its own button', () => {
    const { host, enter, click, chips } = render();

    enter('calculus');
    enter('algebra');
    click('[data-cy="remove-tag-calculus"]');

    expect(host.control.value).toEqual(['algebra']);
    expect(chips()).toEqual(['#algebra']);
  });

  it('removes the last chip on Backspace in an empty box, the token-field convention', () => {
    const { host, enter, press } = render();

    enter('calculus');
    enter('algebra');
    press('Backspace');

    expect(host.control.value).toEqual(['calculus']);
  });

  it('collapses two spellings of the same tag rather than storing both', () => {
    const { host, enter, status } = render();

    enter('World War 2');
    enter('world_war_2');

    expect(host.control.value).toEqual(['world-war-2']);
    expect(status()).toContain('already added');
  });

  it('stops at the maximum and says so', () => {
    const { host, enter, status } = render();
    host.max.set(2);

    enter('one-tag');
    enter('two-tag');
    enter('three-tag');

    expect(host.control.value).toEqual(['one-tag', 'two-tag']);
    expect(status()).toContain('maximum of 2');
  });

  /**
   * The form owns the value, which is the whole reason this is a
   * `ControlValueAccessor` and not a two-way `model()`: `/my-questions`' edit
   * dialog opens by `reset()`ting the shared form from the stored question, and
   * a picker that did not hear about that would show the previous question's
   * tags — or none at all, which an owner update would then write.
   */
  it('renders what the form writes into it', () => {
    const { host, fixture, chips } = render();

    host.control.setValue(['periodic-table', 'chemistry']);
    fixture.detectChanges();

    expect(chips()).toEqual(['#periodic-table', '#chemistry']);
  });

  it('survives the null a reset writes', () => {
    const { host, fixture, chips } = render();

    host.control.reset(null as unknown as string[]);
    fixture.detectChanges();

    expect(chips()).toEqual([]);
  });
});

describe('TagSelectorComponent — refusing a tag out loud', () => {
  it('previews what the draft will be stored as, before it is committed', () => {
    const { type, feedback } = render();

    type('World War 2');

    expect(feedback()).toContain('#world-war-2');
  });

  it('says a draft is too short rather than silently dropping it', () => {
    const { host, enter, feedback, status } = render();

    enter('!!');

    expect(host.control.value).toEqual([]);
    expect(feedback()).toContain('at least 2');
    expect(status()).toContain('no tag in it');
  });

  it('says a draft is too long rather than truncating it', () => {
    const { host, enter, feedback } = render();

    enter('x'.repeat(40));

    expect(host.control.value).toEqual([]);
    expect(feedback()).toContain('at most 32');
  });
});

describe('TagSelectorComponent — the suggestions', () => {
  it('adds a suggestion when it is pressed and removes it when pressed again', () => {
    const { host, suggestion, fixture } = render();

    suggestion('calculus').click();
    fixture.detectChanges();
    expect(host.control.value).toEqual(['calculus']);

    suggestion('calculus').click();
    fixture.detectChanges();
    expect(host.control.value).toEqual([]);
  });

  /**
   * A grouped control has to convey the group, and a toggle has to convey its
   * state (`CLAUDE.md` §4.5). Neither is audited by anything, which is why they
   * are pinned here.
   */
  it('carries the grouped-control ARIA and a live aria-pressed', () => {
    const { el, suggestion, fixture } = render();
    const group = el.querySelector<HTMLElement>('[data-cy="tag-suggestions"]')!;
    const label = el.querySelector<HTMLElement>(`#${group.getAttribute('aria-labelledby')}`);

    expect(group.getAttribute('role')).toBe('group');
    expect(label?.textContent?.trim()).toBe('Suggestions');
    expect(suggestion('calculus').getAttribute('aria-pressed')).toBe('false');

    suggestion('calculus').click();
    fixture.detectChanges();

    expect(suggestion('calculus').getAttribute('aria-pressed')).toBe('true');
  });

  it('names every remove button after its own tag', () => {
    const { enter, el } = render();

    enter('calculus');

    expect(el.querySelector('[data-cy="remove-tag-calculus"]')?.getAttribute('aria-label')).toBe(
      'Remove tag calculus',
    );
  });
});

describe('TagSelectorComponent — unavailable', () => {
  it('says why rather than leaving a greyed-out box to be interpreted', () => {
    const { host, fixture, input, feedback } = render();
    host.disabledReason.set('Offline games cannot be filtered by topic.');
    fixture.detectChanges();

    expect(input().disabled).toBe(true);
    expect(feedback()).toBe('Offline games cannot be filtered by topic.');
  });

  /**
   * The shortcuts are **absent** rather than present-and-disabled while the
   * control is unavailable, which is a performance decision as much as a tidy
   * one: the home route renders this filter on first paint with the source
   * defaulting to Open Trivia — a state that disables it — so forty buttons
   * nobody can press would sit inside the card Lighthouse measures as the
   * largest contentful paint.
   */
  it('offers no shortcuts at all while it is unavailable', () => {
    const { host, fixture, el } = render();
    host.disabledReason.set('Not here.');
    fixture.detectChanges();

    expect(el.querySelector('[data-cy="tag-suggestions"]')).toBeNull();
  });

  it('accepts nothing typed while it is unavailable', () => {
    const { host, fixture, enter } = render();
    host.disabledReason.set('Not here.');
    fixture.detectChanges();

    enter('calculus');

    expect(host.control.value).toEqual([]);
  });

  it('follows the form control being disabled, not only its own input', () => {
    const { host, fixture, input } = render();

    host.control.disable();
    fixture.detectChanges();

    expect(input().disabled).toBe(true);
  });
});
