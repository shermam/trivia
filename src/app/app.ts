import { Component, afterNextRender, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { FooterComponent } from './components/footer/footer.component';
import { TopBarComponent } from './components/top-bar/top-bar.component';
import { AuthService } from './services/auth.service';
import { EmbedModeService } from './services/embed-mode.service';
import { RouteAnnouncerService } from './services/route-announcer.service';
import { TriviaService } from './services/trivia.service';

/**
 * How long the post-paint bootstrap below will wait for an idle moment, and
 * what it does instead in a browser with no `requestIdleCallback` (Safari
 * gained it in 18.4, so this is a real branch rather than a formality).
 */
const BOOTSTRAP_IDLE_TIMEOUT_MS = 2_000;
const BOOTSTRAP_IDLE_FALLBACK_MS = 500;

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, TopBarComponent, FooterComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly embedMode = inject(EmbedModeService);
  protected readonly routeAnnouncer = inject(RouteAnnouncerService);
  private readonly authService = inject(AuthService);
  private readonly triviaService = inject(TriviaService);

  constructor() {
    /**
     * Both of these pull Firebase, and neither is needed to render anything.
     *
     * `ensureSignedIn()` dynamically imports `firebase/auth` — 129 kB raw /
     * 36 kB gzip, plus the 31 kB shared chunk under it — and called straight
     * from this constructor that import was issued *before* Angular had
     * painted, so it competed for the throttled connection with the route
     * chunk `/` was still waiting on. Nothing on `/` needs the answer: the
     * account chip renders its fixed-size "auth not ready" state until
     * `authReady()` flips (`CLAUDE.md` §4.4), which is the same state it shows
     * today while the SDK loads.
     *
     * **`afterNextRender` alone was measured and was not enough.** It fires
     * when the DOM has been written, which is a frame *before* the browser has
     * painted and — more to the point — before the router's own lazy import of
     * the `/` component has been issued. Deferring only that far moved the
     * Firebase request 90 ms and left it overlapping the route chunk it was
     * competing with, for no measurable change in either metric. Chaining an
     * idle callback behind it puts the request after the route chunk has
     * landed, which is what actually shows up: LCP 2418 ms → 2352 ms
     * (medians of 10, interleaved, 4× CPU / Fast 3G).
     *
     * **The idle callback is bounded**, because idle is otherwise a promise
     * the browser need never keep: a page that stays busy would leave the
     * account chip on its loading state indefinitely. Two seconds is the
     * deadline by which auth starts regardless — long enough to be after the
     * route on a slow device, short enough that nobody waits on it. The same
     * shape as `TriviaService.initOfflinePrefetch()`, deliberately with
     * shorter bounds: that one is topping a cache up and can afford ten
     * seconds of idle and a two-second fallback, while this one gates what the
     * account chip shows.
     *
     * **Neither is a startup dependency of the other work bootstrap does.**
     * `AuthService.getAuth()` is memoised and lazy: any consumer that needs
     * auth — `whenAuthStateReady()`, `getIdToken()`, opening the auth menu
     * (`AuthMenuStateService`, which starts it explicitly for exactly this
     * reason) — triggers the same bootstrap itself. This call only decides how
     * *early* an anonymous session is minted, not whether one is, so nothing
     * downstream waits longer than it would have; `authReady()` means exactly
     * what it meant before.
     *
     * **No teardown, and the reason is the root component's lifetime rather
     * than an oversight** (`CLAUDE.md` §4.4 wants one or the other written
     * down; `SubscriptionService`'s idle prime makes the same call). `App` is
     * destroyed only when the whole application is, so the window in which a
     * cancel could matter does not exist: there is no later state for a stale
     * callback to corrupt, and the page is going away with it.
     */
    afterNextRender(() => {
      const start = () => {
        void this.authService.ensureSignedIn();
        this.triviaService.initOfflinePrefetch();
      };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(start, { timeout: BOOTSTRAP_IDLE_TIMEOUT_MS });
      } else {
        setTimeout(start, BOOTSTRAP_IDLE_FALLBACK_MS);
      }
    });
  }
}
