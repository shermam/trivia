import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  input,
  signal,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import {
  MAX_TAGS_PER_QUESTION,
  MAX_TAG_LENGTH,
  MIN_TAG_LENGTH,
  normalizeTag,
} from '../../utils/normalize-tag.util';
import { TAG_SUGGESTIONS } from '../../utils/tag-suggestions';
import { IconComponent } from '../icon/icon.component';

/** Everything a suggestion chip wears in both states — see `suggestionClass()`. */
const SUGGESTION_BASE_CLASS =
  'rounded-full border px-2.5 py-0.5 text-xs font-medium ' +
  'disabled:cursor-not-allowed disabled:opacity-50 transition-colors';

/**
 * The tag picker (`FEAT-021`), shared by everything that chooses tags: the
 * contribute form, `/my-questions`' edit dialog, and the setup screen's filter.
 *
 * **One component for all three, and the edit dialog is the reason it matters.**
 * `FEAT-007` lets an author resubmit their own question, and an owner update
 * re-validates the *whole* payload — so a dialog that could not show the tags
 * would silently drop them on every edit. Sharing the picker makes that
 * impossible rather than merely unlikely.
 *
 * ## What it is, as a control
 *
 * A `ControlValueAccessor` over a `string[]`, so a caller writes
 * `formControlName="tags"` and the form owns the value — which is what keeps
 * `form.invalid`, `reset()` and `patchValue()` working the way every other
 * field on the question form does. The alternative, a two-way `model()`, would
 * have needed the host to mirror the value back by hand and would have missed
 * the `reset()` the edit dialog performs on every open.
 *
 * ## Where the normaliser shows up
 *
 * Every route in — typing, pressing a suggestion, pasting — goes through
 * `normalizeTag`, and the chip that appears is what would be **stored**. Nobody
 * is surprised by what lands, because what lands is what they can see. The hint
 * under the input previews the normalised form while it is being typed, which
 * is the same promise a beat earlier.
 *
 * A refusal says which of the two it is: too short (nothing usable left) or too
 * long. Silence would be the cheaper implementation and the worse one — a chip
 * that simply does not appear reads as a broken control.
 *
 * ## Accessibility (`CLAUDE.md` §4.5)
 *
 * - The chips are a `<ul>` with an accessible name, each with a **remove
 *   button** whose name includes the tag — "Remove tag world-war-2" — because
 *   eight buttons all called "Remove" are eight identical rows in a screen
 *   reader's list.
 * - The suggestions are toggle buttons in a `role="group"` with
 *   `aria-labelledby`, each carrying `aria-pressed`. A grouped control has to
 *   convey the group, and a toggle has to convey its state. They are deliberately
 *   **not** a `listbox`: a listbox owes a roving `tabindex` and typeahead, and
 *   buying that complexity for a row of optional shortcuts would be paying for a
 *   pattern nobody asked for — plain buttons are reachable with Tab and pressed
 *   with Enter or Space, which is the whole interaction.
 * - Adding, removing and refusing a chip are announced from a `role="status"`
 *   region that is **rendered from first paint** and has its text swapped in: a
 *   live region inserted while already carrying its message is routinely missed
 *   (finding G3).
 * - Backspace on an empty input removes the last chip, the convention every
 *   token field shares. It is a shortcut, never the only way: each chip has its
 *   own button.
 *
 * ## Layout stability (`CLAUDE.md` §4.4)
 *
 * The chip row is rendered **always**, empty until it has content, and it
 * **scrolls inside a fixed box** rather than growing. Eight chips wrap to three
 * lines on a phone, and on the setup screen that would push the Start button
 * down the screen as the reader picks topics — which is the exact shape §4.4
 * exists for. The box is two chip-rows tall, which is the common case, and the
 * rest scrolls.
 */
@Component({
  selector: 'app-tag-selector',
  standalone: true,
  imports: [IconComponent, NgClass],
  templateUrl: './tag-selector.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => TagSelectorComponent),
      multi: true,
    },
  ],
})
export class TagSelectorComponent implements ControlValueAccessor {
  /** Prefix for every DOM id here, since an id is global (see `QuestionFieldsComponent`). */
  readonly idPrefix = input('');

  /** The visible label above the control. */
  readonly label = input('Tags');

  /** One line under the label saying what the control is for. */
  readonly hint = input('');

  /**
   * How many tags may be selected. Eight on a question, because that is what
   * `firestore.rules` stores; ten on the setup screen's filter, because that is
   * what the query builder will send.
   */
  readonly max = input(MAX_TAGS_PER_QUESTION);

  /** The shortcuts offered. A hint, never a gate — see `tag-suggestions.ts`. */
  readonly suggestions = input<readonly string[]>(TAG_SUGGESTIONS);

  /**
   * Why the control is unavailable, or `null` when it is available.
   *
   * A reason rather than a boolean: the two states that disable this — an
   * offline game and an Open Trivia DB source — are both states the reader can
   * *fix*, and a greyed-out box that does not say why is a dead end. The
   * `disabled` attribute follows from the reason being present, so the two
   * cannot disagree.
   */
  readonly disabledReason = input<string | null>(null);

