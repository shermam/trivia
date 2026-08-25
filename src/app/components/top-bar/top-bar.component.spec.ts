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
 * A controllable `matchMedia`, so a spec can drive a breakpoint crossing.
 *
 * jsdom does not implement `matchMedia` at all; `src/test-setup.ts` shims it
 * globally so nothing throws, and this replaces the shim where a test needs to
 * *fire* a change. The component's only query is Tailwind's `sm` breakpoint —
 * the reduced-motion preference is now read by CSS (`motion-safe:`) rather
 * than by TypeScript, so there is nothing here to drive for it.
 */
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

interface AuthState {
  user?: { displayName?: string; email?: string } | null;
  authReady?: boolean;
  isAnonymous?: boolean;
  isFullyAuthenticated?: boolean;
}

function setup(options: { isReviewer?: boolean; auth?: AuthState } = {}) {
  const media = stubMatchMedia();
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

/**
 * The "Sign in" label itself, not one of the wrappers around it.
 *
 * `textContent` matches every ancestor too, and the label now sits two spans
 * deep inside the collapsing grid region — so a plain `.find()` on the text
 * returns the outermost wrapper and quietly asserts against the wrong
 * element's classes. Requiring no element children picks the leaf.
 */
function signInLabel(h: ReturnType<typeof setup>): HTMLElement {
  const label = [...h.chip().querySelectorAll('span')].find(
    (span) => span.childElementCount === 0 && span.textContent?.trim() === 'Sign in',
  );
  if (!label) {
    throw new Error('no "Sign in" label in the chip');
  }
  return label as HTMLElement;
}

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

    expect(signInLabel(h).className).toContain('whitespace-nowrap');
  });
});

describe('TopBarComponent: the chip label region', () => {
  /**
   * The account chip's width animation, at the layer that can actually see it.
   *
   * It used to be a FLIP in TypeScript — measure before, measure after, set an
   * inline width — and jsdom could not test it honestly at all: with no layout
   * every width is a fiction, a call-counting stub passes against the broken
   * version, and nothing models the render boundary the whole thing turned on.
   * The tests that stood here said so at length and then pinned the
   * scaffolding around the animation rather than the animation.
   *
   * The CSS version is different in kind, not just in mechanism. The browser
   * owns the interpolation and Angular's entire contribution is one class on
   * one element, so what jsdom sees *is* the behaviour: `max-w-0` means
   * collapsed, `max-w-20` means open. No layout required, no fiction.
   *
   * **What jsdom still cannot tell you, and it cost a CI round trip.** These
   * assertions are about which class is set, not about what it does. The first
   * version of this animation used `grid-template-columns: 0fr` -> `1fr`, every
   * test here passed against it, and in a real browser the `0fr` track did not
   * collapse at all — an `fr` track only collapses when the grid container has
   * a width of its own to divide, and every box in this chip is shrink-to-fit.
   * `profile.cy.ts` is what asks whether the class *means* anything.
   */
  const labelRegion = (h: ReturnType<typeof setup>) =>
    h.chip().querySelector('span.overflow-hidden') as HTMLElement;

  it('keeps the label region collapsed on a phone while auth settles', () => {
    const h = setup({ auth: { authReady: false } });

    // Collapsed below `sm`, open from `sm` up: on a desktop there is room for
    // the skeleton bar in every state, so nothing needs to move.
    expect(labelRegion(h).className).toContain('max-w-0');
    expect(labelRegion(h).className).toContain('sm:max-w-none');
  });

  it('opens the label region once there is a sign-in prompt to show', () => {
    const h = setup({ auth: { authReady: true, user: null, isAnonymous: true } });

    expect(labelRegion(h).className).toContain('max-w-20');
    expect(labelRegion(h).className).not.toContain('max-w-0');
  });

  /**
   * The state that must *not* animate, and the reason `showsLabel()` is not
   * simply `authReady()`.
   *
   * A returning player's chip is avatar-only on a phone, which is the same
   * width as the skeleton it replaces — so collapsing the region here is what
   * makes their chip resolve without moving. Relying on the label's `sr-only`
   * instead is not equivalent: measured in Chromium that still left 8px of
   * wrapper margin in flow, so the chip landed at 50px against the 42px it is
   * supposed to match. That shipped to CI and failed there.
   */
  it('keeps the label region collapsed on a phone for a signed-in account', () => {
    const h = setup({
      auth: { authReady: true, user: { displayName: 'Ada Lovelace' }, isAnonymous: false },
    });

    expect(labelRegion(h).className).toContain('max-w-0');
    expect(labelRegion(h).className).toContain('sm:max-w-none');
  });

  /**
   * The element has to survive the branch change, or there is no transition.
   *
   * A CSS transition animates a property changing on an element that is still
   * there. If the label region were inside the `@if`, Angular would destroy it
   * and create a new one with `grid-cols-[1fr]` already applied, and the
   * browser would have nothing to interpolate from — the exact failure that
   * makes this look correct in review and do nothing in a browser.
   */
  it('reuses the same label-region element across the auth transition', () => {
    const h = setup({ auth: { authReady: false } });
    const regionBefore = labelRegion(h);
    // The avatar *is* inside the `@if`, so it is the control: it proves this
    // test can see a recreation at all. Without it, `toBe` would pass just as
    // happily against a template where nothing re-rendered.
    const avatarBefore = h.chip().querySelector('.h-7');

    h.authStub.user.set({ displayName: 'Ada Lovelace' });
    h.authStub.authReady.set(true);
    h.authStub.isAnonymous.set(false);
    h.fixture.detectChanges();

    expect(h.chip().querySelector('.h-7')).not.toBe(avatarBefore);
    expect(labelRegion(h)).toBe(regionBefore);
  });

  /**
   * `npm run motion:verify` enforces the `motion-safe:` gate across templates,
   * so this is not the guard against forgetting it — it is the guard against
   * the transition being dropped or moved off this element, which the script
   * would report as a clean pass.
   */
  it("gates the transition on the reader's motion preference", () => {
    const h = setup({ auth: { authReady: false } });

    expect(labelRegion(h).className).toContain('motion-safe:transition-[max-width]');
  });

  /**
   * The gap between the avatar and the label belongs to the label, and this is
   * the assertion that keeps it there. Put it back on the button as `gap-2`
   * and the collapsed chip is 8px wider than the avatar it is meant to equal —
   * which reads as a chip that is slightly the wrong shape rather than as a
   * bug, and no measurement in the unit suite would notice.
   */
  it('carries the avatar gap inside the collapsing region, not on the button', () => {
    const h = setup({ auth: { authReady: true, user: null, isAnonymous: true } });

    expect(h.chip().className).not.toMatch(/(^|\s)gap-\d/);
    expect(signInLabel(h).className).toContain('ml-2');
  });
});
