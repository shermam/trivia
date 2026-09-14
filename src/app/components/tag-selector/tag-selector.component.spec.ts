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
    [hint]="hint()"
    [hintVariants]="hintVariants()"
  />`,
})
class HostComponent {
  readonly control = new FormControl<string[]>([], { nonNullable: true });
  readonly max = signal(8);
  readonly suggestions = signal<readonly string[]>(['world-war-2', 'calculus']);
  readonly disabledReason = signal<string | null>(null);
  readonly hint = signal('');
  readonly hintVariants = signal<readonly string[]>([]);
}

/**
 * `disabledReason` is settable **before the first render** as well as after,
 * because the two are different states rather than the same one reached twice:
 * the shortcut row is not rendered at all until the control has been available
 * once, which is what keeps forty buttons out of the home route's first paint.
 */
function render(initial: { disabledReason?: string | null } = {}) {
  const fixture = TestBed.createComponent(HostComponent);
  if (initial.disabledReason !== undefined) {
    fixture.componentInstance.disabledReason.set(initial.disabledReason);
  }
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
   * The shortcuts are **not rendered at all** until the control is first
   * available, which is a performance decision as much as a tidy one: the home
   * route renders this filter on first paint with the source defaulting to Open
   * Trivia — a state that disables it — so forty buttons nobody can press would
   * sit inside the card Lighthouse measures as the largest contentful paint.
   */
  it('renders no shortcuts at all until it is first available', () => {
    // Unavailable from the first render, which is the state the home route
    // paints — not "available, then disabled", which is a different state.
    const { el } = render({ disabledReason: 'Not here.' });

    expect(el.querySelector('[data-cy="tag-suggestions"]')).toBeNull();
  });

  /**
   * Once they have been rendered they **stay** rendered, collapsed and `inert`.
   * The row's height is what animates on the way out (`CLAUDE.md` §4.4), and
   * content removed in the same frame as the collapse leaves an empty box with
   * nothing to collapse — so the Start button would snap back up the screen
   * instead of gliding. `inert` is what keeps a row nobody can see out of the
   * tab order and out of the accessibility tree; nothing in jsdom enforces it,
   * so this asserts the attribute rather than the behaviour.
   */
  it('keeps the shortcuts mounted but out of reach once it becomes unavailable', () => {
    const { host, fixture, el } = render();

    expect(el.querySelector('[data-cy="tag-suggestions"]')).not.toBeNull();

    host.disabledReason.set('Not here.');
    fixture.detectChanges();

    const reveal = el.querySelector<HTMLElement>('[data-cy="tag-suggestions-reveal"]')!;
    expect(el.querySelector('[data-cy="tag-suggestions"]')).not.toBeNull();
    expect(reveal.getAttribute('inert')).toBe('');
    expect(reveal.className).toContain('grid-rows-[0fr]');
  });

  /**
   * The gate the whole animation hangs on. `npm run motion:verify` fails on an
   * ungated layout transition, but nothing checks that the transition is there
   * at all — and an un-animated reveal drops the Start button 108px in one
   * frame, which is invisible to jsdom, to Lighthouse and to a green e2e run
   * that never measures it. `tag-filter.spec.ts` measures the real thing in a
   * real browser; this pins the classes it depends on.
   */
  it('animates the reveal, gated on the reader not having asked for less motion', () => {
    const { host, fixture, el } = render({ disabledReason: 'Not here.' });
    const reveal = () => el.querySelector<HTMLElement>('[data-cy="tag-suggestions-reveal"]')!;

    expect(reveal().className).toContain('motion-safe:transition-[grid-template-rows]');
    expect(reveal().className).toContain('motion-safe:duration-');
    expect(reveal().className).toContain('grid-rows-[0fr]');

    host.disabledReason.set(null);
    fixture.detectChanges();

    expect(reveal().className).toContain('grid-rows-[1fr]');
    expect(reveal().getAttribute('inert')).toBeNull();
  });

  /**
   * The feedback line keeps the height of the *longest* message it can carry,
   * not of the current one — otherwise it loses a line at the same instant the
   * shortcut row expands, and the Start button hops upwards before gliding
   * down. jsdom has no layout, so what is asserted is the twin that reserves
   * the space; `tag-filter.spec.ts` measures the result.
   */
  it('keeps reserving the unavailability reason after it stops applying', () => {
    const reason = 'Only community questions carry topics.';
    const { host, fixture, el } = render({ disabledReason: reason });
    const twin = () => el.querySelector<HTMLElement>('[data-cy="tag-feedback-reserve"]');

    expect(twin()?.textContent?.trim()).toBe(reason);
    expect(twin()?.getAttribute('aria-hidden')).toBe('true');

    host.disabledReason.set(null);
    fixture.detectChanges();

    expect(twin()?.textContent?.trim()).toBe(reason);
  });

  /** …and costs nothing at all where no reason is ever given, which is both question forms. */
  it('reserves nothing extra where the control is never unavailable', () => {
    const { el } = render();

    expect(el.querySelector('[data-cy="tag-feedback-reserve"]')?.textContent?.trim()).toBe('');
  });

  /**
   * The hint line is reserved at the tallest hint the caller can pass rather
   * than at the one showing. A hint that *changes* changes how many lines it
   * wraps to, which is a resize the reader sees as everything below the control
   * jumping — and unlike the feedback line, the previous value is no use here,
   * because the taller of the two can be the one that has not been shown yet.
   * jsdom has no layout, so this pins the twins; `tag-filter.spec.ts` measures
   * what they are worth.
   */
  it('stacks an invisible copy of every hint it may be given', () => {
    const variants = ['The short one.', 'The considerably longer one, which wraps.'];
    const { host, fixture, el } = render();
    host.hint.set(variants[0]);
    host.hintVariants.set(variants);
    fixture.detectChanges();

    const twins = [...el.querySelectorAll<HTMLElement>('[data-cy="tag-hint-reserve"]')];

    expect(twins.map((twin) => twin.textContent?.trim())).toEqual(variants);
    expect(twins.every((twin) => twin.getAttribute('aria-hidden') === 'true')).toBe(true);
    // Same grid cell as the visible line, which is what makes the cell as tall
    // as the tallest of them rather than as tall as all of them stacked.
    expect(twins.every((twin) => twin.className.includes('row-start-1'))).toBe(true);
    expect(el.querySelector('[data-cy="tag-hint"]')?.className).toContain('row-start-1');

    // The hint the reader sees still follows the input it was given.
    host.hint.set(variants[1]);
    fixture.detectChanges();
    expect(el.querySelector('[data-cy="tag-hint"]')?.textContent?.trim()).toBe(variants[1]);
  });

  /** …and a caller whose hint never changes reserves nothing extra for it. */
  it('stacks no copies for a hint that cannot change', () => {
    const { host, fixture, el } = render();
    host.hint.set('A few words for what this question is about.');
    fixture.detectChanges();

    expect(el.querySelectorAll('[data-cy="tag-hint-reserve"]')).toHaveLength(0);
    expect(el.querySelector('[data-cy="tag-hint"]')?.textContent?.trim()).toBe(
      'A few words for what this question is about.',
    );
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
