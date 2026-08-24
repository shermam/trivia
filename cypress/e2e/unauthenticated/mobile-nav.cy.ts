/**
 * The responsive top bar (`docs/app.md`).
 *
 * The unit spec covers the drawer's behaviour — `aria-expanded`, Escape, focus
 * in and back, the breakpoint teardown. None of that says anything about which
 * elements are *visible* at which width, because that is decided entirely by
 * Tailwind classes and jsdom does not do layout. This spec runs at real
 * viewports, which is the only place those classes mean anything.
 */

const MOBILE = { width: 390, height: 780 };
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
    cy.get('[data-cy="nav-menu-panel"]').should('not.exist');
  });

  it('closes on Escape and returns focus to the hamburger', () => {
    cy.get('[data-cy="nav-menu-trigger"]').click();
    cy.get('[data-cy="nav-menu-panel"]').should('be.visible');

    cy.get('body').type('{esc}');

    cy.get('[data-cy="nav-menu-panel"]').should('not.exist');
    cy.focused().should('have.attr', 'data-cy', 'nav-menu-trigger');
  });

  it('closes when the backdrop is tapped', () => {
    // A plain centre click, with no `force`. That is the point of the overlay
    // being a flex row: an `inset-0` backdrop has its own centre underneath the
    // panel, and Cypress refuses to click an element whose centre is covered.
    // Forcing it would have hidden a genuine overlap on the one element whose
    // entire job is to be tappable.
    cy.get('[data-cy="nav-menu-trigger"]').click();
    cy.get('[data-cy="nav-menu-backdrop"]').click();

    cy.get('[data-cy="nav-menu-panel"]').should('not.exist');
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

  it('keeps the brand on the left, where it has always been', () => {
    cy.get('header a[href="/"]')
      .first()
      .then(($brand) => {
        expect($brand[0].getBoundingClientRect().x).to.be.lessThan(DESKTOP.width / 4);
      });
  });
});
