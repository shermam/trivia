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

// Real network + real Auth/Firestore backend means real, previously-unseen
// failure modes (timeouts, throttling, ...) that the emulator can never
// produce. `cy.task('log', ...)` prints straight to the CI job's raw stdout
// (unlike the Cypress command log, which is silent in headless `run` mode
// unless a test fails), so this is what turns "a real assertion timed out"
// into an actual root cause instead of a guess.
beforeEach(() => {
  cy.intercept({ url: /identitytoolkit\.googleapis\.com/ }, (req) => {
    const startedAt = Date.now();
    req.on('response', (res) => {
      cy.task(
        'log',
        `[auth-network] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - startedAt}ms)`,
        { log: false },
      );
    });
    req.continue();
  });

  cy.on('window:before:load', (win) => {
    (['error', 'warn'] as const).forEach((level) => {
      cy.stub(win.console, level).callsFake((...args: unknown[]) => {
        cy.task('log', `[browser ${level}] ${args.map(String).join(' ')}`, { log: false });
      });
    });
  });
});

after(() => {
  cy.task('finalCleanup');
});
