import { Pipe, PipeTransform, inject } from '@angular/core';
import { I18nService } from './i18n.service';
import type { Message, MessageKey, MessageParams } from './message';

/**
 * `{{ 'home.title' | t: 'Welcome back' }}`, `{{ message | t }}`.
 *
 * **Impure on purpose.** A pure pipe is re-run only when its arguments change,
 * and a change of locale changes none of them; an impure one re-runs with the
 * view, and because it reads `I18nService`'s signal while the view renders,
 * that signal changing is itself what schedules the view to render again. The
 * cost is a map lookup per binding per change detection, and a parse only the
 * first time a message with a placeholder is seen.
 *
 * `null` and `undefined` render nothing, so a status line holding no message
 * needs no `@if` around it.
 */
@Pipe({ name: 't', pure: false })
export class TPipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(key: MessageKey, en: string, params?: MessageParams | null): string;
  transform(message: Message | null | undefined): string;
  transform(
    keyOrMessage: MessageKey | Message | null | undefined,
    en?: string,
    params?: MessageParams | null,
  ): string {
    if (keyOrMessage === null || keyOrMessage === undefined) return '';
    return typeof keyOrMessage === 'string'
      ? this.i18n.t(keyOrMessage, en ?? '', params)
      : this.i18n.t(keyOrMessage);
  }
}
