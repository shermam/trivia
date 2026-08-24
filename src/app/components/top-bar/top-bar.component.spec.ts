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

/**
 * A controllable `matchMedia`, so a spec can drive a breakpoint crossing and
 * choose whether the reader has asked for reduced motion.
 *
 * Both queries go through the same stub because `TopBarComponent` asks for the
 * breakpoint and `prefersReducedMotion()` asks for the preference, and jsdom
 * implements neither.
 */
function stubMatchMedia(reducedMotion = false) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  window.matchMedia = (query: string) =>
    ({
      matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
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

interface AuthState {
  user?: { displayName?: string; email?: string } | null;
  authReady?: boolean;
  isAnonymous?: boolean;
  isFullyAuthenticated?: boolean;
}

function setup(options: { isReviewer?: boolean; auth?: AuthState; reducedMotion?: boolean } = {}) {
  const media = stubMatchMedia(options.reducedMotion ?? false);
  const auth = options.auth ?? {};
  const authStub = {
    user: signal<AuthState['user']>(auth.user ?? null),
    authReady: signal(auth.authReady ?? true),
    isAnonymous: signal(auth.isAnonymous ?? true),
    isFullyAuthenticated: signal(auth.isFullyAuthenticated ?? false),
  };
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
        useValue: authStub,
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
    authStub,
    chip: () => el('[data-cy="auth-menu-trigger"]'),
    chipText: () =>
      (el('[data-cy="auth-menu-trigger"]').textContent ?? '').replace(/\s+/g, ' ').trim(),
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

describe('TopBarComponent: the account chip while auth settles', () => {
  /**
   * **The regression test for a wrong-state flash.**
   *
   * `onAuthStateChanged` fires once with `null` and flips `authReady` before
   * `signInAnonymously()` has delivered anybody, so this combination — ready,
   * but no user — is a state the app really passes through on every cold load
   * and again on every sign-out. The template used to branch on
   * `isAnonymous()`, which is `false` for a null user, so it fell through to
   * the signed-in arm and rendered the `initials()` fallback: a "?" avatar
   * that looks like somebody is logged in. Measured in a browser as a real
   * third box in the chip's load sequence.
   */
  it('shows the sign-in prompt when auth is ready but nobody is signed in yet', () => {
    const h = setup({ auth: { authReady: true, user: null, isAnonymous: false } });

    expect(h.chipText()).toContain('Sign in');
    expect(h.chipText()).not.toContain('?');
  });

  it('shows the sign-in prompt for an anonymous session', () => {
    const h = setup({ auth: { authReady: true, user: null, isAnonymous: true } });

    expect(h.chipText()).toContain('Sign in');
  });

  it('shows the account once somebody is really signed in', () => {
    const h = setup({
      auth: { authReady: true, user: { displayName: 'Ada Lovelace' }, isAnonymous: false },
    });

    expect(h.chipText()).toContain('Ada Lovelace');
    expect(h.chipText()).not.toContain('Sign in');
  });

  /**
   * The placeholder has to be shaped like the chip it becomes, not the word
   * "Loading…" on its own — that rendered 34px tall against 42px for every
   * resolved state, so the chip changed height the instant auth settled.
   * jsdom cannot measure that, so what is pinned here is the structure the
   * height depends on: an avatar-sized circle and a space-occupying label.
   */
  it('renders a chip-shaped skeleton while auth is settling', () => {
    const h = setup({ auth: { authReady: false } });

    expect(h.chip().getAttribute('aria-busy')).toBe('true');
    expect(h.chip().querySelector('.h-7.w-7')).not.toBeNull();
    // A skeleton *bar*, not an empty gap: `text-transparent` hides the glyphs
    // while the box keeps their metrics, so it both looks like a placeholder
    // and reserves the exact width the resolved label will need.
    const bar = h.chip().querySelector('.text-transparent');
    expect(bar).not.toBeNull();
    expect(bar?.textContent?.trim()).toBe('Sign in');
    expect(h.chip().querySelector('.sr-only')?.textContent).toContain('Loading');
  });

  it('drops aria-busy once auth is ready', () => {
    const h = setup({ auth: { authReady: true } });

    expect(h.chip().getAttribute('aria-busy')).toBeNull();
  });

  /**
   * `whitespace-nowrap` is what keeps "Sign in" on one line inside the
   * `minmax(0,1fr)` grid track on a phone. Without it the chip renders 54px
   * tall in a 64px bar — which shipped, because the mobile-nav spec measured
   * width, overlap and centring but never height. jsdom does no layout, so the
   * height itself is asserted in `mobile-nav.cy.ts`; this pins the mechanism.
   */
  it('forbids the sign-in label from wrapping', () => {
    const h = setup({ auth: { authReady: true, user: null, isAnonymous: true } });

    const label = [...h.chip().querySelectorAll('span')].find(
      (span) => span.textContent?.trim() === 'Sign in',
    );
    expect(label?.className).toContain('whitespace-nowrap');
  });
});

describe('TopBarComponent: motion', () => {
  /**
   * Every animation in this app is gated on the reader's preference — the
   * convention lives in `src/app/motion.ts`, and `npm run motion:verify`
   * enforces it across templates. That script cannot see motion driven from
   * TypeScript, so the chip's width animation is pinned here.
   *
   * **What these tests deliberately do NOT cover, and why.** The animation's
   * whole subtlety is that it measures across a render boundary: "from" in an
   * `effect()`, where Angular has updated the signals but not the DOM, and
   * "to" in `afterNextRender`, where the DOM is new. jsdom does no layout, so
   * every width here is a fiction, and no fiction models that boundary
   * faithfully — a call-counting stub hands out two different numbers whether
   * or not the reads straddle a render, so it passes against the broken
   * version too, and a content-derived stub cannot represent an in-flight
   * inline width. Both were tried.
   *
   * That correctness is verified where it is real: frame-by-frame in a browser
   * (grow at 1024px, shrink at 390px, skipped under reduced motion), and
   * guarded in `cypress/e2e/authenticated/profile.cy.ts`, which watches for the
   * inline width appearing during a real sign-in. What is pinned below is
   * everything else: the preference gate, the no-op skip, the first-paint
   * guard and the teardown.
   */
  function stubWidths(...widths: number[]) {
    let call = 0;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => {
      const width = widths[Math.min(call, widths.length - 1)];
      call++;
      return { width } as DOMRect;
    });
  }

  /** Drives the skeleton-to-account change and lets the render hooks settle. */
  async function resolveAuth(h: ReturnType<typeof setup>) {
    h.authStub.user.set({ displayName: 'Ada Lovelace' });
    h.authStub.authReady.set(true);
    h.authStub.isAnonymous.set(false);
    h.fixture.detectChanges();
    await h.fixture.whenStable();
  }

  it('starts a width transition when the chip changes size', async () => {
    stubWidths(120, 40);
    const h = setup({ auth: { authReady: false } });

    await resolveAuth(h);

    expect(h.chip().style.transitionProperty).toBe('width');
    expect(h.chip().style.width).not.toBe('');
  });

  it('does not animate when the reader has asked for reduced motion', async () => {
    stubWidths(120, 40);
    const h = setup({ auth: { authReady: false }, reducedMotion: true });

    await resolveAuth(h);

    expect(h.chip().style.width).toBe('');
    expect(h.chip().style.transitionProperty).toBe('');
  });

  it('does not animate when the width has not actually changed', async () => {
    // The anonymous case, where the skeleton is deliberately the same size as
    // what replaces it. Animating a zero-width change would be 220ms of
    // nothing happening, slowly.
    stubWidths(95);
    const h = setup({ auth: { authReady: false } });

    await resolveAuth(h);

    expect(h.chip().style.width).toBe('');
  });

  it('leaves no inline width behind when the component is destroyed mid-animation', async () => {
    // `CLAUDE.md` §4.4 — a frame request, a listener and a timer are all live
    // during the transition, and the teardown has to drop all three.
    stubWidths(120, 40);
    const h = setup({ auth: { authReady: false } });
    await resolveAuth(h);
    const chip = h.chip();
    expect(chip.style.width).not.toBe('');

    h.fixture.destroy();

    expect(chip.style.width).toBe('');
    expect(chip.style.transitionProperty).toBe('');
  });
});
