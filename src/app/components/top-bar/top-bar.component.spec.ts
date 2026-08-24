import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { ReviewerService } from '../../services/reviewer.service';
import { SubscriptionService } from '../../services/subscription.service';
import { ThemeService } from '../../services/theme.service';
import { TopBarComponent } from './top-bar.component';

/**
 * The mobile navigation drawer.
 *
 * Which links are *visible* at which width is decided by Tailwind classes and
 * is therefore invisible to jsdom — that half is covered in
 * `cypress/e2e/unauthenticated/mobile-nav.cy.ts`, at a real viewport. What is
 * covered here is the behaviour `CLAUDE.md` §4.5 requires of a disclosure and
 * that nothing automated will otherwise check: `aria-expanded`, Escape,
 * focus moving in and coming back, and the breakpoint teardown.
 */

/** A controllable `matchMedia`, so a spec can drive a breakpoint crossing. */
function stubMatchMedia() {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
  return {
    widen: () => listeners.forEach((l) => l({ matches: true } as MediaQueryListEvent)),
    listenerCount: () => listeners.size,
  };
}

function setup(options: { isReviewer?: boolean } = {}) {
  const media = stubMatchMedia();
  TestBed.configureTestingModule({
    imports: [TopBarComponent],
    providers: [
      // Real routes for the paths the bar links to. With `provideRouter([])`
      // a link click navigates to a route that does not exist, and the
      // rejection lands after the test has torn the injector down — surfacing
      // as an unhandled NG0205 rather than as a failure here.
      provideRouter([
        { path: '', children: [] },
        { path: 'pricing', children: [] },
        { path: 'review', children: [] },
      ]),
      {
        provide: AuthService,
        useValue: {
          user: signal(null),
          authReady: signal(true),
          isAnonymous: signal(true),
          isFullyAuthenticated: signal(false),
        },
      },
      { provide: SubscriptionService, useValue: { isProUser: signal(false) } },
      { provide: ThemeService, useValue: { currentTheme: signal('light'), toggle: vi.fn() } },
      {
        provide: ReviewerService,
        useValue: { isReviewer: signal(options.isReviewer ?? false), isResolved: signal(true) },
      },
      AuthMenuStateService,
    ],
  });

  const fixture = TestBed.createComponent(TopBarComponent);
  fixture.detectChanges();
  const el = (selector: string) => fixture.nativeElement.querySelector(selector) as HTMLElement;
  return {
    fixture,
    media,
    trigger: () => el('[data-cy="nav-menu-trigger"]') as HTMLButtonElement,
    panel: () => el('[data-cy="nav-menu-panel"]'),
    backdrop: () => el('[data-cy="nav-menu-backdrop"]'),
    open: () => {
      (el('[data-cy="nav-menu-trigger"]') as HTMLButtonElement).click();
      fixture.detectChanges();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('TopBarComponent: the mobile navigation drawer', () => {
  it('starts closed, and says so on the trigger', () => {
    const h = setup();

    expect(h.panel()).toBeNull();
    expect(h.trigger().getAttribute('aria-expanded')).toBe('false');
    // Nothing to point at while there is no panel — a dangling `aria-controls`
    // names an element that is not in the document.
    expect(h.trigger().getAttribute('aria-controls')).toBeNull();
  });

  it('opens on click and points the trigger at the panel', () => {
    const h = setup();

    h.open();

    expect(h.panel()).not.toBeNull();
    expect(h.trigger().getAttribute('aria-expanded')).toBe('true');
    expect(h.trigger().getAttribute('aria-controls')).toBe(h.panel().id);
    expect(h.panel().getAttribute('role')).toBe('dialog');
    expect(h.panel().getAttribute('aria-label')).toBeTruthy();
  });

  it('moves focus into the panel on open', () => {
    const h = setup();

    h.open();

    expect(document.activeElement).toBe(h.panel());
  });

  it('closes on Escape and gives focus back to the trigger', () => {
    const h = setup();
    h.open();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    h.fixture.detectChanges();

    expect(h.panel()).toBeNull();
    expect(document.activeElement).toBe(h.trigger());
  });

  it('closes when the backdrop is clicked', () => {
    const h = setup();
    h.open();

    h.backdrop().click();
    h.fixture.detectChanges();

    expect(h.panel()).toBeNull();
  });

  it('closes when a link inside it is followed', () => {
    // Otherwise the drawer stays open over the page it just navigated to.
    const h = setup();
    h.open();

    (
      h.fixture.nativeElement.querySelector('[data-cy="nav-menu-pricing-link"]') as HTMLElement
    ).click();
    h.fixture.detectChanges();

    expect(h.panel()).toBeNull();
  });

  it('stays open when the theme is toggled from inside it', () => {
    // Deliberate: the whole page changes colour, and closing the panel would
    // hide the control you would use to change your mind.
    const h = setup();
    h.open();

    (
      h.fixture.nativeElement.querySelector('[data-cy="nav-menu-theme-toggle"]') as HTMLElement
    ).click();
    h.fixture.detectChanges();

    expect(h.panel()).not.toBeNull();
  });

  /**
   * The bug this prevents is specific: the drawer only exists below `sm`, so
   * widening the viewport unmounts it via `sm:hidden` while focus is still
   * inside — dropping focus to `<body>` and leaving `aria-expanded="true"` on
   * a trigger that is no longer visible.
   */
  it('closes itself when the viewport grows past the breakpoint', () => {
    const h = setup();
    h.open();

    h.media.widen();
    h.fixture.detectChanges();

    expect(h.panel()).toBeNull();
    expect(h.trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('removes its breakpoint listener when destroyed', () => {
    // `CLAUDE.md` §4.4 — every addEventListener has a matching teardown.
    const h = setup();
    expect(h.media.listenerCount()).toBe(1);

    h.fixture.destroy();

    expect(h.media.listenerCount()).toBe(0);
  });

  // Two fixtures in one test tears the first injector down while its
  // RouterLinks are still live, which surfaces as an unhandled NG0205 rather
  // than a failure. One fixture per test.
  it('offers the review link in the drawer to a reviewer', () => {
    const h = setup({ isReviewer: true });

    h.open();

    expect(
      h.fixture.nativeElement.querySelector('[data-cy="nav-menu-review-link"]'),
    ).not.toBeNull();
  });

  it('omits the review link for everybody else', () => {
    const h = setup({ isReviewer: false });

    h.open();

    expect(h.fixture.nativeElement.querySelector('[data-cy="nav-menu-review-link"]')).toBeNull();
  });
});
