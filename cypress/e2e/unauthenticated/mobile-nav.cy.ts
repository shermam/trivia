/**
 * The responsive top bar (`docs/app.md`).
 *
 * The unit spec covers the drawer's behaviour — `aria-expanded`, Escape, focus
 * in and back, the breakpoint teardown. None of that says anything about which
 * elements are *visible* at which width, because that is decided entirely by
 * Tailwind classes and jsdom does not do layout. This spec runs at real
 * viewports, which is the only place those classes mean anything.
 *
 * Since the drawer became an always-mounted overlay that slides rather than an
 * `@if` that appears, this is also the only place two of its guarantees can be
 * checked at all. jsdom parses `inert` and enforces none of it, so "closed
 * means unfocusable and untappable" is a browser-only assertion; and the slide
 * itself is a transform, which jsdom has no opinion about.
 */

const MOBILE = { width: 390, height: 780 };
/**
 * The narrowest width the app supports, and the one the 390px suite below was
 * quietly standing in for. `iPhone SE (1st gen)` is 320 CSS px, and so is any
 * desktop window dragged that narrow.
 */
const NARROW = { width: 320, height: 780 };
const DESKTOP = { width: 1024, height: 800 };

describe('the top bar on a phone', () => {
  beforeEach(() => {
    cy.stubOpenTrivia();
    cy.viewport(MOBILE.width, MOBILE.height);
    cy.visit('/');
  });

  it('shows the hamburger and hides the inline links', () => {
    cy.get('[data-cy="nav-menu-trigger"]').should('be.visible');
    cy.get('header a[href="/pricing"]').should('not.be.visible');
  });

  /**
   * The regression guard for a bug this actually had. The first attempt used
   * `grid-cols-[auto_1fr_auto]`, which centres the brand between the two side
   * items rather than in the bar — measured 21px off centre in a browser,
   * because the account chip is much wider than the hamburger. Only a
   * measurement catches that; it looks approximately right by eye.
   */
  it('centres the brand in the bar, not between its neighbours', () => {
    cy.get('header a[href="/"]')
      .first()
      .then(($brand) => {
        const rect = $brand[0].getBoundingClientRect();
        const brandCentre = rect.x + rect.width / 2;
        // Against `clientWidth`, not the viewport width passed to
        // `cy.viewport`. A classic scrollbar takes layout space, so the two
        // differ by its width — this first read 187.5 against an expected 195,
        // which is exactly half a 15px scrollbar and not an off-centre brand.
        // `clientWidth` is the layout viewport, which is what the grid centres
        // within and therefore what "centred" has to mean here.
        const layoutCentre = Cypress.$('html')[0].clientWidth / 2;
        expect(brandCentre).to.be.closeTo(layoutCentre, 1);
      });
  });

  it('does not overflow horizontally', () => {
    cy.document().then((doc) => {
      expect(doc.documentElement.scrollWidth).to.be.at.most(doc.documentElement.clientWidth);
    });
  });

  /**
   * The account chip is the widest thing in the bar and the only part whose
   * width is user-controlled, so it is the one that can push into the brand.
   * A signed-in chip is covered in `authenticated/`; this pins the anonymous
   * one, which is the state every first-time visitor sees.
   */
  it('keeps the account chip clear of the brand', () => {
    cy.get('[data-cy="auth-menu-trigger"]').then(($chip) => {
      cy.get('header a[href="/"]')
        .first()
        .then(($brand) => {
          const brand = $brand[0].getBoundingClientRect();
          const chip = $chip[0].getBoundingClientRect();
          expect(brand.x + brand.width).to.be.at.most(chip.x);
        });
    });
  });

  /**
   * **The assertion this file was missing.** It measured the chip's width, its
   * overlap with the brand and the brand's centring — and never its height. So
   * "Sign in" wrapping to two lines inside the `minmax(0,1fr)` grid track,
   * rendering the chip 54px tall in a 64px bar, shipped green.
   *
   * A single line is 42px. 46 leaves room for a font-metric wobble and still
   * fails outright on a second line.
   */
  it('keeps the account chip to a single line', () => {
    cy.get('[data-cy="auth-menu-trigger"]').then(($chip) => {
      expect($chip[0].getBoundingClientRect().height).to.be.at.most(46);
    });
  });

  /**
   * The account chip's label animates by transitioning `max-width` from `0` to
   * a cap, so the cap is a number the label has to stay under — and a label
   * wider than its cap is not clipped for the length of the animation, it is
   * clipped **forever**.
   *
   * That makes the cap a silent failure by construction: "Sign in" would simply
   * render as "Sign i" and nothing else in the suite would notice. The cap is
   * deliberately tight (4rem against a 53.4px label) because the ratio of label
   * to cap is the fraction of the transition that is visible, so this is the
   * assertion that pays for choosing timing over slack.
   *
   * `scrollWidth` against `clientWidth` rather than a fixed number, so it keeps
   * working if the font, the copy or the root font size changes — which is the
   * whole point, since those are exactly what would move the label past the cap.
   */
  it('shows the whole sign-in label, uncut by the animation cap', () => {
    cy.get('[data-cy="auth-menu-trigger"] span.overflow-hidden').should(($region) => {
      const region = $region[0];
      expect(region.scrollWidth, 'label overflowing its max-width cap').to.be.at.most(
        region.clientWidth,
      );
      // ...and it must not be collapsed either: signed out is the one state
      // whose label is supposed to be visible, so a passing overflow check on a
      // zero-width region would be vacuous.
      expect(region.clientWidth, 'label region width').to.be.greaterThan(0);
    });
  });

  it('opens a drawer holding the links the bar dropped', () => {
    cy.get('[data-cy="nav-menu-trigger"]').click();

    cy.get('[data-cy="nav-menu-panel"]').should('be.visible');
    cy.get('[data-cy="nav-menu-pricing-link"]').should('be.visible');
    cy.get('[data-cy="nav-menu-theme-toggle"]').should('be.visible');
  });

  it('covers the full height of the viewport', () => {
    // `<header>` carries `backdrop-blur-md`, and a backdrop-filter ancestor
    // becomes the containing block for `position: fixed` descendants — so a
    // drawer rendered inside the header collapses to its 4rem box. It renders
    // outside for that reason, and this is what would notice if it moved back.
    cy.get('[data-cy="nav-menu-trigger"]').click();
    cy.get('[data-cy="nav-menu-panel"]').then(($panel) => {
      expect($panel[0].getBoundingClientRect().height).to.be.closeTo(MOBILE.height, 2);
    });
  });

  it('navigates and closes when a drawer link is followed', () => {
    cy.get('[data-cy="nav-menu-trigger"]').click();
    cy.get('[data-cy="nav-menu-pricing-link"]').click();

    cy.location('pathname').should('eq', '/pricing');
    // `not.be.visible`, not `not.exist`: the drawer stays in the document so
    // it can transition on the way out. Cypress retries the assertion, so this
    // also quietly requires the exit to actually finish rather than leaving a
    // permanently visible panel over the page it just navigated to.
    cy.get('[data-cy="nav-menu-panel"]').should('not.be.visible');
  });

  it('closes on Escape and returns focus to the hamburger', () => {
    cy.get('[data-cy="nav-menu-trigger"]').click();
    cy.get('[data-cy="nav-menu-panel"]').should('be.visible');

    cy.get('body').type('{esc}');

    cy.get('[data-cy="nav-menu-panel"]').should('not.be.visible');
    cy.focused().should('have.attr', 'data-cy', 'nav-menu-trigger');
  });

  it('closes when the backdrop is tapped', () => {
    // `'right'`, not the default centre, and not `{force: true}`. The backdrop
    // covers the whole viewport — it has to, or the dim ends in a hard line at
    // the panel's edge as the panel slides out — so its centre is genuinely
    // underneath the panel and Cypress is right to refuse a click there.
    // Aiming at the right edge is a real click at a point that really is
    // exposed; forcing would have suppressed the check instead of the overlap,
    // on the one element whose entire job is to be tappable.
    cy.get('[data-cy="nav-menu-trigger"]').click();
    cy.get('[data-cy="nav-menu-backdrop"]').click('right');

    cy.get('[data-cy="nav-menu-panel"]').should('not.be.visible');
  });

  /**
   * The drawer is in the DOM on every page load now, closed. Everything that
   * makes "closed" mean closed — no tab stop, nothing in the accessibility
   * tree, nothing hit-tested — rides on `inert` and `pointer-events-none`, and
   * jsdom enforces neither, so this is the only place it can be checked.
   */
  it('leaves nothing tappable behind while it is closed', () => {
    cy.get('[data-cy="nav-menu-overlay"]').should('have.attr', 'inert');

    cy.document().then((doc) => {
      const overlay = doc.querySelector('[data-cy="nav-menu-overlay"]');
      const hit = doc.elementFromPoint(20, doc.documentElement.clientHeight / 2);
      expect(overlay?.contains(hit), 'the closed drawer swallowing a tap').to.equal(false);
    });
  });

  /**
   * **The reason this design was chosen over `animate.leave`.** Angular's
   * version defers the DOM removal but tears the view down synchronously, so
   * for the length of the exit there is a drawer on screen whose `(click)`
   * handlers are already gone — visible, focusable, and covering the viewport.
   *
   * Here `inert` and `pointer-events-none` land with the signal rather than
   * with the animation. Measured in Chromium with a `MutationObserver`: both
   * are on **4.2ms** after the click, with the panel still at x=0 and the
   * backdrop still at full opacity — the exit has not started moving anything
   * yet.
   *
   * **What this assertion pins is the contract, not that number.** A retrying
   * `should` would be satisfied just as well if `inert` only arrived when the
   * animation ended, and the version that would catch it — asserting `inert`
   * while the panel is still `visible` — is a race against the 250ms exit that
   * would go flaky the first time CI was slow. So: the contract here, the
   * timing by measurement, and the mechanism written down where it is easy to
   * break.
   */
  it('stops intercepting when it is dismissed', () => {
    cy.get('[data-cy="nav-menu-trigger"]').click();
    // `'right'` for the same reason as the dismissal test above: the backdrop
    // is full-bleed, so its centre is under the panel.
    cy.get('[data-cy="nav-menu-backdrop"]').click('right');

    // One callback rather than `.should(...).and(...)`: `should('have.attr')`
    // *changes the subject* to the attribute's value, so the chained
    // `have.class` ran against the string `''` and failed with "neither a DOM
    // object nor a jQuery object". Both assertions retry together this way.
    cy.get('[data-cy="nav-menu-overlay"]').should(($overlay) => {
      expect($overlay, 'dismissed drawer still interactive').to.have.attr('inert');
      expect($overlay, 'dismissed drawer still taking pointer events').to.have.class(
        'pointer-events-none',
      );
    });
  });

  /**
   * **The backdrop dims the whole viewport, not just the strip beside the
   * panel.** It used to be a `flex-1` sibling covering only what the panel did
   * not, which looks identical while the drawer is open and is obviously wrong
   * the moment it closes: the panel slides left off bare, undimmed page and
   * the dim ends in a hard vertical line travelling across the screen.
   *
   * Asserted against the layout viewport rather than `cy.viewport`'s argument,
   * for the same reason the brand-centring test above is — a classic scrollbar
   * takes layout width.
   */
  it('dims the whole viewport, not just the part the panel misses', () => {
    cy.get('[data-cy="nav-menu-trigger"]').click();

    cy.get('[data-cy="nav-menu-backdrop"]').should(($backdrop) => {
      const rect = $backdrop[0].getBoundingClientRect();
      const doc = $backdrop[0].ownerDocument.documentElement;
      expect(rect.x, 'backdrop starting to the right of the panel').to.be.closeTo(0, 1);
      expect(rect.width, 'backdrop narrower than the viewport').to.be.closeTo(doc.clientWidth, 1);
      expect(rect.height, 'backdrop shorter than the viewport').to.be.closeTo(doc.clientHeight, 1);
    });
  });

  /**
   * The slide itself. Closed, the panel is parked entirely off the left edge by
   * `-translate-x-full`; open, it rests against it.
   *
   * Measured rather than asserted on the class, because `-translate-x-full`
   * only parks the panel off-screen if the panel is the thing being translated
   * and its width is what "full" resolves against — a wrapper picking up the
   * class instead would read as present and move nothing.
   */
  it('parks the panel off the left edge until it is opened', () => {
    cy.get('[data-cy="nav-menu-panel"]').then(($panel) => {
      // `at.most(1)` rather than `at.most(0)`: `-translate-x-full` is exactly
      // minus the panel's own width, so the right edge lands on 0 by
      // construction — and a rect built from two floats that cancel is exactly
      // the place not to demand an exact zero. One pixel of slack still fails
      // by 287 if the panel is not parked.
      expect($panel[0].getBoundingClientRect().right, 'closed panel still on screen').to.be.at.most(
        1,
      );
    });

    cy.get('[data-cy="nav-menu-trigger"]').click();

    cy.get('[data-cy="nav-menu-panel"]').should(($panel) => {
      expect($panel[0].getBoundingClientRect().x, 'open panel not at the left edge').to.be.closeTo(
        0,
        1,
      );
    });
  });

  /**
   * **Focus-on-open is what the always-mounted drawer actually broke, twice.**
   * The panel sits in a subtree that is `inert` and `visibility: hidden` until
   * the drawer opens, and `focus()` on an element in either state is a silent
   * no-op — so opening it now depends on both of those being genuinely gone by
   * the time focus moves, which they were not:
   *
   * 1. A plain `effect()` runs *before* its bindings reach the DOM. It had
   *    always run in the wrong order; a `viewChild` resolving late used to
   *    force a second run once the DOM was right, and making the panel
   *    permanent removed that accident. Fixed with `afterRenderEffect`.
   * 2. With the `visibility` transition applied in both directions, the first
   *    frame after opening sits at progress 0 where `visibility` still computes
   *    to `hidden`. Fixed by transitioning it only on the way out.
   *
   * Both failed *silently*, and neither is visible to the unit spec, which
   * asserts the same thing and passes either way because jsdom enforces
   * neither attribute. This is the assertion with teeth.
   */
  it('moves focus into the panel on open, past the inert it just dropped', () => {
    cy.get('[data-cy="nav-menu-trigger"]').click();

    cy.focused().should('have.attr', 'data-cy', 'nav-menu-panel');
  });
});

