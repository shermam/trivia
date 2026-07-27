import './commands';

// Every spec starts from a clean emulator: no leftover Auth users or
// Firestore docs from a previous test, so tests never depend on run order.
beforeEach(() => {
  cy.resetBackend();
});
