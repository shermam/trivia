import './commands';
import './preview-commands';

// Cypress reserves paths starting with `/__` for its own runner/iframe
// machinery, which collides with Firebase Hosting's own `/__/` reserved
// namespace (used by the app's runtime-config fetch, see
// FirebaseAppService) — any request to a `/__/`-prefixed path just hangs
// forever inside a Cypress-controlled browser, real endpoint or not,
// confirmed by directly probing nonexistent `/__/` paths too. This isn't
// limited to plain requests: cy.intercept() stubbing the same URL didn't
// help either, since it's routed through the same proxy layer that
// mishandles the path in the first place. Patching window.fetch directly,
// before any app code runs, bypasses Cypress's network/proxy layer for
// this one call entirely instead of trying to work within it — the app
// gets its real config (fetched via cy.request(), which runs outside the
// browser and is unaffected) without ever making a real browser-native
// request to the colliding path.
let firebaseInitConfig: object;

before(() => {
  cy.request(`${Cypress.config('baseUrl')}/__/firebase/init.json`).then((response) => {
    firebaseInitConfig = response.body as object;
  });
});

Cypress.on('window:before:load', (win) => {
  const originalFetch = win.fetch.bind(win);
  win.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/__/firebase/init.json')) {
      return Promise.resolve(
        new win.Response(JSON.stringify(firebaseInitConfig), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

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
