import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  forwardRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import {
  MAX_TAGS_PER_QUESTION,
  MAX_TAG_LENGTH,
  MIN_TAG_LENGTH,
  foldTag,
  normalizeTag,
} from '../../utils/normalize-tag.util';
import { QUESTION_TAG_SUGGESTIONS } from '../../utils/tag-suggestions';
import { IconComponent } from '../icon/icon.component';

/** Everything a suggestion chip wears in both states — see `suggestionClass()`. */
const SUGGESTION_BASE_CLASS =
  'rounded-full border px-2.5 py-0.5 text-xs font-medium ' +
  'disabled:cursor-not-allowed disabled:opacity-50 transition-colors';

/**
 * How long a deferred shortcut row waits for an idle moment, and what it does
 * instead where `requestIdleCallback` does not exist (Safari before 18.4).
 * The same bounds `App` gives the auth bootstrap, for the same reason: idle is
 * a promise the browser need never keep, so it is bounded.
 */
const SUGGESTIONS_IDLE_TIMEOUT_MS = 2_000;
const SUGGESTIONS_IDLE_FALLBACK_MS = 500;

/**
 * The tag picker (`FEAT-021`), shared by everything that chooses tags: the
 * contribute form, `/my-questions`' edit dialog, and the setup screen's topic
 * picker — which, since topics replaced categories (`FEAT-052`), is the only
 * topic choice a game has.
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
 * is surprised by what lands, because what lands is what they can see. The
 * feedback line under the input previews the normalised form while it is being
 * typed, which is the same promise a beat earlier.
 *
 * A refusal says which it is: too short (nothing usable left), too long, or —
 * where the caller restricts the choice — not one of the tags on offer. Silence
 * would be the cheaper implementation and the worse one — a chip that simply
 * does not appear reads as a broken control.
 *
 * ## The two constraints a caller can set
 *
 * - **`max`**, and at one the picker is a single choice: picking another tag
 *   *replaces* the one chosen rather than being refused at a limit of one,
 *   which is how the category `<select>` this replaces behaved.
 * - **`allowedTags`**, for the setup screen's Open Trivia game, whose API can
 *   only be asked for one of the seed tags. A typed tag outside the set is
 *   refused with the caller's reason, the way a malformed one is.
 *
 * A constraint that tightens under a selection is the caller's to apply,
 * through {@link replaceSelection}: which tags survive is the caller's policy
 * (the setup screen keeps the first seed tag), while saying what was removed —
 * in the feedback line and from the live region — is this component's, so it
 * is said the same way every other change here is.
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
 * - Adding, removing, replacing and refusing a chip are announced from a
 *   `role="status"` region that is **rendered from first paint** and has its
 *   text swapped in: a live region inserted while already carrying its message
 *   is routinely missed (finding G3).
 * - A required picker says nothing about being optional, carries
 *   `aria-required`, and names its error from the input's `aria-describedby`,
 *   the same contract as every other field on the question form.
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
 * rest scrolls. The hint line and the feedback line are reserved the same way,
 * each at the height of the tallest thing it can carry rather than of the one
 * it is carrying — every string the caller says it may pass, stacked invisibly
 * in one grid cell, because a line that changes changes how many lines it
 * wraps to.
 *
 * The shortcut row is the same: a fixed-height strip rendered from first paint.
 * Where the caller defers it — the setup screen, whose card is the home route's
 * largest contentful paint — the strip is **empty** on the first frame and is
 * filled on the first idle moment or the first focus inside the picker,
 * whichever comes first. The chips land in a box that is already there, so
 * nothing below it moves (§4.4's first technique).
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

  /**
   * Whether the caller requires at least one tag — the contribute form, since a
   * question's tags are its only topic (`FEAT-052`). The picker cannot enforce
   * it, because the form owns the value and its validity; this decides what the
   * label promises and what `aria-required` tells a screen reader.
   */
  readonly required = input(false);

  /**
   * The caller's error for this field, or `null`. Rendered under the input and
   * named in its `aria-describedby`, the contract every field on the question
   * form keeps — the picker cannot read the form control's validity itself.
   */
  readonly errorMessage = input<string | null>(null);

  /** One line under the label saying what the control is for. */
  readonly hint = input('');

  /**
   * Every hint this instance can be given, including the current one.
   *
   * Nothing reads them — they **reserve the hint line's height**, stacked
   * invisibly in one grid cell so the line is as tall as the tallest of them
   * rather than as whichever is showing (`CLAUDE.md` §4.4). A hint that changes
   * changes the line's *wrapping*, not its presence, which is the shape that
   * moves everything below it at one viewport and nothing at another.
   *
   * Left empty by a caller whose hint never changes, which costs it nothing.
   */
  readonly hintVariants = input<readonly string[]>([]);

  /**
   * How many tags may be selected. Eight on a question, because that is what
   * `firestore.rules` stores; ten on the setup screen's picker, because that is
   * what the query builder will send; and one for an Open Trivia game, which
   * makes this a single choice — see {@link add}.
   */
  readonly max = input(MAX_TAGS_PER_QUESTION);

  /** The shortcuts offered. A hint, never a gate — see `tag-suggestions.ts`. */
  readonly suggestions = input<readonly string[]>(QUESTION_TAG_SUGGESTIONS);

  /**
   * The only tags that may be chosen, or `null` for any tag at all.
   *
   * Set by the setup screen for an Open Trivia game, whose API can be asked for
   * one of the seed tags and nothing else: a tag outside the set would be a
   * selection the draw silently ignores, which is the failure `FEAT-021`
   * refused to ship. It is refused instead, out loud.
   */
  readonly allowedTags = input<readonly string[] | null>(null);

  /** What the feedback line and the live region say about a tag outside {@link allowedTags}. */
  readonly notAllowedMessage = input('That topic is not on offer here.');

  /**
   * Every message beyond the built-in ones that the feedback line may be asked
   * to carry — the caller's {@link notAllowedMessage} and the notices it passes
   * to {@link replaceSelection} — so the line is reserved at the tallest of
   * them, exactly as {@link hintVariants} reserves the hint.
   */
  readonly feedbackVariants = input<readonly string[]>([]);

  /**
   * Keep the shortcut row empty until the first idle moment or the first focus
   * inside the picker.
   *
   * For the setup screen, whose card Lighthouse measures as the home route's
   * largest contentful paint: rendering the shortcuts with the first frame put
   * the median LCP at 4.0 s against 3.7 s without them, on a four-core box over
   * three runs each. Deferred, they cost the first paint nothing — and the
   * strip they land in is the same fixed height either way, so arriving late
   * moves nothing.
   */
  readonly deferSuggestions = input(false);

  /** The selected tags. Written by the form; read by the template. */
  protected readonly tags = signal<readonly string[]>([]);

  /** What is in the text box right now. */
  protected readonly draft = signal('');

  /** Set by `setDisabledState`, which is Angular's half of the disabled state. */
  private readonly formDisabled = signal(false);

  /** The last thing that happened, for the live region. */
  protected readonly announcement = signal('');

  /**
   * A sentence about a change the reader did not make with their own keys —
   * {@link replaceSelection}'s — shown in the feedback line until the next
   * thing they do here.
   */
  protected readonly notice = signal<string | null>(null);

  /** Whether a deferred shortcut row has been filled yet. */
  private readonly suggestionsFilled = signal(false);

  protected readonly minTagLength = MIN_TAG_LENGTH;
  protected readonly maxTagLength = MAX_TAG_LENGTH;

  protected readonly isDisabled = computed(() => this.formDisabled());

  protected readonly isFull = computed(() => this.tags().length >= this.max());

  /** A single choice: picking another tag replaces the chosen one. */
  protected readonly replacesOnAdd = computed(() => this.max() === 1);

  /** Whether another tag can be added, or swapped in for the one there is. */
  protected readonly canTakeMore = computed(() => !this.isFull() || this.replacesOnAdd());

  /** Whether the shortcut chips are in the strip yet. The strip itself always is. */
  protected readonly showSuggestionChips = computed(
    () => !this.deferSuggestions() || this.suggestionsFilled(),
  );

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

  /**
   * Which bound a rejected draft hit, judged on the **folded** text. Folding can
   * lengthen it — `ß` is `ss` once folded — so a draft typed inside the cap can
   * still fold past it, and measuring what was typed would tell its writer
   * their tag had too few letters (`CLAUDE.md` §4.4).
   */
  protected readonly draftTooLong = computed(() => foldTag(this.draft()).length > MAX_TAG_LENGTH);

  /** The draft is a well-formed tag the caller does not offer here. */
  protected readonly draftNotAllowed = computed(() => {
    const preview = this.draftPreview();
    return preview !== null && !this.isAllowed(preview);
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (!this.deferSuggestions()) {
        return;
      }
      // Torn down with the component (`CLAUDE.md` §4.4): the setup screen is
      // left for `/play` well inside two seconds by a reader who presses Start
      // straight away, and a callback outliving the view would write to a
      // signal nothing renders.
      if (typeof requestIdleCallback === 'function') {
        const handle = requestIdleCallback(() => this.fillSuggestions(), {
          timeout: SUGGESTIONS_IDLE_TIMEOUT_MS,
        });
        destroyRef.onDestroy(() => cancelIdleCallback(handle));
      } else {
        const handle = setTimeout(() => this.fillSuggestions(), SUGGESTIONS_IDLE_FALLBACK_MS);
        destroyRef.onDestroy(() => clearTimeout(handle));
      }
    });
  }

  /**
   * Puts the shortcut chips into their strip. Called on the first idle moment,
   * and on the first focus or press inside the picker — a reader reaching for
   * the control should never find the strip empty.
   */
  protected fillSuggestions(): void {
    this.suggestionsFilled.set(true);
  }

  protected isSelected(tag: string): boolean {
    return this.tags().includes(tag);
  }

  private isAllowed(tag: string): boolean {
    const allowed = this.allowedTags();
    return allowed === null || allowed.includes(tag);
  }

  /**
   * One class string per suggestion rather than a dozen `[class.x]` bindings.
   *
   * The difference is roughly two dozen binding slots against three hundred on
   * the setup screen, which renders this control inside the home route's
   * largest contentful paint — the same shape as the quiz loop's
   * `answerClass()`, and for the same reason.
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

  /**
   * Replaces the selection on the caller's behalf, and says so.
   *
   * For a constraint that tightens under a selection — the setup screen
   * switching to Open Trivia keeps the first seed tag and drops the rest
   * (`FEAT-052`). The caller decides which tags survive; this writes them to
   * the form, shows `notice` in the feedback line until the reader next does
   * something here, and speaks `announcement` from the live region every other
   * change here is announced from.
   */
  replaceSelection(tags: readonly string[], notice: string, announcement: string): void {
    this.commit([...tags]);
    this.notice.set(notice);
    this.announcement.set(announcement);
  }

  /** Withdraws a {@link replaceSelection} notice that no longer describes the control. */
  clearNotice(): void {
    this.notice.set(null);
  }

  private onChange: (value: string[]) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(value: unknown): void {
    // Defensive rather than trusting: `reset()` writes `null` when a control has
    // no default, and a form patched from a stored document hands over whatever
    // Firestore held. Neither is this component's to assume.
    this.tags.set(Array.isArray(value) ? value.filter((tag) => typeof tag === 'string') : []);
    this.draft.set('');
    this.notice.set(null);
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

  /** The input's description: its error first when there is one, because it is the part needed. */
  protected describedBy(): string {
    return this.errorMessage()
      ? `${this.id('tag-error')} ${this.id('tag-feedback')}`
      : this.id('tag-feedback');
  }

  protected onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
    this.notice.set(null);
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
        this.draftTooLong()
          ? `"${raw}" is too long — a tag is at most ${MAX_TAG_LENGTH} characters.`
          : `"${raw}" has no tag in it — a tag needs at least ${MIN_TAG_LENGTH} letters or digits.`,
      );
      return;
    }
    if (!this.isAllowed(tag)) {
      // Left in the box, like a malformed draft: the feedback line keeps saying
      // why while the reader decides what to do with it.
      this.announcement.set(`#${tag} was not added. ${this.notAllowedMessage()}`);
      return;
    }
    this.draft.set('');
    this.add(tag);
  }

  /**
   * Adds a tag — or, in a single choice, swaps it in for the one there is.
   *
   * Replacing rather than refusing at a limit of one is what the category
   * `<select>` the setup screen's Open Trivia game used to have did: choosing
   * another option changed the choice. A limit of one that answered "that is
   * the maximum" would make the reader remove a topic before picking the one
   * they meant.
   */
  protected add(tag: string): void {
    if (this.isDisabled()) {
      return;
    }
    this.notice.set(null);
    if (!this.isAllowed(tag)) {
      this.announcement.set(`#${tag} was not added. ${this.notAllowedMessage()}`);
      return;
    }
    if (this.tags().includes(tag)) {
      this.announcement.set(`${tag} is already added.`);
      return;
    }
    if (this.replacesOnAdd() && this.tags().length > 0) {
      const replaced = this.tags()[0];
      this.commit([tag]);
      this.announcement.set(`Replaced ${replaced} with ${tag}.`);
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
    this.notice.set(null);
    this.commit(this.tags().filter((existing) => existing !== tag));
    this.announcement.set(`Removed ${tag}. ${this.tags().length} of ${this.max()}.`);
  }

  private commit(tags: string[]): void {
    this.tags.set(tags);
    this.onTouched();
    this.onChange(tags);
  }
}
