import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { AppTitleStrategy } from './app-title.strategy';
import { routes } from './app.routes';
import { AuthService } from './services/auth.service';
import { RouteAnnouncerService } from './services/route-announcer.service';
import { TriviaService } from './services/trivia.service';

/** The providers `App` needs to stand up at all, plus the background tasks no unit test wants. */
async function configureAppTestBed(): Promise<void> {
  // Real background prefetch schedules a timer + a real opentdb.com fetch (see
  // TriviaService.initOfflinePrefetch) — neither belongs in a unit test.
  vi.spyOn(TriviaService.prototype, 'initOfflinePrefetch').mockImplementation(() => {
    /* intentional no-op */
  });
  // And the auth bootstrap, which since `FEAT-017` §3.2 is scheduled behind a
  // timer rather than called from the constructor. Under jsdom that is a real
  // 500ms `setTimeout` (no `requestIdleCallback` there), and every one of
  // these tests finishes long before it fires — so today it lands after the
  // fixture is gone, into a dynamic `firebase/auth` import that fails and is
  // swallowed. Stubbed rather than left to chance: the fallback is a number
  // somebody may shorten, and a suite whose green depends on out-running a
  // timer is green by ordering luck.
  vi.spyOn(AuthService.prototype, 'ensureSignedIn').mockResolvedValue(undefined);

  await TestBed.configureTestingModule({
    imports: [App],
    providers: [provideRouter([]), provideHttpClient()],
  }).compileComponents();
}

describe('App', () => {
  beforeEach(configureAppTestBed);

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });
});

/**
 * `FEAT-017` §3.2. Both of the root's background tasks pull the Firebase SDK,
 * and neither is needed to render `/` — so they run after the first paint, on
 * an idle callback with a bounded fallback, rather than from the constructor.
 *
 * What makes this worth a unit test rather than leaving it to the A/B is that
 * the regression is silent: moving either call back into the constructor
 * changes no behaviour anyone can see, passes every other test, and quietly
 * puts 36 kB gzip of SDK back in front of first paint. The ordering *is* the
 * feature.
 *
 * `requestIdleCallback` does not exist in jsdom, so these exercise the
 * `setTimeout` fallback — which is the branch a browser without the API takes,
 * and the one worth pinning, since a mistake there is invisible in Chrome.
 */
describe('App bootstrap ordering (FEAT-017)', () => {
  let ensureSignedIn: ReturnType<typeof vi.spyOn>;
  let initOfflinePrefetch: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    ensureSignedIn = vi.spyOn(AuthService.prototype, 'ensureSignedIn').mockResolvedValue(undefined);
    initOfflinePrefetch = vi
      .spyOn(TriviaService.prototype, 'initOfflinePrefetch')
      .mockImplementation(() => {
        /* intentional no-op */
      });
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), provideHttpClient()],
    }).compileComponents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts neither Firebase-backed task before the first render', () => {
    TestBed.createComponent(App);

    expect(ensureSignedIn).not.toHaveBeenCalled();
    expect(initOfflinePrefetch).not.toHaveBeenCalled();
  });

  it('still holds them back through the render itself', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    // `afterNextRender` has run by now; the idle callback it scheduled has not.
    expect(ensureSignedIn).not.toHaveBeenCalled();
    expect(initOfflinePrefetch).not.toHaveBeenCalled();
  });

  it('starts both once the deadline passes', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    vi.advanceTimersByTime(500);

    expect(ensureSignedIn).toHaveBeenCalledTimes(1);
    expect(initOfflinePrefetch).toHaveBeenCalledTimes(1);
  });

  /**
   * The deferral must not turn a rejected bootstrap into an unhandled
   * rejection: `ensureSignedIn` swallows its own failures precisely because
   * nothing awaits it here, and moving the call changed nothing about that
   * contract.
   */
  it('does not await the auth bootstrap', () => {
    ensureSignedIn.mockRejectedValueOnce(new Error('offline'));
    const fixture = TestBed.createComponent(App);

    expect(() => {
      fixture.detectChanges();
      vi.advanceTimersByTime(500);
    }).not.toThrow();
  });
});

/**
 * Finding G5. Client-side navigation is silent to assistive tech — nothing
 * reloads, focus does not move, and a screen reader user gets no signal that
 * the screen they were on has been replaced. And with no skip link, reaching
 * the game meant tabbing past the whole top bar on every single screen.
 */
