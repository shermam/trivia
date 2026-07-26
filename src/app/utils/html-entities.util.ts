/**
 * Open Trivia DB returns question/answer text HTML-encoded (e.g. `&quot;`, `&#039;`).
 * Decoded via DOMParser rather than the classic "set innerHTML on a textarea" trick:
 * DOMParser-produced documents are inert (no resource fetching, no script execution),
 * which avoids XSS vectors if the source text ever contains encoded markup.
 */
export function decodeHtmlEntities(text: string): string {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return doc.documentElement.textContent ?? '';
}
