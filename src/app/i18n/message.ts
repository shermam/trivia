import type en from './en.json';
import { formatMessage, type FormatParams } from './format';

/**
 * Every key the app may ask for — the keys of `en.json`, read through a
 * type-only import that the build erases, so the English catalogue costs the
 * bundle nothing while `strictTemplates` and `tsc` still refuse a key it does
 * not hold. `en.json` is generated from the call sites
 * (`npm run i18n:extract`), so a new key type-checks once it has been
 * extracted, and `npm run i18n:verify` fails while the file is stale.
 */
export type MessageKey = keyof typeof en;

/**
 * What a message's placeholders are filled with. A {@link Message} is rendered
 * in the same language as the message around it — for a sentence that quotes
 * another whole sentence ("#history was not added. {reason}"), never for a
 * fragment of one — and a list of them is rendered as a comma-separated list
 * of names ("question, source link").
 */
export type MessageParams = Readonly<
  Record<string, string | number | null | undefined | Message | readonly Message[]>
>;

/**
 * A sentence to show later, rather than a string shown now: what a status or
 * error signal holds, so a change of locale re-renders it through the `t` pipe
 * instead of leaving it in the language it was set in. It carries its English,
 * because English is never fetched — it lives at the call site, here.
 */
export interface Message {
  readonly key: MessageKey;
  readonly en: string;
  readonly params?: MessageParams;
}

/** Builds a {@link Message}. The extractor reads `key` and `en`, so both are literals. */
export function msg(key: MessageKey, en: string, params?: MessageParams): Message {
  return params ? { key, en, params } : { key, en };
}

/**
 * `params` with every {@link Message} among them rendered by `render`, ready
 * for the formatter — a list of them joined with a comma.
 */
export function renderParams(
  params: MessageParams | undefined,
  render: (message: Message) => string,
): FormatParams | undefined {
  if (!params) return undefined;
  let resolved: Record<string, FormatParams[string]> | undefined;
  for (const [name, value] of Object.entries(params)) {
    if (value !== null && typeof value === 'object') {
      resolved ??= { ...(params as FormatParams) };
      resolved[name] = Array.isArray(value)
        ? value.map((item: Message) => render(item)).join(', ')
        : render(value as Message);
    }
  }
  return resolved ?? (params as FormatParams);
}

/**
 * A message in English — for an `Error`'s `message`, a log line or a spec.
 * The screen never shows this: it renders through the `t` pipe, in the
 * reader's language.
 */
export function englishText(message: Message): string {
  return formatMessage(message.en, renderParams(message.params, englishText), 'en');
}

/**
 * Whether two messages say the same thing: the same key, with the same value
 * in every placeholder (compared with `===`, so a nested message is the same
 * only as the same object). A comparison that held two strings holds two
 * messages this way, because two calls to {@link msg} are two objects.
 */
export function sameMessage(a: Message | null, b: Message | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.key !== b.key) return false;
  const left = a.params ?? {};
  const right = b.params ?? {};
  const names = Object.keys(left);
  return (
    names.length === Object.keys(right).length && names.every((name) => left[name] === right[name])
  );
}

/**
 * Text that is shown as it is, in every language — a uid, a value somebody
 * stored, the server's own sentence — where a slot otherwise holds a message.
 * One key for all of them, whose every translation is `{text}`.
 */
export function verbatim(text: string): Message {
  return msg('i18n.verbatim', '{text}', { text });
}

/**
 * An error whose message was written for the screen. It carries the
 * {@link Message} to show, so the component that catches it can render it in
 * the reader's language; `message` is the English, filled in, for logs.
 */
export class MessageError extends Error {
  constructor(
    readonly display: Message,
    options?: ErrorOptions,
  ) {
    super(englishText(display), options);
    this.name = 'MessageError';
  }
}

/**
 * What to show for a caught `error`: its own message when one was written for
 * the screen, otherwise `fallback`. An error nobody wrote for a reader — a
 * failed import, a transport fault — has nothing to say to them, and its
 * text goes to the console rather than the screen (`CLAUDE.md` §4.4).
 */
export function messageOf(error: unknown, fallback: Message): Message {
  return error instanceof MessageError ? error.display : fallback;
}
