describe('authenticated profile management', () => {
  // Computed fresh in `beforeEach` (not once at describe-scope) — see the
  // identical comment in sign-in-save-score.cy.ts: this file's two `it`s
  // share this hook, and there's no reset between them against the real
  // preview backend.
  let email: string;
  const password = 'correct horse battery staple';

  beforeEach(() => {
    email = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    cy.createVerifiedUser({ email, password });
    cy.visit('/');
    cy.signInViaUi(email, password);
  });

  it('updates the display name and reflects it in the top bar', () => {
    cy.openAuthMenu();
    cy.contains('Your profile');
    // G6: the display name is data about the user, so it declares its purpose.
    cy.get('#displayName').should('have.attr', 'autocomplete', 'nickname');
    cy.get('#displayName').clear().type('Ada Lovelace');
    cy.contains('button', 'Save').click();

    // `contains` matches textContent, which is the right check now that the
    // name is `sr-only` in the chip: it is the button's accessible name rather
    // than something a sighted user reads off the bar.
    cy.get('header').contains('Ada Lovelace');
  });

  /**
   * The width animation, at the only layer that can see it — and the layer
   * that caught it being wrong.
   *
   * The unit suite pins which class is set; whether that class *does* anything
   * is a browser question, and the first version of this animation failed it.
   * It used `grid-template-columns: 0fr` -> `1fr`, which is the technique every
   * accordion recipe reaches for. Every unit test passed. In a real browser the
   * `0fr` track never collapsed: an `fr` track only collapses when the grid
   * container has a width of its own to divide up, and every box in this chip
   * is shrink-to-fit, so the container was sized *from* the track's content and
   * the `fr` filled exactly that. Measured at 53.36px for both `0fr` and `1fr`,
   * and an inline `style="grid-template-columns:0fr"` did the same.
   *
   * These two assertions are what failed then and pass now. Both are read from
   * *resolved* styles at rest rather than by watching an animation, because
   * catching a 450ms transition mid-flight is a race and its start and end
   * states are not.
   */
  it('collapses the chip label region to nothing, and can animate it', () => {
    cy.viewport(390, 780);

    cy.get('[data-cy="auth-menu-trigger"] span.overflow-hidden').should(($region) => {
      const styles = getComputedStyle($region[0]);

      // Signed in, on a phone: fully collapsed. `0px` rather than some small
      // residue is the whole point — see the width assertion below.
      expect(styles.maxWidth, 'collapsed max-width').to.equal('0px');
      expect($region[0].getBoundingClientRect().width, 'collapsed region width').to.equal(0);

      // And the class has to resolve to a real declaration: Tailwind can fail
      // to emit an arbitrary variant, leaving a class that matches no rule.
      // Cypress runs with no motion preference, so `motion-safe:` is live here.
      expect(styles.transitionProperty, 'transition-property').to.contain('max-width');
    });
  });

  /**
   * The account chip is the only part of the top bar whose width the user
   * controls, and it now shows the avatar alone at **every** viewport.
   *
   * On a phone that started as an overlap fix — a long name ran into the
   * centred brand. On a desktop it is a layout-shift fix, and the two things
   * it removes arrive separately: the display name when auth resolves, then
   * the PRO badge a beat later when the Stripe claim does. Measured at 1024px
   * against a 123.4px skeleton, a short name landed the chip at 104.4px, a
   * short name with PRO at 144px, and this 29-character name at 277.5px.
   *
   * Both halves are asserted on purpose. `sr-only` rather than `hidden` is
   * what keeps the name in the button's accessible name — a trigger announced
   * as the single letter "B" would be a worse bug than the shift, and an
   * invisible one.
   */
  it('collapses the account chip to the avatar at every viewport, keeping the name for screen readers', () => {
    const longName = 'Bartholomew Featherstonehaugh';
    cy.openAuthMenu();
    cy.get('#displayName').clear().type(longName);
    cy.contains('button', 'Save').click();
    cy.contains('Saved!');
    cy.get('body').type('{esc}');

    cy.viewport(390, 780);

    // Derived from the DOM rather than hard-coded, and *exact* rather than a
    // bound: the collapsed chip has to be the avatar plus the button's own
    // padding and border and nothing else. A loose `lessThan(100)` passed
    // happily against the version where the label region kept 8px of wrapper
    // margin — the chip was 50px where it should have been 42px, which reads
    // as slightly the wrong shape rather than as a bug. That 42px is also the
    // width the skeleton state collapses to, so this is what makes the
    // sign-in animation start from the same place a signed-in chip ends at.
    cy.get('[data-cy="auth-menu-trigger"]').then(($chip) => {
      const chip = $chip[0];
      const styles = getComputedStyle(chip);
      const avatar = chip.querySelector('.h-7') as HTMLElement;
      const box = (value: string) => parseFloat(value);
      const expected =
        avatar.getBoundingClientRect().width +
        box(styles.paddingLeft) +
        box(styles.paddingRight) +
        box(styles.borderLeftWidth) +
        box(styles.borderRightWidth);

      expect(chip.getBoundingClientRect().width, 'collapsed chip width').to.be.closeTo(
        expected,
        0.5,
      );
    });

    // textContent, not visibility — the point is that it is still there.
    cy.get('[data-cy="auth-menu-trigger"]').should('contain.text', longName);

    cy.get('[data-cy="auth-menu-trigger"]').then(($chip) => {
      cy.get('header a[href="/"]')
        .first()
        .then(($brand) => {
          const brand = $brand[0].getBoundingClientRect();
          expect(brand.x + brand.width).to.be.at.most($chip[0].getBoundingClientRect().x);
        });
    });

    // ...and the same at desktop width, which is the shift this change exists
    // to remove. The label region carrying zero width is the whole mechanism:
    // there is nothing rendered that could arrive late and resize the chip.
    cy.viewport(1024, 780);

    cy.get('[data-cy="auth-menu-trigger"] span.overflow-hidden').should(($region) => {
      expect($region[0].getBoundingClientRect().width, 'desktop label region').to.equal(0);
    });

    cy.get('[data-cy="auth-menu-trigger"]').should(($chip) => {
      const chip = $chip[0];
      const styles = getComputedStyle(chip);
      const box = (value: string) => parseFloat(value);
      const avatar = chip.querySelector('.h-7') as HTMLElement;
      const chevron = chip.querySelector('app-icon') as HTMLElement;
      // Avatar + chevron + the chevron's own gap + the button's padding and
      // border. Derived rather than hard-coded, so it keeps meaning if any of
      // those change; what it pins is that the label contributes nothing.
      const expected =
        avatar.getBoundingClientRect().width +
        chevron.getBoundingClientRect().width +
        box(getComputedStyle(chevron).marginLeft) +
        box(styles.paddingLeft) +
        box(styles.paddingRight) +
        box(styles.borderLeftWidth) +
        box(styles.borderRightWidth);

      expect(chip.getBoundingClientRect().width, 'desktop chip width').to.be.closeTo(expected, 0.5);
    });

    // The name is still there for a screen reader at this width too — the
    // desktop chip used to be the one place it was visible, so this is the
    // assertion that stops it being dropped rather than hidden.
    cy.get('[data-cy="auth-menu-trigger"]').should('contain.text', longName);
  });

  it('signs out back to an anonymous session without flashing the verify-email prompt', () => {
    cy.openAuthMenu();

    // Sign-out briefly transitions through a signed-out `null` user before
    // re-anonymizing; a MutationObserver over the whole render (rather than
    // a point-in-time assertion) is what actually catches a flash that a
    // synchronous `cy.contains` check would step right over.
    cy.window().then((win) => {
      const state = { sawVerifyEmailFlash: false };
      const observer = new MutationObserver(() => {
        if (win.document.body.innerText.includes('Verify your email')) {
          state.sawVerifyEmailFlash = true;
        }
      });
      observer.observe(win.document.body, { childList: true, subtree: true, characterData: true });
      (win as unknown as { __signOutObserverState: typeof state }).__signOutObserverState = state;
    });

    cy.contains('button', 'Sign out').click();

    cy.get('header').contains('button', 'Sign in');

    cy.window().then((win) => {
      const { sawVerifyEmailFlash } = (
        win as unknown as { __signOutObserverState: { sawVerifyEmailFlash: boolean } }
      ).__signOutObserverState;
      expect(sawVerifyEmailFlash, 'the verify-email prompt should never flash during sign-out').to
        .be.false;
    });
  });
});
