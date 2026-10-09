import { englishText, type Message } from './message';

/**
 * A message as English renders it, for a spec that reads a signal holding one
 * — `expect(english(component.error())).toBe('Could not …')` — without a
 * TestBed to inject `I18nService` from. `null` for no message, so a spec can
 * still say a status line is empty.
 */
export function english(message: Message | null | undefined): string | null {
  return message ? englishText(message) : null;
}
