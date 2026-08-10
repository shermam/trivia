/**
 * Finding G4. The segmented pickers are built from real `<input type="radio">`
 * elements hidden with `sr-only`, so each option was already announced with its
 * own name — what was missing was the *group*. The visible caption above each
 * box is a plain `<span>`, which labels nothing, so a screen reader said
 * "Open Trivia, radio button, 1 of 3" and never mentioned **Question Source**.
 *
 * Written as a sweep over every radio on the page rather than as three
 * assertions about three known ids, so it also covers the segmented picker
 * nobody has added yet — which is the way this regresses.
 */

import { assertRadiosAreGrouped } from '../../support/a11y-assertions';

describe('segmented radio groups (G4)', () => {
  it('labels the question-source picker on the setup screen', () => {
    cy.stubOpenTrivia();
    cy.visit('/');
    cy.wait('@categories');

    assertRadiosAreGrouped();

    // And the group's name is the caption the sighted user reads.
    cy.get('[role="radiogroup"]')
      .first()
      .invoke('attr', 'aria-labelledby')
      .then((id) => cy.get(`#${id}`).should('have.text', 'Question Source'));
  });
});