  /** The selected tags. Written by the form; read by the template. */
  protected readonly tags = signal<readonly string[]>([]);

  /** What is in the text box right now. */
  protected readonly draft = signal('');

  /** Set by `setDisabledState`, which is Angular's half of the disabled state. */
  private readonly formDisabled = signal(false);

  /** The last thing that happened, for the live region. */
  protected readonly announcement = signal('');

  protected readonly minTagLength = MIN_TAG_LENGTH;
  protected readonly maxTagLength = MAX_TAG_LENGTH;

  protected readonly isDisabled = computed(() => this.formDisabled() || !!this.disabledReason());

  protected readonly isFull = computed(() => this.tags().length >= this.max());

  /**
   * What the current draft would be stored as, or `null` while there is nothing
   * usable in it. Shown under the input so the normalisation is visible before
   * the chip is committed rather than after.
   */
  protected readonly draftPreview = computed(() => {
    const draft = this.draft().trim();
    return draft.length === 0 ? null : normalizeTag(draft);
  });

  /** The draft is long enough to have been meant, and still cannot be stored. */
  protected readonly draftRejected = computed(
    () => this.draft().trim().length > 0 && this.draftPreview() === null,
  );

  protected isSelected(tag: string): boolean {
    return this.tags().includes(tag);
  }

  /**
   * One class string per suggestion rather than a dozen `[class.x]` bindings.
   *
   * The setup screen renders this control on first paint with the whole starter
   * list in it, so the difference is roughly forty binding slots against five
   * hundred — a measurable share of the home route's Lighthouse performance
   * budget, on a control most visitors never touch. Same shape as the quiz
   * loop's `answerClass()`, and for the same reason.
   */
  protected suggestionClass(tag: string): string {
    return this.isSelected(tag)
      ? `${SUGGESTION_BASE_CLASS} border-emerald-600 bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300`
      : `${SUGGESTION_BASE_CLASS} border-slate-900/10 dark:border-white/10 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300`;
  }

  /** What a suggestion button does: it is a toggle, so it removes as well as adds. */
  protected toggle(tag: string): void {
    if (this.isSelected(tag)) {
      this.remove(tag);
    } else {
      this.add(tag);
    }
  }

  private onChange: (value: string[]) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(value: unknown): void {
    // Defensive rather than trusting: `reset()` writes `null` when a control has
    // no default, and a form patched from a stored document hands over whatever
    // Firestore held. Neither is this component's to assume.
    this.tags.set(Array.isArray(value) ? value.filter((tag) => typeof tag === 'string') : []);
    this.draft.set('');
  }

  registerOnChange(fn: (value: string[]) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.formDisabled.set(isDisabled);
  }

  protected id(name: string): string {
    return `${this.idPrefix()}${name}`;
  }

  protected onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  /**
   * Enter and comma both commit, because both are what people type. The
   * `preventDefault` on Enter is load-bearing: without it the key submits the
   * whole question form, which is a very expensive way to add a tag.
   */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      this.commitDraft();
      return;
    }
    if (event.key === 'Backspace' && this.draft().length === 0 && this.tags().length > 0) {
      event.preventDefault();
      this.remove(this.tags()[this.tags().length - 1]);
    }
  }

  /**
   * Committing on blur as well as on Enter, because a half-typed tag left in
   * the box when the reader moves on to Save is a tag they believe they added.
   */
  protected onBlur(): void {
    this.onTouched();
    if (this.draft().trim().length > 0) {
      this.commitDraft();
    }
  }

  protected commitDraft(): void {
    const raw = this.draft().trim();
    if (raw.length === 0) {
      return;
    }
    const tag = normalizeTag(raw);
    if (!tag) {
      this.announcement.set(
        raw.length > MAX_TAG_LENGTH
          ? `"${raw}" is too long — a tag is at most ${MAX_TAG_LENGTH} characters.`
          : `"${raw}" has no tag in it — a tag needs at least ${MIN_TAG_LENGTH} letters or digits.`,
      );
      return;
    }
    this.draft.set('');
    this.add(tag);
  }

  protected add(tag: string): void {
    if (this.isDisabled()) {
      return;
    }
    if (this.tags().includes(tag)) {
      this.announcement.set(`${tag} is already added.`);
      return;
    }
    if (this.isFull()) {
      this.announcement.set(`That is the maximum of ${this.max()} tags.`);
      return;
    }
    this.commit([...this.tags(), tag]);
    this.announcement.set(`Added ${tag}. ${this.tags().length} of ${this.max()}.`);
  }

  protected remove(tag: string): void {
    if (this.isDisabled()) {
      return;
    }
    this.commit(this.tags().filter((existing) => existing !== tag));
    this.announcement.set(`Removed ${tag}. ${this.tags().length} of ${this.max()}.`);
  }

  private commit(tags: string[]): void {
    this.tags.set(tags);
    this.onTouched();
    this.onChange(tags);
  }
}
