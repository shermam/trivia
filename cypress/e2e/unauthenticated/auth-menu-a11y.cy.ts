/**
 * Findings G1 and G2. The auth menu is a button that shows and hides a panel,
 * and it told assistive tech none of that: no `aria-expanded`, so a screen
 * reader announced a plain button and never said whether the panel was open;
 * no `aria-controls`, so nothing connected the two; and no role on the panel.
 * Keyboard behaviour was missing to match — Escape did nothing, opening left
 * focus on the trigger (so reaching an already-visible panel meant tabbing
 * through the rest of the page), and closing dropped focus to `<body>`.
 *
 * None of this is detectable by tooling: Lighthouse scores accessibility 1.0
 * and ESLint's `templateAccessibility` set reports zero errors with every one
 * of these present — confirmed empirically in #38. So it is pinned here, in a
 * real browser, where focus and keys actually exist.
 */
import questionsFixture from '../../fixtures/open-trivia-questions.json';

const CORRECT_ANSWERS = questionsFixture.results.map((q) => q.correct_answer);

describe('auth menu accessibility (G1, G2)', () => {
  const trigger = () => cy.get('[data-cy="auth-menu-trigger"]');

  beforeEach(() => {
    cy.stubOpenTrivia();
    cy.visit('/');
  });

  it('describes the panel it controls', () => {
    // `dialog`, not `menu`: the panel holds a form, text inputs and links, and
    // an ARIA menu would have a screen reader announce those as menu items.
    trigger().should('have.attr', 'aria-haspopup', 'dialog');
    trigger().should('have.attr', 'aria-expanded', 'false');

    trigger().click();

    trigger().should('have.attr', 'aria-expanded', 'true');
    trigger()
      .invoke('attr', 'aria-controls')
      .then((panelId) => {
        expect(panelId, 'aria-controls names the panel').to.be.a('string').and.not.be.empty;
        cy.get(`#${panelId}`)
          .should('exist')
          .and('have.attr', 'role', 'dialog')
          .and('have.attr', 'aria-label');
      });
  });

  it('moves focus into the panel when it opens', () => {
    trigger().click();

    // Not merely "something is focused" — focus must be inside the panel, which
    // is what stops a keyboard user having to tab the whole page to reach it.
    cy.focused().should('have.attr', 'role', 'dialog');
  });

  it('closes on Escape and gives focus back to the trigger', () => {
    trigger().click();
    cy.get('[role="dialog"]').should('exist');

    cy.get('body').type('{esc}');

    cy.get('[role="dialog"]').should('not.exist');
    trigger().should('have.attr', 'aria-expanded', 'false');
    cy.focused().should('have.attr', 'data-cy', 'auth-menu-trigger');
  });

  it('gives focus back when closed with the panel’s own close button', () => {
    trigger().click();
    cy.get('[role="dialog"]').find('button[aria-label="Close"]').click();

    cy.get('[role="dialog"]').should('not.exist');
    cy.focused().should('have.attr', 'data-cy', 'auth-menu-trigger');
  });

  // The menu is not only opened from the top bar: game-over's "Sign in to save
  // your score" opens the same panel. Focus has to return to whatever opened
  // it, not to the top bar, or closing teleports the user across the page.
  it('returns focus to the opener when the menu was opened from elsewhere', () => {
    cy.startGame(5);
    CORRECT_ANSWERS.forEach((answer) => {
      cy.answerQuestion(answer);
    });
    cy.location('pathname').should('eq', '/game-over');

    // By data-cy, not by text: the top bar's own trigger also reads "Sign in"
    // for an anonymous visitor, and it comes first in the DOM.
    cy.get('[data-cy="open-sign-in"]').click();
    cy.get('[role="dialog"]').should('exist');

    cy.get('body').type('{esc}');

    cy.get('[role="dialog"]').should('not.exist');
    // Back to game-over's own button, not the top bar's trigger.
    cy.focused().should('have.attr', 'data-cy', 'open-sign-in');
  });
});
