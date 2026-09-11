# TriviaApp

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.0.8.

## Development server

```bash
npm start
```

Starts the Firebase emulators (Auth, Firestore, Functions) under
`demo-trivimind-local` and runs `ng serve` inside them, then open
`http://localhost:4200/`. The app reloads whenever you modify a source file,
and an **EMULATOR** badge in the top bar (tablet width and up) tells you which backend you are on.

**Use `npm start`, not a bare `ng serve`.** They are not equivalent: `ng serve`
alone starts no emulators, so the app has no backend to talk to.
`docs/dev-environment.md` covers the three environments and what keeps them
apart.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

E2E tests run against a real, local [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite) instance (Auth + Firestore + Functions) — never the live `intellectura-3b26a` project. They cover both unauthenticated flows (anonymous play, route guards, embed mode) and authenticated flows (sign-up/verification, sign-in, saving a score, profile management).

There are two suites while the [Cypress](https://www.cypress.io/) one is being ported to [Playwright](https://playwright.dev/) — `cypress/e2e/{unauthenticated,authenticated}/` and `e2e/specs/{unauthenticated,authenticated}/`, both running on every PR. `docs/ci-cd.md` §4.3 says what is ported and what the cutover changes.

Requires a JRE on your `PATH` (the Firestore emulator runs on the JVM) and the [Firebase CLI](https://firebase.google.com/docs/cli) tooling, which is fetched on demand via `npx`.

```bash
npm run pw:e2e     # headless: serves the app, starts the emulators, runs Playwright, tears everything down
npm run e2e        # the same, with Cypress
npm run e2e:open   # Cypress, in its interactive runner instead of headlessly
```

`npm run pw:e2e` also needs its browser once: `npx playwright install --with-deps chromium`.

All three wrap `firebase emulators:exec`, so the emulators start fresh and shut down automatically when the runner finishes (or is closed). The app itself only talks to the emulators when built with the `e2e` configuration (`ng serve --configuration=e2e`) — see `src/environments/environment.e2e.ts` and `useEmulators` in `FirebaseAppService`/`AuthService`/`FirebaseService`.

CI runs both suites on every pull request targeting `main` (`.github/workflows/e2e.yml` and `e2e-playwright.yml`).

## Running Lighthouse

[Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci) audits the production build's performance, accessibility, best-practices, and SEO scores, with thresholds and collection settings in `lighthouserc.json`:

```bash
npm run lighthouse
```

This builds the app with the `lighthouse` configuration (same optimizations as `build:prod`, but pointed at the Firebase Emulator Suite instead of the live project — see `useEmulators` in `src/environments/environment.e2e.ts`), serves it from the real Firebase Hosting emulator, and runs Lighthouse 3 times, asserting each category's median score against `lighthouserc.json`'s thresholds. Requires a JRE (Firestore emulator) and Google Chrome on your `PATH` (or set `CHROME_PATH`) — both already present on GitHub-hosted runners, so no extra setup is needed there.

Serving from the real Hosting emulator (not a bare static server) matters: it's what makes `/__/firebase/init.json` resolve, so Auth/Firestore actually initialize and run for real instead of every audit eating a guaranteed console error that would otherwise mask genuine best-practices regressions.

CI runs the same audit on every pull request targeting `main` (`.github/workflows/lighthouse.yml`), uploading the HTML/JSON reports as a build artifact either way.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
