import './commands';
import './preview-commands';

// This is the real, persistent, public database — never wipe it. Instead,
// track whatever Auth/Firestore state each test created (including the
// ambient anonymous user every `cy.visit()` creates) and delete exactly
// that once the spec finishes, so a preview run never leaves visible trash
// behind for a real visitor to see.
afterEach(() => {
  cy.trackCurrentSessionUid();
});

after(() => {
  cy.task('finalCleanup');
});
