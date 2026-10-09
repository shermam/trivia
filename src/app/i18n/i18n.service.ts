import { DOCUMENT, Injectable, computed, inject, isDevMode, signal } from '@angular/core';
import { formatMessage, type FormatParams } from './format';
import { renderParams, type Message, type MessageKey, type MessageParams } from './message';

/** A translation in use: its locale, and its messages by key. */
interface Translation {
  readonly locale: string;
  readonly messages: Readonly<Record<string, string>>;
}

/**
 * Looks up and renders the app's interface text (`docs/app.md` §1.16).
 *
 * **English is never looked up.** Every call carries its English as the
 * default — `t('home.title', 'Welcome back')` — so with no translation in use
 * this is the default, formatted. A translation, once one is in use, is a map
 * from key to text; a key it does not hold renders the English default rather
 * than the key, with a warning in development and never an error.
 *
 * **One signal decides everything**, and the `t` pipe reads it, so a change of
 * translation re-renders every message on screen without a reload.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly document = inject(DOCUMENT);
  private readonly translation = signal<Translation | null>(null);
  private readonly warned = new Set<string>();

  /** The locale of the text on screen: `en`, or the translation's. */
  readonly locale = computed(() => this.translation()?.locale ?? 'en');

  t(key: MessageKey, en: string, params?: MessageParams | null): string;
  t(message: Message): string;
  t(keyOrMessage: MessageKey | Message, en?: string, params?: MessageParams | null): string {
    const message =
      typeof keyOrMessage === 'string'
        ? { key: keyOrMessage, en: en ?? '', params: params ?? undefined }
        : keyOrMessage;
    const [text, locale] = this.template(message);
    return formatMessage(text, this.params(message.params), locale);
  }

  /** `params` with every {@link Message} among them rendered in this language. */
  params(params: MessageParams | undefined): FormatParams | undefined {
    return renderParams(params, (message) => this.t(message));
  }

  /**
   * The unformatted text for `message` and the locale it is written in — the
   * translation's when it holds the key, otherwise the English default. For
   * the one caller that has to split a message before filling it in
   * (`RichTextComponent`).
   */
  template(message: Message): readonly [text: string, locale: string] {
    const translation = this.translation();
    if (translation) {
      const text = translation.messages[message.key];
      if (text !== undefined) return [text, translation.locale];
      if (isDevMode() && !this.warned.has(message.key)) {
        this.warned.add(message.key);
        console.warn(
          `[i18n] "${message.key}" is missing from ${translation.locale}; showing English.`,
        );
      }
    }
    return [message.en, 'en'];
  }

  /**
   * Puts a translation in use — or, with `null`, goes back to English — and
   * sets `<html lang>` to match, which is how a screen reader picks its voice.
   */
  useTranslation(locale: string, messages: Readonly<Record<string, string>> | null): void {
    this.translation.set(messages ? { locale, messages } : null);
    this.document.documentElement.lang = messages ? locale : 'en';
  }
}
