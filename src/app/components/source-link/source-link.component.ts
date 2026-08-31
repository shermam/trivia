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
 * Label precedence is title, then the URL's hostname, then a bare "Source":
 * a contributor who supplies only a link should not have the reader staring
 * at a 300-character URL, and the hostname is the part that actually tells
 * them whether it is worth clicking.
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
            >{{ label() }}<span class="sr-only"> (opens in a new tab)</span></a
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
   * Title if given, else the host of a usable URL, else a bare "Source" —
   * and `undefined` when there is nothing to show at all, so that the
   * template's `@else if (label(); as text)` renders no empty paragraph.
   */
  readonly label = computed(() => {
    const title = this.title()?.trim();
    if (title) return title;
    const href = this.safeHref();
    if (!href) return undefined;
    try {
      return new URL(href).hostname.replace(/^www\./, '');
    } catch {
      return 'Source';
    }
  });
}
