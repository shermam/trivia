# TriviaApp

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.0.8.

## Development server

```bash
npm start
```

Starts the Firebase emulators (Auth, Firestore, Functions) under
`demo-trivimind-local` and runs `ng serve` inside them, then open
`http://localhost:4200/`. The app reloads whenever you modify a source file,
and a **EMULATOR** badge in the top bar tells you which backend you are on.

**Use `npm start`, not a bare `ng serve`.** They are not equivalent: `ng serve`
alone starts no emulators, so the app has no backend to talk to. And until
`FEAT-012` it was worse than that — the `development` build inherited the
production environment and the dev server proxied its Firebase config from the
live Hosting site, so a local server read and wrote the **production**
database. `docs/dev-environment.md` has the full account and the three
environments.

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

E2E tests use [Cypress](https://www.cypress.io/) driven against a real, local [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite) instance (Auth + Firestore) — never the live `intellectura-3b26a` project. The suite covers both unauthenticated flows (anonymous play, route guards, embed mode) and authenticated flows (sign-up/verification, sign-in, saving a score, profile management), under `cypress/e2e/unauthenticated/` and `cypress/e2e/authenticated/`.

Requires a JRE on your `PATH` (the Firestore emulator runs on the JVM) and the [Firebase CLI](https://firebase.google.com/docs/cli) tooling, which is fetched on demand via `npx`.

```bash
npm run e2e        # headless: builds + serves the app, starts the emulators, runs Cypress, tears everything down
npm run e2e:open   # same, but opens the interactive Cypress runner instead of running headlessly
```

Both commands wrap `firebase emulators:exec`, so the emulators start fresh and shut down automatically when Cypress finishes (or is closed). The app itself only talks to the emulators when built with the `e2e` configuration (`ng serve --configuration=e2e`) — see `src/environments/environment.e2e.ts` and `useEmulators` in `FirebaseAppService`/`AuthService`/`FirebaseService`.

CI runs the same suite on every pull request targeting `main` (`.github/workflows/e2e.yml`).

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
