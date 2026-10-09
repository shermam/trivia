import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { AvatarChoice } from '../../models/avatar.model';
import { builtAvatar } from './built-avatar';

/** `sm` is the account chip's, `md` the picker's options, `lg` the profile header's. */
export type AvatarSize = 'sm' | 'md' | 'lg';

/**
 * One avatar, rendered the same way wherever it appears — the account chip,
 * the profile header, the picker's options and any surface added later
 * (`FEAT-038`). The fallback chain and the reserved box exist here once.
 *
 * **The box is the host element, and nothing inside it is in flow but the
 * letter.** Its size comes from `size` alone; the built avatar and the photo
 * are absolutely positioned over it. So every state — the stored choice not
 * read yet, initials, a photo still loading, a photo, a built avatar — occupies
 * exactly the same box, by construction rather than by measurement
 * (`CLAUDE.md` §4.4). That matters most in the chip, where three earlier
 * resizes were real defects.
 *
 * **Initials until the picture is there, and initials when it never comes.**
 * A photo is laid over the letter and kept `invisible` until `load` fires, so
 * there is never an empty or half-drawn frame; on `error` the image is removed
 * outright, so a revoked, rate-limited or offline photo leaves the initials
 * and no broken-image icon. An avatar is not worth an error state.
 *
 * **Decorative, and hidden from assistive tech.** Every surface puts the name
 * beside it — the chip's accessible name, the page heading — so the image is
 * `alt=""` and the host `aria-hidden`.
 */
@Component({
  selector: 'app-avatar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
    class: 'relative flex shrink-0 items-center justify-center rounded-full font-bold',
    '[class.h-7]': "size() === 'sm'",
    '[class.w-7]': "size() === 'sm'",
    '[class.text-xs]': "size() === 'sm'",
    '[class.h-10]': "size() === 'md'",
    '[class.w-10]': "size() === 'md'",
    '[class.text-sm]': "size() === 'md'",
    '[class.h-12]': "size() === 'lg'",
    '[class.w-12]': "size() === 'lg'",
    '[class.text-lg]': "size() === 'lg'",
    '[class.bg-emerald-700]': 'letter() !== null',
    '[class.text-white]': 'letter() !== null',
    '[class.bg-slate-200]': 'letter() === null',
    '[class.text-slate-500]': 'letter() === null',
    '[class.dark:bg-slate-700]': 'letter() === null',
    '[class.dark:text-slate-400]': 'letter() === null',
    '[attr.data-avatar]': 'shown()',
  },
  template: `
    @if (letter() !== null) {
      <span [class.invisible]="covered()">{{ letter() }}</span>
      @if (built(); as variant) {
        <svg viewBox="0 0 32 32" focusable="false" class="absolute inset-0 h-full w-full">
          <circle cx="16" cy="16" r="16" [attr.fill]="variant.palette.background" />
          <path
            [attr.d]="variant.shape.d"
            [attr.fill]="variant.palette.foreground"
            [attr.fill-rule]="variant.shape.evenOdd ? 'evenodd' : null"
          />
        </svg>
      }
      @if (imageUrl(); as url) {
        <!--
          loading is bound before src so the browser has it when the request
          is decided, and referrerpolicy is static for the same reason: Google's
          image server is told nothing about which page asked.
        -->
        <img
          alt=""
          referrerpolicy="no-referrer"
          decoding="async"
          [attr.loading]="eager() ? 'eager' : 'lazy'"
          [src]="url"
          class="absolute inset-0 h-full w-full rounded-full object-cover"
          [class.invisible]="loadedUrl() !== url"
          (load)="loadedUrl.set(url)"
          (error)="failedUrl.set(url)"
        />
      }
    } @else {
      <span>&#128100;</span>
    }
    <ng-content />
  `,
})
export class AvatarComponent {
  readonly size = input<AvatarSize>('sm');

  /**
   * The initial to show, or `null` for nobody — the neutral person glyph a
   * signed-out or anonymous visitor gets, which no choice can change.
   */
  readonly letter = input<string | null>(null);

  /** The stored choice, or `null` while it is unknown — initials meanwhile. */
  readonly choice = input<AvatarChoice | null>(null);

  /**
   * The account's provider photo, already narrowed to the host the CSP admits
   * (`providerPhotoUrl`), or `null` when it has none there.
   */
  readonly photoUrl = input<string | null>(null);

  /**
   * `loading="eager"` for the account chip, which is on screen on every page
   * from the first paint; `lazy` everywhere else.
   */
  readonly eager = input(false);

  /** The URL whose image has finished loading — only then is it shown. */
  protected readonly loadedUrl = signal<string | null>(null);
  /** The URL that failed, so it is not asked for again in this view. */
  protected readonly failedUrl = signal<string | null>(null);

  protected readonly built = computed(() => {
    const choice = this.choice();
    return this.letter() !== null && choice?.kind === 'built' ? builtAvatar(choice.seed) : null;
  });

  protected readonly imageUrl = computed(() => {
    const url = this.photoUrl();
    return this.letter() !== null &&
      this.choice()?.kind === 'photo' &&
      url !== null &&
      this.failedUrl() !== url
      ? url
      : null;
  });

  /** Whether the letter is hidden under something drawn over it. */
  protected readonly covered = computed(() => {
    const url = this.imageUrl();
    return this.built() !== null || (url !== null && this.loadedUrl() === url);
  });

  /**
   * What the box is showing right now — `guest`, `initials`, `photo` or
   * `built` — as a data attribute, for the tests that have to know the state
   * rather than infer it from pixels. A photo still loading is `initials`,
   * because that is what is on screen.
   */
  protected readonly shown = computed(() => {
    if (this.letter() === null) {
      return 'guest';
    }
    if (this.built() !== null) {
      return 'built';
    }
    return this.covered() ? 'photo' : 'initials';
  });
}
