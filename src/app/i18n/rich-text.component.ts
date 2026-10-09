import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  TemplateRef,
  computed,
  inject,
  input,
} from '@angular/core';
import { formatMessage } from './format';
import { I18nService } from './i18n.service';
import type { Message } from './message';

/** What a tag's template receives: the text between the tags, filled in. */
export interface RichTagContext {
  readonly $implicit: string;
}

interface Segment {
  readonly text: string;
  readonly template: TemplateRef<RichTagContext> | null;
}

/** `<name>…</name>`, no attributes, no nesting. */
const TAG = /<([a-z][a-zA-Z0-9]*)>([\s\S]*?)<\/\1>/g;

/**
 * A message with markup inside the sentence — a link, a code span — rendered
 * without assembling the sentence from fragments and without `innerHTML`.
 *
 * The message names its markup with tags of its own (`Read <terms>the
 * Terms</terms> first.`), and the host maps each name to an `ng-template`
 * that receives the text between the tags:
 *
 * ```html
 * <app-rich-text [message]="readTerms" [tags]="{ terms: termsLink }" />
 * <ng-template #termsLink let-text><a routerLink="/terms">{{ text }}</a></ng-template>
 * ```
 *
 * So a translator moves the link to wherever their grammar wants it, and
 * every piece of the result is a text node or the host's own markup — a tag
 * the host did not map renders as its text, and nothing a translation says
 * can become an element. The tags are split out **before** the parameters
 * are filled in, so a parameter that happens to contain `<b>` is text too.
 */
@Component({
  selector: 'app-rich-text',
  imports: [NgTemplateOutlet],
  template: `
    @for (segment of segments(); track $index) {
      @if (segment.template; as template) {
        <ng-container *ngTemplateOutlet="template; context: { $implicit: segment.text }" />
      } @else {
        <ng-container>{{ segment.text }}</ng-container>
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RichTextComponent {
  private readonly i18n = inject(I18nService);

  readonly message = input.required<Message>();
  readonly tags = input<Readonly<Record<string, TemplateRef<RichTagContext>>>>({});

  protected readonly segments = computed<readonly Segment[]>(() => {
    const message = this.message();
    const tags = this.tags();
    const [source, locale] = this.i18n.template(message);
    const params = this.i18n.params(message.params);
    const fill = (text: string) => formatMessage(text, params, locale);
    const segments: Segment[] = [];
    let last = 0;
    for (const match of source.matchAll(TAG)) {
      if (match.index > last)
        segments.push({ text: fill(source.slice(last, match.index)), template: null });
      segments.push({ text: fill(match[2]), template: tags[match[1]] ?? null });
      last = match.index + match[0].length;
    }
    if (last < source.length) segments.push({ text: fill(source.slice(last)), template: null });
    return segments;
  });
}
