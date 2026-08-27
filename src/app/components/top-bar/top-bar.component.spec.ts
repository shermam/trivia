import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { ReviewerService } from '../../services/reviewer.service';
import { SubscriptionService } from '../../services/subscription.service';
import { ThemeService } from '../../services/theme.service';
import { TopBarComponent } from './top-bar.component';
import { environment } from '../../../environments/environment';

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

function setup(options: { isReviewer?: boolean; auth?: AuthState; isPro?: boolean } = {}) {
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
      { provide: SubscriptionService, useValue: { isProUser: signal(options.isPro ?? false) } },
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
    overlay: () => el('[data-cy="nav-menu-overlay"]'),
    backdrop: () => el('[data-cy="nav-menu-backdrop"]'),
    /**
     * "Closed" is no longer "absent". The drawer is in the DOM at all times so
     * that it can transition on the way out as well as in, so every assertion
     * that used to read `expect(panel()).toBeNull()` reads this instead.
     *
     * `inert` is the thing asserted rather than the `invisible` class, because
     * it is the attribute that carries the *meaning* — not focusable, not in
     * the accessibility tree, not clickable — while the class is one of three
     * implementation details behind it. jsdom parses `inert` without enforcing
     * any of that, which is exactly why the enforcement is asserted in
     * `mobile-nav.cy.ts` and only the wiring is asserted here.
     */
    isOpen: () => el('[data-cy="nav-menu-overlay"]').getAttribute('inert') === null,
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

    expect(h.isOpen()).toBe(false);
    expect(h.trigger().getAttribute('aria-expanded')).toBe('false');
    // Constant, not conditional. It used to be dropped while the drawer was
    // closed, because back then the panel genuinely was not in the document
    // and a dangling `aria-controls` names nothing. The panel is always there
    // now, so the trigger can always name it — which is what a disclosure is
    // supposed to do.
    expect(h.trigger().getAttribute('aria-controls')).toBe(h.panel().id);
  });

  /**
   * The drawer renders closed rather than not rendering, and that is a real
   * behavioural claim rather than a detail: it is what allows the exit
   * transition to play, and it is also what would put a stack of tabbable
   * links and a `role="dialog"` on every page if `inert` were ever dropped.
   */
  it('keeps the closed drawer in the DOM, and inert', () => {
    const h = setup();

    expect(h.panel()).not.toBeNull();
    expect(h.overlay().getAttribute('inert')).toBe('');
    expect(h.overlay().className).toContain('invisible');
    expect(h.overlay().className).toContain('pointer-events-none');
  });

  /**
   * The panel has to paint *over* the backdrop, and the only thing arranging
   * that is DOM order: both are positioned with `z-index: auto`, so the later
   * sibling wins.
   *
   * Worth a test because reversing them is a one-line edit with a symptom that
   * points somewhere else — a translucent sheet over the whole drawer, and an
   * e2e click landing on the backdrop when it was aimed at a link. jsdom has no
   * layout and no paint, but it does have sibling order, which is the whole
   * mechanism here.
   */
  it('paints the panel over the backdrop by putting it second', () => {
    const h = setup();
    const order = [...h.overlay().children].map((child) => child.getAttribute('data-cy'));

    expect(order).toContain('nav-menu-backdrop');
    expect(order.indexOf('nav-menu-panel')).toBeGreaterThan(order.indexOf('nav-menu-backdrop'));
  });

  /**
   * **The one asymmetry in the animation, and the reason focus works.** The
   * wrapper's `visibility` transition is what holds the drawer on screen for
   * the length of the exit, and it is listed on the *closed* class list only,
   * because a CSS transition takes its properties from the after-change style.
   *
   * Applied in both directions it also delays `visibility` becoming `visible`
   * on the way *in*: for the first frame the transition sits at progress 0 and
   * `visibility` still computes to `hidden`, so the `focus()` that runs in that
   * same frame silently does nothing and the drawer opens with focus stranded
   * on the hamburger. Measured, not reasoned — a reduced-motion browser, which
   * has no transition to sit at progress 0, focused the panel correctly while a
   * normal one did not.
   */
  it('holds the drawer on screen while it closes, and never while it opens', () => {
    const h = setup();
    const holdsVisibility = () => h.overlay().className.includes('transition-[visibility]');

    expect(holdsVisibility(), 'closed drawer should transition its visibility').toBe(true);

    h.open();

    expect(holdsVisibility(), 'open drawer must not delay becoming visible').toBe(false);
  });

  /**
   * Three elements transition on the same gesture — the wrapper's
   * `visibility`, the panel's `transform`, the backdrop's `opacity` — and the
   * wrapper's is the one that ends the exit by hiding everything. If a child
   * ever outlasts it, the drawer disappears mid-slide.
   *
   * Pinned as one number in three places rather than as a specific number:
   * changing the timing is fine, changing it in only two of the three is the
   * bug.
   */
  it('gives the wrapper, the panel and the backdrop the same duration', () => {
    const h = setup();
    const duration = (element: HTMLElement) =>
      /motion-safe:duration-(\d+)/.exec(element.className)?.[1];

    expect(duration(h.overlay())).toBeDefined();
    expect(duration(h.panel())).toBe(duration(h.overlay()));
    expect(duration(h.backdrop())).toBe(duration(h.overlay()));
  });

  it('opens on click and points the trigger at the panel', () => {
    const h = setup();

    h.open();

    expect(h.isOpen()).toBe(true);
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

    expect(h.isOpen()).toBe(false);
    expect(document.activeElement).toBe(h.trigger());
  });

  it('closes when the backdrop is clicked', () => {
    const h = setup();
    h.open();

    h.backdrop().click();
    h.fixture.detectChanges();

    expect(h.isOpen()).toBe(false);
  });

  it('closes when a link inside it is followed', () => {
    // Otherwise the drawer stays open over the page it just navigated to.
    const h = setup();
    h.open();

    (
      h.fixture.nativeElement.querySelector('[data-cy="nav-menu-pricing-link"]') as HTMLElement
    ).click();
    h.fixture.detectChanges();

    expect(h.isOpen()).toBe(false);
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

    expect(h.isOpen()).toBe(true);
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

    expect(h.isOpen()).toBe(false);
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
   * The placeholder is the pulsing avatar and nothing else, because the chip
   * it resolves into is the avatar and nothing else.
   *
   * It used to carry a skeleton *bar* sized to the string "Sign in", which was
   * right when the resolved chip still showed a name: the word "Loading…" on
   * its own rendered 34px tall against 42px, so the chip changed height the
   * instant auth settled. The bar fixed that and reserved the anonymous
   * width. Now that the resolved chip is avatar-only, a bar would reserve
   * width for something that never arrives — reintroducing the shift it was
   * added to remove, in the opposite direction.
   */
  it('renders an avatar-shaped skeleton while auth is settling', () => {
    const h = setup({ auth: { authReady: false } });

    expect(h.chip().getAttribute('aria-busy')).toBe('true');
    expect(h.chip().querySelector('.h-7.w-7')).not.toBeNull();
    expect(h.chip().querySelector('.sr-only')?.textContent).toContain('Loading');
    // No width-reserving bar, and no stray label text that would land in the
    // button's accessible name while it is still announcing "Loading…".
    expect(h.chip().querySelector('.text-transparent')).toBeNull();
    expect(h.chipText()).not.toContain('Sign in');
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
   * collapsed, `max-w-16` means open. No layout required, no fiction.
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

  it('keeps the label region collapsed at every viewport while auth settles', () => {
    const h = setup({ auth: { authReady: false } });

    // No `sm:` escape hatch any more. It used to reopen the region above the
    // breakpoint so a desktop chip could show the display name, and that
    // exception *was* the remaining layout shift: the name and the PRO badge
    // both arrive late and separately, so every signed-in desktop load moved
    // the bar twice.
    expect(labelRegion(h).className).toContain('max-w-0');
    expect(labelRegion(h).className).not.toContain('sm:max-w-none');
  });

  it('opens the label region once there is a sign-in prompt to show', () => {
    const h = setup({ auth: { authReady: true, user: null, isAnonymous: true } });

    expect(labelRegion(h).className).toContain('max-w-16');
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
  it('keeps the label region collapsed at every viewport for a signed-in account', () => {
    const h = setup({
      auth: { authReady: true, user: { displayName: 'Ada Lovelace' }, isAnonymous: false },
    });

    expect(labelRegion(h).className).toContain('max-w-0');
    expect(labelRegion(h).className).not.toContain('sm:max-w-none');
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
   * Paid status has to survive the name leaving the chip, and it has to cost
   * nothing in width — a badge is what made the chip shift a *second* time,
   * 20.6px, a beat after the name when the Stripe claim resolved.
   *
   * A `ring` is a box-shadow, so it paints outside the avatar's box without
   * participating in layout at all. Asserting the badge is gone matters as
   * much as asserting the ring is there: bringing it back would reintroduce
   * exactly the shift this change removes.
   */
  it('marks a Pro account with a ring rather than a width-changing badge', () => {
    const pro = setup({
      auth: { authReady: true, user: { displayName: 'Ada Lovelace' }, isAnonymous: false },
      isPro: true,
    });

    const avatar = pro.chip().querySelector('.h-7.w-7') as HTMLElement;
    expect(avatar.className).toContain('ring-2');
    expect(pro.chipText()).toContain('PRO');
    // The badge element itself — a bordered pill in the flex row — must not
    // come back. Its text lives in the `sr-only` name instead.
    expect(pro.chip().querySelector('.bg-emerald-100')).toBeNull();
  });

  it('leaves the ring off an account without Pro', () => {
    const free = setup({
      auth: { authReady: true, user: { displayName: 'Ada Lovelace' }, isAnonymous: false },
      isPro: false,
    });

    const avatar = free.chip().querySelector('.h-7.w-7') as HTMLElement;
    expect(avatar.className).not.toContain('ring-2');
    expect(free.chipText()).not.toContain('PRO');
  });

  /**
   * The accessible name must not live inside the region that collapses to zero
   * width, because with the name no longer rendered it is the only thing
   * stopping the trigger announcing as the single letter "A".
   *
   * Chromium exposes clipped text either way — that was measured against the
   * built app, not assumed — but a zero-width `overflow: hidden` box is
   * exactly the shape engines disagree about, which is why `sr-only` uses 1px
   * rather than 0. Keeping it outside the clip means no animation state can
   * affect it.
   */
  it('keeps the accessible name outside the collapsing region', () => {
    const h = setup({
      auth: { authReady: true, user: { displayName: 'Ada Lovelace' }, isAnonymous: false },
    });

    const srOnly = [...h.chip().querySelectorAll('.sr-only')].find((el) =>
      el.textContent?.includes('Ada Lovelace'),
    );
    expect(srOnly, 'sr-only name').toBeDefined();
    expect(labelRegion(h).contains(srOnly!), 'name is inside the clipped region').toBe(false);
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

/**
 * **Giving focus back when the auth menu closes, to an opener that may no
 * longer be able to take it.**
 *
 * The menu is not only opened from the top bar — game-over's "Sign in to save
 * this score" opens the same panel — so closing it returns focus to whatever
 * opened it. That opener is routinely taken away by the very action that
 * closed the menu, and *how* it is taken away changed: game-over's prompt used
 * to be removed from the DOM when auth resolved, and is now one of five faces
 * stacked in a grid cell, so it stays connected and goes `visibility: hidden`
 * instead. `isConnected` alone stopped being the right question, and asking
 * `focus()` anyway is silent — focus lands on `<body>` and the keyboard user
 * loses their place with nothing logged anywhere.
 *
 * jsdom implements neither `checkVisibility` (so these exercise the
 * `getComputedStyle` fallback arm, not the branch a browser takes) nor the
 * refusal itself (`focus()` on a hidden element works here). Both are why the
 * end-to-end version of this lives in `sign-in-save-score.cy.ts`.
 */
describe('TopBarComponent: focus returning to the opener', () => {
  function openFromExternalTrigger(hide: 'hidden' | 'detached' | 'none') {
    const h = setup();
    const opener = document.createElement('button');
    opener.setAttribute('data-cy', 'external-opener');
    document.body.appendChild(opener);
    opener.focus();

    TestBed.inject(AuthMenuStateService).open();
    h.fixture.detectChanges();

    if (hide === 'hidden') {
      opener.style.visibility = 'hidden';
    } else if (hide === 'detached') {
      opener.remove();
    }

    TestBed.inject(AuthMenuStateService).close();
    h.fixture.detectChanges();

    const activeCy =
      document.activeElement?.getAttribute('data-cy') ?? document.activeElement?.tagName;
    opener.remove();
    return { activeCy, trigger: h.chip() };
  }

  it('returns focus to the opener that is still usable', () => {
    const { activeCy } = openFromExternalTrigger('none');

    expect(activeCy).toBe('external-opener');
  });

  it('falls back to the trigger when the opener has left the DOM', () => {
    const { activeCy } = openFromExternalTrigger('detached');

    expect(activeCy).toBe('auth-menu-trigger');
  });

  /**
   * The case the score card introduced. Without the visibility check this
   * lands on `<body>` in a real browser — and in jsdom it would land on the
   * hidden opener, which is just as wrong and is what this asserts against.
   */
  it('falls back to the trigger when the opener is still there but hidden', () => {
    const { activeCy } = openFromExternalTrigger('hidden');

    expect(activeCy).toBe('auth-menu-trigger');
  });
});

/**
 * The environment badge.
 *
 * It is the only thing on screen that distinguishes `trivimind-dev` from
 * production, because that project deliberately runs the same production
 * build against the same rules and the same headers — identical is the point,
 * and identical is why the badge has to exist (`FEAT-012`).
 *
 * Unit-level rather than e2e, and that is not a fallback: `environment.e2e.ts`
 * sets the label empty precisely so the badge never renders in an e2e or
 * Lighthouse build, where it would move a top bar that several specs measure
 * to the pixel. This is the only layer that can vary the environment at all.
 *
 * **The suite builds against `environment.ts`**, so the default rendering
 * here is the production one and the label has to be set to see a badge at
 * all. That is pinned rather than inherited, and the reason is worth knowing
 * before touching build configurations: `@angular/build:unit-test` defaults
 * its `buildTarget` to `::development`, so adding a `fileReplacements` there
 * silently moved what the whole unit suite compiles against and put twenty-odd
 * specs red at once — their `fetch` fakes are written against the production
 * REST URL shape. `angular.json` now has a `test` build configuration that
 * keeps `environment.ts`.
 */
describe('TopBarComponent: the environment badge', () => {
  const badge = (fixture: { nativeElement: HTMLElement }) =>
    fixture.nativeElement.querySelector('[data-cy="environment-badge"]') as HTMLElement | null;

  const originalLabel = environment.environmentLabel;
  afterEach(() => {
    environment.environmentLabel = originalLabel;
  });

  it('names the environment it is running against', () => {
    environment.environmentLabel = 'DEV';

    const h = setup();

    expect(badge(h.fixture)?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Environment: DEV');
  });

  /**
   * Absent, not blank. An empty pill would still paint a box and still take
   * width in the brand link — the one place in the bar where a few extra
   * pixels push the account chip toward the hamburger on a phone.
   */
  it('renders nothing at all in production, rather than an empty pill', () => {
    environment.environmentLabel = '';

    const h = setup();

    expect(badge(h.fixture)).toBeNull();
    expect(h.fixture.nativeElement.querySelector('.bg-amber-400')).toBeNull();
  });

  /**
   * The label is announced with its meaning. "DEV" alone is a three-letter
   * shout with no context; the `sr-only` prefix is what makes it a sentence.
   */
  it('says what the label means, for a screen reader', () => {
    environment.environmentLabel = 'EMULATOR';

    const h = setup();

    expect(badge(h.fixture)?.querySelector('.sr-only')?.textContent).toContain('Environment');
  });
});
