/**
 * Shared accessibility assertions.
 *
 * A plain support module, not exported from a `.cy.ts` spec: importing from a
 * spec file executes its `describe` blocks too, so the helper's own tests would
 * silently re-run inside every spec that imported it.
 */

/**
 * Fails unless every radio on the page sits in a `role="radiogroup"` that has a
 * non-empty accessible name (finding G4).
 *
 * A sweep over every radio rather than assertions about three known ids, so it
 * also covers the segmented picker nobody has added yet — which is the way this
 * regresses.
 */
export function assertRadiosAreGrouped(): void {
  cy.get('input[type="radio"]').should('have.length.greaterThan', 0);

  cy.get('input[type="radio"]').each((radio) => {
    const group = radio.closest('[role="radiogroup"]');
    const name = radio.attr('value') ?? radio.attr('name') ?? '(unnamed radio)';

    expect(group.length, `radio "${name}" is inside a [role="radiogroup"]`).to.equal(1);

    const labelledBy = group.attr('aria-labelledby');
    expect(labelledBy, `radiogroup around "${name}" has aria-labelledby`).to.be.a('string').and.not
      .be.empty;

    // The id has to resolve to something with text, or the group is labelled by
    // nothing — which reads exactly like having no label at all.
    cy.get(`#${labelledBy}`).should('exist').and('not.have.text', '');
  });
}
