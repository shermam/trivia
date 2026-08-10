import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { AppTitleStrategy } from './app-title.strategy';
import { routes } from './app.routes';
import { RouteAnnouncerService } from './services/route-announcer.service';
import { TriviaService } from './services/trivia.service';

/** The providers `App` needs to stand up at all, plus the background task no unit test wants. */
async function configureAppTestBed(): Promise<void> {
  // Real background prefetch schedules a timer + a real opentdb.com fetch (see
  // TriviaService.initOfflinePrefetch) — neither belongs in a unit test.
  vi.spyOn(TriviaService.prototype, 'initOfflinePrefetch').mockImplementation(() => {
    /* intentional no-op */
  });

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
