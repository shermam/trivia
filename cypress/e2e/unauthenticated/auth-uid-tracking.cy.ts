import { trackedAuthUids, takeTrackedAuthUids } from '../../support/auth-uid-tracker';

/**
 * Finding C6. The preview suite deletes the Auth accounts its tests create in
 * the **real** project. It used to find them by reading the app's persisted uid
 * in an `afterEach` — a sample, which only ever sees the uid a test happens to
 * end with. Every uid replaced along the way was left behind, and they
 * accumulated: 822 of the project's 829 Auth accounts were anonymous when this
 * was measured.
 *
 * This runs against the **emulator**, where there is nothing to clean up, for
 * one reason: it is the only place the mechanism can be exercised locally.
 * The preview suite runs solely in CI against a live project, so a fix verified
 * only there is a fix verified only by merging it — which is how C6 came to
 * exist in the first place. What is under test here is the tracker, not the
 * cleanup: a real browser, a real Firebase Auth, real `localStorage` writes.
 */
/**
 * Anonymous sign-in is a round trip: the page renders well before Firebase has
 * persisted a session, so asserting straight after `cy.visit()` reads an empty
 * store and fails for a reason that has nothing to do with tracking.
 */
function waitForPersistedSession(): void {
  cy.window({ log: false }).should((win) => {
    expect(
      Object.keys(win.localStorage).some((key) => key.startsWith('firebase:authUser:')),
      'Firebase has persisted a session',
    ).to.equal(true);
  });
}

describe('auth uid tracking (C6)', () => {
  beforeEach(() => {
    takeTrackedAuthUids(); // start each test from an empty buffer
  });

  it('captures the ambient anonymous uid a plain visit creates', () => {
    cy.visit('/');
    waitForPersistedSession();

    cy.then(() => {
      expect(trackedAuthUids(), 'uid from the first visit').to.have.length.of.at.least(1);
    });
  });

  // The regression test. Sampling at the end of a test sees only the *last*
  // uid; a session replaced mid-test — which is what a sign-out does, since it
  // mints a fresh anonymous account — was invisible and never deleted.
  it('captures a uid that is replaced mid-test, not just the final one', () => {
    cy.visit('/');
    waitForPersistedSession();

    let firstUid: string;
    cy.then(() => {
      const uids = trackedAuthUids();
      expect(uids, 'first session').to.have.length.of.at.least(1);
      firstUid = uids[uids.length - 1];
    });

    // Drop the persisted session and reload: the app signs in anonymously
    // again and gets a different uid, exactly as a sign-out does.
    cy.clearLocalStorage();
    cy.visit('/');
    waitForPersistedSession();

    cy.then(() => {
      const uids = trackedAuthUids();
      expect(uids, 'both sessions are known').to.have.length.of.at.least(2);
      expect(uids, 'the replaced uid was not forgotten').to.include(firstUid);
      expect(new Set(uids).size, 'the two sessions are distinct accounts').to.be.at.least(2);
    });
  });

  it('hands each uid to the cleanup exactly once', () => {
    cy.visit('/');
    waitForPersistedSession();

    cy.then(() => {
      const first = takeTrackedAuthUids();
      expect(first).to.have.length.of.at.least(1);
      // Draining is what stops the preview suite re-reporting the same uid on
      // every subsequent test in the file.
      expect(takeTrackedAuthUids(), 'buffer is drained').to.deep.equal([]);
    });
  });
});
