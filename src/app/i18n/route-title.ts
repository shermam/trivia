import type { Message, MessageKey } from './message';

/** Each route title's English, registered by `routeTitle()` as `app.routes.ts` is read. */
const english = new Map<string, string>();

/**
 * A route's `title`: the key, with its English kept beside it here. The
 * router hands `AppTitleStrategy` the key, so the strategy can tell "a new
 * screen" from "the same screen in another language" by comparing keys, and
 * renders the title through the active translation each time it is shown.
 */
export function routeTitle(key: MessageKey, en: string): string {
  english.set(key, en);
  return key;
}

/** The title to render for a key the router produced. An unregistered title is its own English. */
export function routeTitleMessage(key: string): Message {
  return { key: key as MessageKey, en: english.get(key) ?? key };
}
