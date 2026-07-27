import { Injectable } from '@angular/core';

/**
 * Lets the app be dropped into an iframe/widget context with just the game
 * panel and no top bar (no auth UI, no leaderboard sign-in prompts) by
 * appending `?embed=1` to the URL — no code changes needed on the embedder's
 * side, and nothing on the host app's side beyond the one `@if` in app.html.
 */
@Injectable({ providedIn: 'root' })
export class EmbedModeService {
  private readonly embedded = new URLSearchParams(window.location.search).get('embed') === '1';

  isEmbedded(): boolean {
    return this.embedded;
  }
}
