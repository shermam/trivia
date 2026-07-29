declare global {
  namespace Cypress {
    interface Chainable {
      /**
       * Reads the Firebase-persisted uid (browserLocalPersistence, see
       * AuthService) out of the app's own localStorage and hands it to the
       * `trackAuthUid` task, so `finalCleanup` deletes it afterwards — this
       * is what catches the anonymous user every `cy.visit()` silently
       * creates in the real project, not just uids seeded explicitly.
       */
      trackCurrentSessionUid(): Chainable<null>;
    }
  }
}

Cypress.Commands.add('trackCurrentSessionUid', () => {
  cy.window().then((win) => {
    const key = Object.keys(win.localStorage).find((k) => k.startsWith('firebase:authUser:'));
    const raw = key ? win.localStorage.getItem(key) : null;
    const uid = raw ? (JSON.parse(raw) as { uid?: string }).uid : undefined;
    return uid ? cy.task('trackAuthUid', uid) : null;
  });
});

export {};
