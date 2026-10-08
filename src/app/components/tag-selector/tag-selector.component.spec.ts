import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { afterEach, vi } from 'vitest';
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
    [allowedTags]="allowedTags()"
    [notAllowedMessage]="notAllowedMessage()"
    [feedbackVariants]="feedbackVariants()"
    [required]="required()"
    [errorMessage]="errorMessage()"
    [deferSuggestions]="deferSuggestions()"
    [hint]="hint()"
    [hintVariants]="hintVariants()"
  />`,
})
class HostComponent {
  readonly control = new FormControl<string[]>([], { nonNullable: true });
  readonly max = signal(8);
  readonly suggestions = signal<readonly string[]>(['world-war-2', 'calculus']);
  readonly allowedTags = signal<readonly string[] | null>(null);
  readonly notAllowedMessage = signal('Only the suggested topics work here.');
  readonly feedbackVariants = signal<readonly string[]>([]);
  readonly required = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly deferSuggestions = signal(false);
  readonly hint = signal('');
  readonly hintVariants = signal<readonly string[]>([]);
  readonly picker = viewChild.required(TagSelectorComponent);
}

/**
 * `deferSuggestions` is settable **before the first render**, because a
 * deferred strip and an immediate one are different first frames rather than
 * the same one reached twice — which is the whole point of deferring.
 */
function render(initial: { deferSuggestions?: boolean } = {}) {
  const fixture = TestBed.createComponent(HostComponent);
  if (initial.deferSuggestions !== undefined) {
    fixture.componentInstance.deferSuggestions.set(initial.deferSuggestions);
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

describe('TagSelectorComponent — a single choice', () => {
  /**
   * At a limit of one the picker behaves like the category `<select>` it
   * replaced on the setup screen's Open Trivia game: choosing another option
   * changes the choice. Refusing at the limit instead would make the reader
   * remove a topic before picking the one they meant.
   */
  it('replaces the chosen tag rather than refusing a second one', () => {
    const { host, fixture, suggestion, status } = render();
    host.max.set(1);
    fixture.detectChanges();

    suggestion('world-war-2').click();
    fixture.detectChanges();
    suggestion('calculus').click();
    fixture.detectChanges();

    expect(host.control.value).toEqual(['calculus']);
    expect(status()).toBe('Replaced world-war-2 with calculus.');
    expect(suggestion('world-war-2').getAttribute('aria-pressed')).toBe('false');
    expect(suggestion('calculus').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps every suggestion pressable while one is chosen', () => {
    const { host, fixture, suggestion, input } = render();
    host.max.set(1);
    fixture.detectChanges();

    suggestion('calculus').click();
    fixture.detectChanges();

    expect(suggestion('world-war-2').disabled).toBe(false);
    expect(input().disabled).toBe(false);
  });

  it('replaces from the text box too', () => {
    const { host, fixture, enter } = render();
    host.max.set(1);
    fixture.detectChanges();

    enter('calculus');
    enter('world war 2');

    expect(host.control.value).toEqual(['world-war-2']);
  });
});

describe('TagSelectorComponent — a restricted choice', () => {
  /**
   * The setup screen's Open Trivia game can be asked for a seed tag and nothing
   * else, so a typed tag outside the set is refused **out loud** — a selection
   * the draw silently ignored is the failure `FEAT-021` refused to ship.
   */
  it('refuses a typed tag outside the allowed set, and says why', () => {
    const { host, fixture, enter, feedback, status } = render();
    host.allowedTags.set(['world-war-2', 'calculus']);
    fixture.detectChanges();

    enter('Cold War');

    expect(host.control.value).toEqual([]);
    expect(feedback()).toBe('Only the suggested topics work here.');
    expect(status()).toBe('#cold-war was not added. Only the suggested topics work here.');
  });

  it('says so while the draft is still being typed, and offers no Add', () => {
    const { host, fixture, type, feedback, el } = render();
    host.allowedTags.set(['calculus']);
    fixture.detectChanges();

    type('algebra');

    expect(feedback()).toBe('Only the suggested topics work here.');
    expect(el.querySelector<HTMLButtonElement>('[data-cy="add-tag"]')?.disabled).toBe(true);
  });

  it('takes a tag inside the set as it always did', () => {
    const { host, fixture, enter } = render();
    host.allowedTags.set(['calculus']);
    fixture.detectChanges();

    enter('Calculus');

    expect(host.control.value).toEqual(['calculus']);
  });
});

describe('TagSelectorComponent — a change the caller makes', () => {
  /**
   * The setup screen switching to Open Trivia keeps the first seed tag and
   * drops the rest. Which survive is the caller's policy; saying what went is
   * this component's, from the same feedback line and live region every other
   * change here uses.
   */
  it('writes the replacement to the form, shows the notice and announces it', () => {
    const { host, fixture, enter, feedback, status } = render();
    enter('cold-war');
    enter('calculus');

    host.picker().replaceSelection(['calculus'], 'One topic only here.', 'Removed #cold-war.');
    fixture.detectChanges();

    expect(host.control.value).toEqual(['calculus']);
    expect(feedback()).toBe('One topic only here.');
    expect(status()).toBe('Removed #cold-war.');
  });

  it('withdraws the notice at the reader’s next move', () => {
    const { host, fixture, type, feedback } = render();

    host.picker().replaceSelection([], 'One topic only here.', 'Removed everything.');
    fixture.detectChanges();
    type('alg');
    type('');

    expect(feedback()).toBe('0 of 8 chosen.');
  });

  it('withdraws it when the caller says it no longer applies', () => {
    const { host, fixture, feedback } = render();

    host.picker().replaceSelection([], 'One topic only here.', 'Removed everything.');
    fixture.detectChanges();
    host.picker().clearNotice();
    fixture.detectChanges();

    expect(feedback()).toBe('0 of 8 chosen.');
  });
});

describe('TagSelectorComponent — required', () => {
  /**
   * A question's tags are its only topic (`FEAT-052`), so the contribute form
   * requires one. The label stops promising the field is optional, and the
   * error is named from the input like every other field's on that form.
   */
  it('stops calling itself optional and tells assistive tech it is required', () => {
    const { host, fixture, el, input } = render();

    expect(el.querySelector('label')?.textContent).toContain('(optional)');
    expect(input().getAttribute('aria-required')).toBeNull();

    host.required.set(true);
    fixture.detectChanges();

    expect(el.querySelector('label')?.textContent).not.toContain('(optional)');
    expect(input().getAttribute('aria-required')).toBe('true');
  });

  it('renders the caller’s error and names it first in the input’s description', () => {
    const { host, fixture, el, input } = render();
    host.errorMessage.set('Add at least one topic.');
    fixture.detectChanges();

    const error = el.querySelector<HTMLElement>('[data-cy="tag-error"]')!;
    expect(error.textContent?.trim()).toBe('Add at least one topic.');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-describedby')).toBe(`${error.id} tag-feedback`);
  });
});

describe('TagSelectorComponent — the shortcut strip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The strip is a fixed-height box from first paint whether or not its chips
   * are in it, which is what lets them arrive late without moving anything
   * below (`CLAUDE.md` §4.4). jsdom has no layout, so what is pinned is that
   * the box and its height class are there before the chips are;
   * `tag-filter.spec.ts` measures the result in a browser.
   */
  it('renders the strip, empty, on the first frame when deferred', () => {
    const { el } = render({ deferSuggestions: true });
    const strip = el.querySelector<HTMLElement>('[data-cy="tag-suggestions"]');

    expect(strip).not.toBeNull();
    expect(strip?.className).toContain('h-20');
    expect(strip?.querySelectorAll('button')).toHaveLength(0);
  });

  /**
   * jsdom has no `requestIdleCallback`, so this exercises the bounded
   * `setTimeout` fallback a browser without one takes — and fakes only the
   * timer pair, so the idle API stays as absent as it really is here.
   */
  it('fills it on the first idle moment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { el, fixture } = render({ deferSuggestions: true });

    await vi.advanceTimersByTimeAsync(2_000);
    fixture.detectChanges();

    expect(el.querySelectorAll('[data-cy="tag-suggestions"] button')).toHaveLength(2);
  });

  /** A reader reaching for the control must never find the strip empty. */
  it('fills it at once on the first focus inside the picker', () => {
    const { el, input, fixture } = render({ deferSuggestions: true });

    input().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    fixture.detectChanges();

    expect(el.querySelectorAll('[data-cy="tag-suggestions"] button')).toHaveLength(2);
  });

  it('renders the chips with the first frame when not deferred', () => {
    const { el } = render();

    expect(el.querySelectorAll('[data-cy="tag-suggestions"] button')).toHaveLength(2);
  });
});

describe('TagSelectorComponent — reserved lines', () => {
  /**
   * The hint line is reserved at the tallest hint the caller can pass rather
   * than at the one showing. A hint that *changes* changes how many lines it
   * wraps to, which is a resize the reader sees as everything below the control
   * jumping. jsdom has no layout, so this pins the twins; `tag-filter.spec.ts`
   * measures what they are worth.
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

  /**
   * The feedback line the same way: a notice about a source switch, or a
   * refusal of a tag the caller does not offer, can wrap further than the
   * count it replaces, and the line must not grow under the reader when it
   * arrives.
   */
  it('stacks an invisible copy of every feedback message the caller may need', () => {
    const variants = ['Removed the topics this game cannot play.', 'Only the suggested topics.'];
    const { host, fixture, el } = render();
    host.feedbackVariants.set(variants);
    fixture.detectChanges();

    const twins = [...el.querySelectorAll<HTMLElement>('[data-cy="tag-feedback-reserve"]')];

    expect(twins.map((twin) => twin.textContent?.trim())).toEqual(variants);
    expect(twins.every((twin) => twin.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(twins.every((twin) => twin.className.includes('row-start-1'))).toBe(true);
  });
});

describe('TagSelectorComponent — disabled by its form', () => {
  it('follows the form control being disabled, not only its own input', () => {
    const { host, fixture, input } = render();

    host.control.disable();
    fixture.detectChanges();

    expect(input().disabled).toBe(true);
  });

  it('accepts nothing typed while disabled', () => {
    const { host, fixture, enter } = render();
    host.control.disable();
    fixture.detectChanges();

    enter('calculus');

    expect(host.control.value).toEqual([]);
  });
});