/**
 * **The same bar at 320px, because 390 was hiding a real defect.**
 *
 * `keeps the account chip clear of the brand` has been in this file all along
 * and passed throughout — at 390, where the brand clears the chip by 23px. At
 * 320 it did not clear it at all: measured on production, the brand's right
 * edge reached 220.34 against a chip starting at 208.64, so the wordmark
 * "Trivimind" rendered **underneath** the account button by 11.7px. The chip
 * in question is the signed-out one, the widest state, which is what a
 * first-time visitor sees.
 *
 * The arithmetic is why one viewport could not stand in for the other. The
 * brand is centred in the *bar*, so its right edge is `W/2 + brandWidth/2`,
 * while the chip is right-aligned at `W - padding - chipWidth`. Clearance is
 * therefore `W/2 - 171.7` — a function of the viewport that goes negative
 * below ~343px and grows from there. A single wide-enough width can never
 * fail, and tells you nothing about the widths that can.
 */
describe('the top bar at its narrowest', () => {
  beforeEach(() => {
    cy.stubOpenTrivia();
    cy.viewport(NARROW.width, NARROW.height);
    cy.visit('/');
  });

  it('keeps the account chip clear of the brand', () => {
    cy.get('[data-cy="auth-menu-trigger"]').then(($chip) => {
      cy.get('header a[href="/"]')
        .first()
        .then(($brand) => {
          expect(
            $brand[0].getBoundingClientRect().right,
            'the brand running under the account chip',
          ).to.be.at.most($chip[0].getBoundingClientRect().x);
        });
    });
  });

  /**
   * The brand shrinks here rather than disappearing, and both halves of that
   * matter: something has to give at this width, and what was chosen to give
   * was size, not the name or the chip's "Sign in" label.
   */
  it('still shows the whole wordmark', () => {
    cy.get('header a[href="/"]').first().should('be.visible').and('contain.text', 'Trivimind');
  });

  it('does not overflow horizontally', () => {
    cy.document().then((doc) => {
      expect(doc.documentElement.scrollWidth).to.be.at.most(doc.documentElement.clientWidth);
    });
  });

  it('centres the brand in the bar', () => {
    cy.get('header a[href="/"]')
      .first()
      .then(($brand) => {
        const rect = $brand[0].getBoundingClientRect();
        expect(rect.x + rect.width / 2).to.be.closeTo(Cypress.$('html')[0].clientWidth / 2, 1);
      });
  });

  it('keeps the account chip to a single line', () => {
    cy.get('[data-cy="auth-menu-trigger"]').then(($chip) => {
      expect($chip[0].getBoundingClientRect().height).to.be.at.most(46);
    });
  });
});