describe('App shell accessibility (G5)', () => {
  beforeEach(configureAppTestBed);

  it('offers a skip link as the first thing in the tab order', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const firstLink = host.querySelector('a');
    expect(firstLink?.getAttribute('href')).toBe('#main-content');
    expect(firstLink?.textContent?.trim()).toBe('Skip to main content');

    // Hidden until focused, or it is visual clutter on every screen.
    expect(firstLink?.className).toContain('sr-only');
    expect(firstLink?.className).toContain('focus:not-sr-only');
  });

  it('gives the skip link somewhere focusable to land', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const main = (fixture.nativeElement as HTMLElement).querySelector('main');

    expect(main?.id).toBe('main-content');
    // Without this the browser scrolls to <main> and leaves focus behind, so
    // the next Tab returns to the top bar the link was there to skip.
    expect(main?.getAttribute('tabindex')).toBe('-1');
  });

  it('keeps the route-announcement region present and empty before navigating', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const region = (fixture.nativeElement as HTMLElement).querySelector('[role="status"]');

    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent?.trim()).toBe('');
  });

  it('renders whatever the announcer is holding', () => {
    const fixture = TestBed.createComponent(App);
    TestBed.inject(RouteAnnouncerService).announce('Game over');
    fixture.detectChanges();

    const region = (fixture.nativeElement as HTMLElement).querySelector('[role="status"]');
    expect(region?.textContent?.trim()).toBe('Game over');
  });
});

/**
 * The announcement is only as good as the titles behind it: a route without one
 * is a screen that announces nothing, and the failure is silent.
 */
describe('route titles (G5)', () => {
  it('gives every real route a title', () => {
    const titled = routes.filter((route) => route.redirectTo === undefined);
    expect(titled.length).toBeGreaterThan(0);

    for (const route of titled) {
      expect(route.title, `route "${route.path}" has a title`).toBeTruthy();
    }
  });
});

describe('AppTitleStrategy (G5)', () => {
  function buildStrategy() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient()] });
    const strategy = TestBed.inject(AppTitleStrategy);
    const announcer = TestBed.inject(RouteAnnouncerService);
    // `buildTitle` walks a real RouterStateSnapshot; stubbing it keeps this
    // about what the strategy *does* with a title, not how the router finds one.
    const titles: (string | undefined)[] = [];
    vi.spyOn(strategy, 'buildTitle').mockImplementation(() => titles.shift());
    return { strategy, announcer, titles };
  }

  it('does not announce the first navigation, which the browser already reads out', () => {
    const { strategy, announcer, titles } = buildStrategy();
    titles.push('Start a game');

    strategy.updateTitle({} as never);

    expect(document.title).toBe('Start a game — Trivimind');
    expect(announcer.message()).toBe('');
  });

  it('announces every navigation after the first', () => {
    const { strategy, announcer, titles } = buildStrategy();
    titles.push('Start a game', 'Play');

    strategy.updateTitle({} as never);
    strategy.updateTitle({} as never);

    expect(document.title).toBe('Play — Trivimind');
    expect(announcer.message()).toBe('Play');
  });

  // The router fires for a fragment or query-string change too. The skip link
  // (#main-content) is one, and it made the app announce the page the user was
  // already on, at the moment they were trying to reach its content. Returning
  // from Stripe to /pricing?checkout=success is the same shape.
  it('says nothing when a navigation does not change the screen', () => {
    const { strategy, announcer, titles } = buildStrategy();
    titles.push('Start a game', 'Start a game');

    strategy.updateTitle({} as never); // initial load
    strategy.updateTitle({} as never); // skip link / query change

    expect(announcer.message()).toBe('');
  });

  it('announces again when the screen really does change back', () => {
    const { strategy, announcer, titles } = buildStrategy();
    titles.push('Start a game', 'Pricing', 'Start a game');

    strategy.updateTitle({} as never);
    strategy.updateTitle({} as never);
    expect(announcer.message()).toBe('Pricing');

    strategy.updateTitle({} as never);
    expect(announcer.message()).toBe('Start a game');
  });

  it('falls back to the app name when a route has no title', () => {
    const { strategy, titles } = buildStrategy();
    titles.push(undefined);

    strategy.updateTitle({} as never);

    expect(document.title).toBe('Trivimind');
  });
});
