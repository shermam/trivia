import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { IconComponent } from '../icon/icon.component';

/**
 * Renders a question's optional source attribution (`sourceUrl` /
 * `sourceTitle`, FEAT-022) — as a link when there is a URL, as plain text
 * when there is only a title, and as nothing at all when there is neither.
 *
 * It is a component rather than a few lines of markup repeated in the two
 * templates that need it (game-over's recap and the reviewer's queue card)
 * because the interesting part is not the markup, it is the two rules
 * underneath it, and both are the kind that rot silently when copy-pasted:
 *
 * 1. **The href is re-checked here, not trusted from Firestore.**
 *    `firestore.rules` already refuses a `sourceUrl` that is not an
 *    `https://`-prefixed string of a sane length, but `CLAUDE.md` §4.4 is
 *    explicit that the reader has to be right regardless of the writer —
 *    the rule is one deploy away from being widened, and Firestore is a
 *    public API. `safeHref()` therefore parses the value and renders a link
 *    only for a real `https:` URL; anything else degrades to the plain-text
 *    branch instead of emitting an anchor. (Angular's URL sanitizer would
 *    also refuse a `javascript:` href, but it would do so by rewriting it to
 *    `unsafe:…` and still rendering a dead link, which is a worse outcome
 *    than not rendering one.)
 *
 * 2. **`target="_blank"` carries three obligations, not one.** `rel="noopener
 *    noreferrer"` (the opened page gets no `window.opener` handle back), an
 *    `sr-only` "(opens in a new tab)" so the behaviour is announced rather
 *    than merely happening, and a visible external-link glyph so a sighted
 *    reader gets the same warning. Losing any one of them in a copy-paste is
 *    invisible in review.
 *
 * 3. **A title can lie about where the link goes, so the reviewer is shown
 *    the host.** The label is the contributor's `sourceTitle` — arbitrary
 *    text they typed — and rendering it alone means `"Wikipedia"` pointing at
 *    `https://anything.example/` reads as Wikipedia on the one screen whose
 *    whole job is approving on evidence. `showHost` appends the hostname
 *    **inside the anchor**, so it is part of the link's accessible name and
 *    there is no way to read or hear the link without its destination. It is
 *    off by default and on only for `/review`: a player meets the link after
 *    they have already answered and after a reviewer has vouched for the
 *    question, so there the title is the useful thing and the raw host is
 *    noise.
 *
 * Label precedence is the title, else the URL's hostname: a contributor who
 * supplies only a link should not leave the reader staring at a 300-character
 * URL, and the hostname is the part that tells them whether it is worth
 * clicking.
 *
 * No layout-stability concern (§4.4): both callers render this from data
 * that has already resolved, so the element does not appear or disappear
 * under a reader mid-view.
 */
@Component({
  selector: 'app-source-link',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (safeHref(); as href) {
      <p class="mt-1 flex items-start gap-1.5 text-xs" data-cy="question-source">
        <app-icon
          name="external-link"
          [size]="13"
          class="mt-0.5 shrink-0 text-slate-400 dark:text-slate-500"
        />
        <span class="text-slate-500 dark:text-slate-400">
          <span class="sr-only">Source:</span>
          <a
            [href]="href"
            target="_blank"
            rel="noopener noreferrer"
            class="font-medium hover:underline"
            data-cy="question-source-link"
            >{{ label() }}
            @if (shownHost(); as host) {
              <span
                class="font-normal text-slate-400 dark:text-slate-500"
                data-cy="question-source-host"
                >&nbsp;&mdash; {{ host }}</span
              >
            }
            <span class="sr-only"> (opens in a new tab)</span></a
          >
        </span>
      </p>
    } @else if (label(); as text) {
      <p class="mt-1 text-xs text-slate-500 dark:text-slate-400" data-cy="question-source">
        <span class="sr-only">Source:</span>
        {{ text }}
      </p>
    }
  `,
})
export class SourceLinkComponent {
  readonly url = input<string | undefined>(undefined);
  readonly title = input<string | undefined>(undefined);

  /**
   * Whether to disclose the link's hostname next to its title. On for the
   * reviewer's queue card, off everywhere else — see point 3 above.
   */
  readonly showHost = input(false);

  /**
   * The URL, but only if it really is one and really is https. Returns
   * `undefined` otherwise, which collapses the template to the plain-text
   * branch (or to nothing, if there is no title either).
   */
  readonly safeHref = computed(() => {
    const raw = this.url()?.trim();
    if (!raw) return undefined;
    try {
      return new URL(raw).protocol === 'https:' ? raw : undefined;
    } catch {
      return undefined;
    }
  });

  /**
   * The host of a usable URL, `www.` stripped because it is noise.
   *
   * No `try`/`catch`: `safeHref()` has already parsed this exact string with
   * `new URL`, so the second parse cannot throw. A fallback here would be a
   * branch no input can reach, which is worse than none — it reads as a case
   * somebody considered and tested.
   */
  readonly host = computed(() => {
    const href = this.safeHref();
    return href ? new URL(href).hostname.replace(/^www\./, '') : undefined;
  });

  /**
   * Title if given, else the host of a usable URL — and `undefined` when
   * there is nothing to show at all, so that the template's
   * `@else if (label(); as text)` renders no empty paragraph.
   */
  readonly label = computed(() => this.title()?.trim() || this.host());

  /**
   * The host to render beside the label, or `undefined` when there is nothing
   * to add: no host, `showHost` off, or the label **is** the host already —
   * which is the no-title case, and repeating it would be noise rather than
   * disclosure.
   */
  readonly shownHost = computed(() => {
    const host = this.host();
    if (!this.showHost() || !host || host === this.label()) {
      return undefined;
    }
    return host;
  });
}