describe('the top bar on a wide screen', () => {
  beforeEach(() => {
    cy.stubOpenTrivia();
    cy.viewport(DESKTOP.width, DESKTOP.height);
    cy.visit('/');
  });

  it('shows the links inline and no hamburger', () => {
    cy.get('header a[href="/pricing"]').should('be.visible');
    cy.get('[data-cy="nav-menu-trigger"]').should('not.be.visible');
  });

  /**
   * The same cap guard as on a phone, at the width where it used not to apply.
   *
   * The label region was uncapped above `sm` until the chip stopped showing a
   * display name; now every viewport shares one rule and one 4rem cap, so the
   * clipping risk exists here too and is checked here too.
   */
  it('shows the whole sign-in label, uncut by the animation cap', () => {
    cy.get('[data-cy="auth-menu-trigger"] span.overflow-hidden').should(($region) => {
      const region = $region[0];
      expect(region.scrollWidth, 'label overflowing its max-width cap').to.be.at.most(
        region.clientWidth,
      );
      expect(region.clientWidth, 'label region width').to.be.greaterThan(0);
    });
  });

  it('keeps the brand on the left, where it has always been', () => {
    cy.get('header a[href="/"]')
      .first()
      .then(($brand) => {
        expect($brand[0].getBoundingClientRect().x).to.be.lessThan(DESKTOP.width / 4);
      });
  });
});
