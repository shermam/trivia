# Trivia App — Project Overview

A single-page trivia quiz game built with Angular, styled with Tailwind CSS, and backed by Firebase (Firestore for data, Hosting for deployment). It pulls questions from the public Open Trivia DB API and/or a custom Firestore-backed question bank, runs a timed multiple-choice quiz, and tracks a global high-score leaderboard.

Live project: Firebase project `intellectura-3b26a` · Repo: `shermam/trivia`

---

## 1. Application Functionality

### 1.1 Game flow

The app is a four-screen flow, implemented as four lazily-loaded standalone Angular routes:

| Route           | Component              | Purpose                                              |
| --------------- | ----------------------- | ---------------------------------------------------- |
| `/`             | `GameSetupComponent`   | Configure and start a new game                       |
| `/play`         | `QuizLoopComponent`    | Answer questions one at a time, against a timer      |
| `/game-over`    | `GameOverComponent`    | Show final score, submit to leaderboard, view top 10 |
| `/add-question` | `AddQuestionComponent` | Submit a new question to the custom question bank    |

Any unmatched route redirects back to `/`.

**Game setup (`/`)**

- Reactive form to configure a game:
  - **Number of questions**: 5 / 10 / 15 / 20 / 25
  - **Category**: "Any Category" or one of the categories fetched live from Open Trivia DB
  - **Difficulty**: Any / Easy / Medium / Hard
  - **Question source**: `open_trivia` (public API), `custom` (Firestore question bank), or `mixed` (roughly half-and-half, shuffled together)
- Categories are fetched once (cached in-memory) from `GET https://opentdb.com/api_category.php`; a failure degrades gracefully to "Any Category" with an inline warning instead of blocking the form.
- On submit, `GameControllerService.startGame()` fetches questions for the chosen config and navigates to `/play`. Loading and error states (e.g. no questions found for the given filters, network failure) are surfaced inline on the form.

**Quiz loop (`/play`)**

- Guards against direct navigation: if there's no active question in memory, it redirects back to `/`.
- Each question has a **15-second countdown timer** (visual ring + shrinking progress bar that turns red in the last 5 seconds).
- Selecting an answer (or the timer hitting 0, which auto-submits a "no answer") locks the question:
  - Correct answer is highlighted green.
  - An incorrect selection is highlighted red; all other options dim.
  - Score increments only on a correct, non-timed-out answer.
- After a 2-second delay showing the result, it auto-advances to the next question (or to `/game-over` if it was the last one).
- Displays running question index, live score, category, and difficulty badges.

**Game over (`/game-over`)**

- Redirects to `/` if there's no completed game in memory.
- Shows final score (`X / N`) and accuracy percentage.
- If fully authenticated (see §1.5), lets the player enter a name (≤30 chars, prefilled from their profile) and submit their score to the Firestore `leaderboard` collection — one entry per account, keeping their best score. Anonymous or unverified players see a sign-in/verify prompt instead of the form.
- Displays the **top 10 leaderboard**, sorted by score descending, loaded from Firestore and refreshed after a successful save.
- "Play Again" resets all in-memory game state and returns to `/`.

**Add a question (`/add-question`)**

- Lets a **fully authenticated** player (same gate as the leaderboard save, §1.5) submit a new question to the shared `custom_questions` bank. Anonymous or unverified players see the same sign-in/verify prompts as game-over instead of the form.
- Reactive form: free-text category (with `<datalist>` suggestions from the same cached Open Trivia category list used by game setup, so a submitted category can actually be filtered on later), difficulty, question type (multiple-choice vs. true/false), the question text, and answers — a correct-answer text field plus 3 incorrect-answer fields for multiple-choice, or a True/False picker for boolean (incorrect answer is derived as the opposite value).
- On submit, `FirebaseService.addCustomQuestion()` does an auto-id `addDoc` into `custom_questions`; a success state offers "Add another" (resets the form) or "Back to game". Reachable from a link on the game-setup screen and from the profile section of the top-bar auth menu.

### 1.2 Question sourcing

`TriviaService` is the single entry point for fetching quiz questions (`getQuestions(config)`), and normalizes both sources into one shared `TriviaQuestion` shape:

- **Open Trivia DB** (`source: 'open_trivia'`): calls `GET https://opentdb.com/api.php` with `amount`, optional `category` (resolved from name → numeric ID via the cached categories list), and optional `difficulty`. Returns `[]` if the API reports a non-zero `response_code` (e.g. not enough questions available).
- **Custom** (`source: 'custom'`): reads all documents from the Firestore `custom_questions` collection, filters client-side by category/difficulty, shuffles, and takes the requested amount.
- **Mixed** (`source: 'mixed'`): splits the requested amount roughly in half between the two sources (Open Trivia questions are best-effort — a failure there is swallowed so a slow/broken third-party API doesn't sink a mixed game), merges, shuffles, and trims to the exact requested count.

Shared normalization for every question:

- HTML entities in question/category/answer text (as returned by Open Trivia DB, e.g. `&quot;`, `&#039;`) are decoded safely via an inert `DOMParser` document (chosen specifically to avoid the classic innerHTML-based decoding XSS footgun).
- Answers (`correct_answer` + `incorrect_answers`) are merged into a single `all_answers` array and shuffled with a Fisher–Yates shuffle, so the correct answer's position varies per question/render.

### 1.3 State management

`GameControllerService` is a single injectable, app-wide store (Angular signals, no NgRx/state library) holding the entire lifecycle of an in-progress game: config, question list, current index, score, loading/error state, and derived signals (`totalQuestions`, `currentQuestion`, `isLastQuestion`, `percentage`). It also owns navigation between the three routes, so components stay thin and mostly declarative.

### 1.4 Custom question bank

Firestore collection `custom_questions` acts as a first-party question bank alongside Open Trivia DB. It's populated both manually via the Firebase console and by players themselves through the in-app **Add a question** screen (`/add-question`, §1.1) — gated to fully authenticated accounts (same anti-flood rule as the leaderboard) and validated server-side by `firestore.rules` (§3). There's no in-app way to edit or delete an existing question yet — `custom_questions` writes are `create`-only from the client; that's still console-only.

### 1.5 Authentication & the leaderboard

Every visitor gets a **Firebase Anonymous Auth** uid the moment the app loads (`AuthService.ensureSignedIn()`, called once from the root `App` component) — there's no sign-in wall before playing. Signing in with a real provider is optional and only needed to save a score to the leaderboard.

- **Top bar** (`TopBarComponent`, rendered as a sibling of `<router-outlet>` in `app.html`) shows a sign-in trigger top-right on every screen. It's a self-contained, removable component — dropping it (or gating it behind `EmbedModeService`, see below) leaves just the game panel.
- **Sign-in options**: Google and email/password are the prominent choices; a "more sign-in options" disclosure reveals Facebook, GitHub, Microsoft, Apple, Twitter/X, and Yahoo (`AuthService.signInWithOAuth`). Play Games and Game Center are Firebase console options with no Web SDK equivalent (native Android/Apple only) and are intentionally not offered here.
- **Anonymous-to-real upgrade**: signing in from an anonymous session links the new credential to the existing uid (`linkWithCredential`/`linkWithPopup`) instead of minting a new one, so anything already saved carries forward. If that credential already belongs to another account, it falls back to a normal sign-in (switching uid).
- **Lazy OAuth popup resolver**: `AuthService` calls `initializeAuth(app, { persistence: browserLocalPersistence })` — deliberately _not_ the `getAuth()` convenience wrapper, which wires in `browserPopupRedirectResolver` unconditionally and, as a side effect, eagerly loads a third-party iframe on the Firebase `authDomain` (plus Google's gapi.js) on every page load to check for a pending redirect result, whether or not that visitor ever uses OAuth. Since most visitors only ever play anonymously, `signInWithOAuth` instead passes `browserPopupRedirectResolver` explicitly at call time, so that iframe/script only loads for someone actually clicking a provider button. Confirmed via a Lighthouse best-practices "third-party cookies" audit failure on a real (non-Incognito) browser profile that reproduced only when that iframe loaded — a network trace before/after this change showed the `firebaseapp.com/__/auth/iframe` and `apis.google.com` requests disappearing entirely from the anonymous-only page-load path.
- **Email alias blocking**: sign-up rejects `name+tag@domain.com`-style addresses client-side (`isAliasEmail`, `utils/email-alias.util.ts`) — this stops the UI from creating alias accounts but not a direct Auth API call; see the anti-cheat note below.
- **Email verification**: an email/password account is not treated as "fully authenticated" (`AuthService.isFullyAuthenticated`) until its email is verified. Anonymous and unverified-password users can play and view the leaderboard but the "Save Score" action is replaced with a sign-in/verify prompt.
- **Anti-cheat enforcement is server-side, in `firestore.rules`**, not just the client: a leaderboard write is only accepted if `request.auth.token.firebase.sign_in_provider` isn't `anonymous`, and — for password accounts — `email_verified` is `true`. This is what actually stops someone from bypassing the UI to flood the board with throwaway accounts; the client-side gating above is just so the UI reflects the same rule.
- **`EmbedModeService`** reads `?embed=1` from the URL to hide the top bar entirely for iframe/widget use — anonymous-only play, no leaderboard saves, no code changes needed on the embedder's side.

---

## 2. Frameworks, Tools & Libraries

### 2.1 Core stack

| Layer                   | Technology                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Framework               | **Angular 22** (standalone components, signals, `@if`/`@for` control-flow syntax, `OnPush` change detection throughout)                    |
| Language                | **TypeScript ~6.0**                                                                                                                        |
| Styling                 | **Tailwind CSS 4** (via `@tailwindcss/postcss`), utility classes only — no component CSS frameworks                                        |
| Backend-as-a-service    | **Firebase** — Firestore (data), Auth (anonymous + Google/email/Facebook/GitHub/Microsoft/Apple/Twitter-X/Yahoo), Hosting (static deploy). |
| Reactive/async plumbing | **RxJS 7.8** (`Observable`s in the Firebase/Trivia services, `firstValueFrom` to bridge to async/await)                                    |
| HTTP                    | Angular's `HttpClient` (`provideHttpClient()`), used for Open Trivia DB calls                                                              |
| Forms                   | Angular `ReactiveFormsModule` (game setup) and `FormsModule` + `ngModel` (game-over name input)                                            |
| Routing                 | Angular Router with lazy-loaded (`loadComponent`) standalone routes                                                                        |

### 2.2 Tooling

- **Angular CLI 22** (`@angular/cli`, `@angular/build`) — build, dev-server, scaffolding.
- **Vitest 4** — the project's unit test runner (Angular CLI's new default test builder, `@angular/build:unit-test`), using **jsdom** as the DOM environment. Run via `npm test` (`ng test`).
- **Cypress 15** — end-to-end tests (`npm run e2e` / `npm run e2e:open`), driven against a real local Firebase Emulator Suite instance rather than mocks; see §4.3.
- **firebase-admin** (devDependency) — used only from Cypress's Node-side tasks to seed/reset emulator Auth users and Firestore docs, bypassing `firestore.rules`; never shipped in the app bundle.
- **@lhci/cli (Lighthouse CI) 0.15** — audits the production build's performance/accessibility/best-practices/SEO scores (`npm run lighthouse`); see §4.4.
- **Prettier 3** — code formatting; configured for 100-char print width, single quotes, and the Angular HTML parser for `.html` templates (`.prettierrc`).
- **PostCSS** — pipes Tailwind through `@tailwindcss/postcss` (`.postcssrc.json`).
- **EditorConfig** — enforces 2-space indentation, UTF-8, single quotes in TS across editors.
- **Firebase CLI** (`firebase-tools`) — local emulation and deployment; invoked both from local npm scripts and CI.

### 2.3 Firebase client integration details

`FirebaseService` and `AuthService` wrap the Firebase modular SDK (`firebase/app`, `firebase/firestore`, `firebase/auth`) directly — **no AngularFire** — by design, so they can later be reused unmodified in non-Angular shells (e.g. Capacitor/Tauri) per an in-code comment.

Notably, the app **never commits a Firebase config/API key to source**. Instead it fetches `/__/firebase/init.json` at runtime — a reserved endpoint that Firebase Hosting auto-generates for whatever project is serving the current origin. In local dev, `src/proxy.conf.json` proxies that path to the live Hosting site (`https://intellectura-3b26a.web.app`) so `ng serve` gets a real config without any secrets in the repo. `FirebaseAppService.getApp()` fetches that config and calls `initializeApp` exactly once, shared by both Firestore and Auth.

All Firestore calls (`getCustomQuestions`, `saveHighScore`, `getTopScores`) are wrapped in a `withTimeout()` helper (10s) — the Firestore SDK's promises never reject on their own if the backend is unreachable (e.g. placeholder/misconfigured credentials), which would otherwise leave the UI stuck in a permanent loading state.

---

## 3. Data Model (Firestore)

### `custom_questions` — first-party question bank

```
category: string
type: 'multiple' | 'boolean'
difficulty: 'easy' | 'medium' | 'hard'
question: string
correct_answer: string
incorrect_answers: string[]
```

- **Read**: public (`allow read: if true`)
- **Create**: requires a "real" account — same `isRealAuthedUser()` gate as the leaderboard (non-anonymous, and email-verified if it's a password account) — plus schema validation (`isValidCustomQuestion()`: exact key set, `type` in `['multiple','boolean']`, `difficulty` in `['easy','medium','hard']`, string length bounds, `incorrect_answers` a list of 1–5 entries). Written from the client via the `/add-question` screen (§1.1, §1.4).
- **Update / Delete**: none from the client (`allow update, delete: if false`) — console-only for now.

### `leaderboard` — high scores

```
uid: string            (doc ID; must equal request.auth.uid)
name: string          (1–30 chars)
score: int             (>= 0)
totalQuestions: int    (>= score)
percentage: number     (0–100)
createdAt: int         (epoch ms)
```

- **Read**: public.
- **Create / Update**: requires a non-anonymous, (if password-based) email-verified caller writing to their own uid's doc — schema is strictly validated in `firestore.rules` (exact key set, types, bounds) and an update is only accepted if `score` improves on the existing value.
- **Delete**: disallowed.
- One document per user (doc ID == uid) — the client `setDoc`s unconditionally and lets the rules reject non-improving writes; a rejected write means "not a new personal best", not necessarily an error.

No composite indexes are currently defined (`firestore.indexes.json` is empty); the leaderboard's `orderBy('score', 'desc').limit(10)` query only needs the automatic single-field index.

---

## 4. Deployment & CI/CD

### 4.1 Hosting configuration (`firebase.json`)

- Hosting serves the compiled Angular app from `dist/trivia-app/browser`.
- SPA rewrite: all paths (`**`) fall back to `/index.html` (client-side routing).
- **Header rule ordering matters here**: the catch-all `**` headers rule (no-cache + `Cross-Origin-Opener-Policy: same-origin-allow-popups`, needed so Firebase Auth's popup-sign-in polling can read `popup.closed` without the browser blocking it — see §1.5) is listed _first_, with the more specific hashed-asset rules (`**/*.@(js|css)`, images/fonts) listed _after_ — Hosting applies the last-declared matching rule per header key, so the specific rules' `immutable` `Cache-Control` correctly overrides the broad one for those paths. An earlier version of this scoped the no-cache/COOP headers to the literal `source: "/index.html"`, which silently never matched any real request — every route (`/`, `/play`, `/game-over`, ...) is served via the `**` rewrite above, never a literal request for `/index.html` itself.
- Local emulator ports: Firestore `8080`, Auth `9099`, Hosting `5000`, plus the Emulator UI. `singleProjectMode` is enabled. The Auth emulator exists solely for the e2e suite (§4.3) — the app never talks to it outside that configuration.

### 4.2 GitHub Actions workflow (`.github/workflows/firebase-deploy.yml`)

**Trigger**: fires only when a pull request targeting `main` is **closed and merged** (not just closed).

Steps:

1. Checkout `main`.
2. Set up Node 22 (with npm cache).
3. `npm ci`.
4. `npm run build:prod` (production Angular build).
5. Deploy the built app to **Firebase Hosting** via `FirebaseExtended/action-hosting-deploy@v0` (channel: `live`), authenticated with the `FIREBASE_SERVICE_ACCOUNT_INTELLECTURA_3B26A` repo secret.
6. Deploy **Firestore rules + indexes** separately via `npx firebase-tools@13 deploy --only firestore:rules,firestore:indexes`, using the same service account written to a temp `GOOGLE_APPLICATION_CREDENTIALS` file.
7. Always clean up the temp service-account credentials file, even on failure.

Job permissions are scoped to `contents: read`, `checks: write`, `pull-requests: write` — the minimum needed for the hosting-deploy action to post a check/PR comment (this was tightened in a dedicated fix after the action initially hit a 403).

This is a **merge-to-deploy** pipeline: every PR merged into `main` auto-deploys hosting + Firestore rules/indexes to the single production project (`intellectura-3b26a`). It deliberately doesn't re-run e2e itself — see §4.2a for why that's still safe.

### 4.2a Preview channel deploy + real-preview e2e (`.github/workflows/firebase-preview.yml`)

**Trigger**: every PR targeting `main`, on open/sync/reopen (not close — that's what §4.2 handles on merge). A `concurrency` group keyed on the PR number cancels a stale in-flight run if the PR gets pushed again before it finishes.

Two sequential jobs:

1. **`deploy-preview`** — checkout → Node 22 → `npm ci` → `npm run build:prod` → `FirebaseExtended/action-hosting-deploy@v0` deploying to an ephemeral channel named `pr-<number>` (7-day expiry) instead of `channelId: live`. The action posts/updates a PR comment with the preview URL on every push. The step's `urls` JSON output is parsed (`jq`) into a job output consumed by the next job.
2. **`e2e-preview`** (job name `E2E (preview)`) — runs a scoped slice of the Cypress suite (§4.3) against the just-deployed preview URL, hitting the **real** `intellectura-3b26a` project instead of an emulator.

Preview channels are a **Hosting-only** feature — there's still a single Firestore database for the project, so a preview build (and its e2e run) reads/writes the same production `custom_questions`/`leaderboard` data as `main` and live. Firestore rules/indexes are also not redeployed per-preview (they're project-wide, not channel-scoped); only §4.2's merge pipeline touches them. There is no isolated staging _database_ — just an isolated hosting URL, backed by production data, that's now also exercised end-to-end before merge.

`E2E (preview)` is configured as a **required status check** on `main` branch protection, so a PR can't be merged (and therefore can't trigger §4.2's deploy) unless the real deployed preview actually passed e2e — see the note at the top of `firebase-deploy.yml`.

### 4.3 E2E testing (Cypress + Firebase Emulator Suite)

- Suite lives under `cypress/e2e/unauthenticated/` (anonymous game flow across all three question sources, route guards, embed mode) and `cypress/e2e/authenticated/` (email sign-up + verification, sign-in, saving a score, profile management), run via `npm run e2e` (headless) or `npm run e2e:open` (interactive).
- Both commands wrap `firebase emulators:exec --project demo-trivia-app-e2e --only auth,firestore`, which starts a throwaway local Firestore + Auth emulator pair, runs the wrapped command, and always tears the emulators down afterward — no real project is ever touched.
- The app itself only connects to the emulators when built with the dedicated `e2e` Angular configuration (`ng serve --configuration=e2e`, see §4.5): `FirebaseAppService` skips the `/__/firebase/init.json` fetch and uses a hardcoded `demo-trivia-app-e2e` config instead, and `AuthService`/`FirebaseService` call `connectAuthEmulator`/`connectFirestoreEmulator`.
- `cypress/tasks/firebase-emulator-tasks.ts` uses `firebase-admin` (talking to the emulators only) to reset all Auth users/Firestore docs before every test, seed `custom_questions`/`leaderboard` documents bypassing `firestore.rules`, create already-verified users, and fetch pending email-verification links from the Auth emulator's testing REST endpoint — the same mechanism the real "resend verification email" UI flow is exercised against.
- Two real bugs were found and fixed by this suite: a race in `AuthService.ensureSignedIn()` where a returning user's persisted session could be clobbered by a fresh anonymous sign-in (fixed with `auth.authStateReady()`), and a stale-UI bug where linking an anonymous session to a real credential mutates the Firebase `User` object in place without firing `onAuthStateChanged`, so `isAnonymous`/`isFullyAuthenticated` never updated until fixed by explicitly re-pushing the user into the auth signal after linking.
- CI: `.github/workflows/e2e.yml` runs the full suite on every PR targeting `main` (and on push to `main`), separately from the merge-to-deploy pipeline in §4.2.

**Running the same suite against a real preview instead of the emulator** (`cypress.preview.config.ts`, driven by the `e2e-preview` job in §4.2a): a deliberately narrower slice, because this hits the real, persistent, public `intellectura-3b26a` project — there's no throwaway emulator to reset:

- `specPattern` includes all of `cypress/e2e/unauthenticated/` plus only `sign-in-save-score.cy.ts` and `profile.cy.ts` from `cypress/e2e/authenticated/`. `sign-up-verify.cy.ts` is excluded permanently: it depends on the Auth emulator's testing-only `oobCodes` REST endpoint to read a verification link, which has no real-Auth equivalent without a live mailbox.
- `cypress/tasks/firebase-preview-tasks.ts` is the real-project counterpart to `firebase-emulator-tasks.ts` — same task names/shapes (sharing types from `cypress/tasks/types.ts`) but **no blanket `resetBackend`**. Instead, every uid/doc a test creates (explicitly via a seed task, or implicitly — every `cy.visit()` triggers the app's own anonymous sign-in) is tracked in-process and swept up by a `finalCleanup` task, called from an `after()` hook in `cypress/support/e2e.preview.ts`. `cypress/support/preview-commands.ts` adds `trackCurrentSessionUid()`, called in an `afterEach`, which reads the Firebase-persisted uid straight out of the app's own `localStorage` (`browserLocalPersistence`, see §1.5) so even the ambient anonymous user from a plain page visit gets cleaned up, not just uids created via an explicit task call.
- The two authenticated specs' previously-hardcoded fixture IDs (`existing-leader`, `q1`/`q2`) were made unique per run (timestamp-suffixed) so two preview deploys running concurrently against the same real project never race on the same document.
- Credentials: the same `FIREBASE_SERVICE_ACCOUNT_INTELLECTURA_3B26A` secret used elsewhere in CI, written to a temp file and picked up via `GOOGLE_APPLICATION_CREDENTIALS` (Admin SDK default credential lookup) — never the `FIRESTORE_EMULATOR_HOST`/`FIREBASE_AUTH_EMULATOR_HOST` env vars the emulator tasks rely on.
- Run locally with `npm run e2e:preview` (needs `PREVIEW_URL` and `GOOGLE_APPLICATION_CREDENTIALS` set — the latter only matters for specs that seed/create via `firebase-preview-tasks.ts`; unauthenticated specs run fine without it).
- **`cypress/support/e2e.preview.ts` patches `window.fetch` for `/__/firebase/init.json` specifically**, before any app code runs, serving a real response fetched separately via `cy.request()`. Root cause: Cypress reserves paths starting with `/__` for its own runner/iframe machinery, which collides with Firebase Hosting's own `/__/` reserved namespace — _any_ request to a `/__/`-prefixed path (real endpoint or not) simply hangs forever when made as a real browser request inside a Cypress-controlled tab, confirmed across Electron and real Chrome, regardless of network/DNS/IPv6/QUIC (all ruled out first). `cy.intercept()` stubbing the same URL didn't help either, since it's routed through the same proxy layer that mishandles the path — only a direct `window.fetch` override, bypassing Cypress's browser-facing network layer entirely, actually works. `cy.request()` (Cypress's own Node-side HTTP client, never going through the browser) is unaffected and used to fetch the real config for the patch to serve.

### 4.4 Lighthouse CI (performance / accessibility / best-practices / SEO)

- `lighthouserc.json` drives both local (`npm run lighthouse`) and CI (`.github/workflows/lighthouse.yml`) runs identically: builds with the dedicated `lighthouse` Angular configuration (same optimizations/budgets as `production`, but with `fileReplacements` swapping in `environment.e2e.ts` like the `e2e` config does — see §4.5), starts the Firebase Emulator Suite (`hosting`, `auth`, `firestore`) via `firebase emulators:exec --project demo-trivia-app-e2e`, and runs Lighthouse 3× against `http://127.0.0.1:5000/` (the Hosting emulator, serving the real build), asserting each category's median score.
- **This intentionally serves from the Hosting emulator, not a bare static server**: only Hosting (real or emulated) resolves the reserved `/__/firebase/init.json` endpoint, so this is what lets `FirebaseAppService` actually initialize and `AuthService`/`FirebaseService` actually run anonymous sign-in and Firestore reads against the local emulators — exercising the real runtime code paths instead of everything failing silently. An earlier version of this check served a bare static build instead; that setup measured a _better_ best-practices score (Firebase never initialized at all, so nothing could log a runtime error) which would have masked exactly the class of regression this check exists to catch — first caught when a real Chrome DevTools run against the live production URL showed something not reflected by CI at all (turned out to be an unrelated noisy manual run — see below — but the gap in methodology was real).
- Thresholds: performance ≥ 0.75 (measured 0.77–0.89 across local + emulator-backed runs, and 0.89 on a clean headless run against the live production URL — kept lower than that for CI-runner performance variance, since timing metrics like FCP/TBT are inherently less stable across machines); accessibility/best-practices/SEO ≥ 0.95 (all measured a clean 1.0 once Firebase genuinely initializes).
- A clean, extension-free, headless CLI run (`npx lighthouse <url> --chrome-flags="--headless=new"`) against the real deployed site is the trustworthy way to spot-check a production regression — a manual Chrome DevTools run can be skewed by browser extensions, a non-Incognito profile, or leftover site data, none of which reflect a real visitor's or CI's measurement.
- Reports (HTML + JSON) are uploaded as a `lighthouse-reports` build artifact on every CI run, pass or fail.

### 4.5 Local npm scripts (`package.json`)

```
npm start              # ng serve (dev server, proxies /__/firebase/** to live Hosting)
npm run build          # ng build (dev config)
npm run build:prod     # ng build --configuration production
npm run watch          # ng build --watch --configuration development
npm test               # ng test (Vitest + jsdom)
npm run e2e            # Cypress e2e suite (headless) against the Firebase Emulator Suite
npm run e2e:open       # same, but with the interactive Cypress runner
npm run e2e:preview    # scoped Cypress suite against a real deployed preview (needs PREVIEW_URL + GOOGLE_APPLICATION_CREDENTIALS)
npm run lighthouse     # build:prod, then Lighthouse CI against a local static server
npm run firebase:emulate  # build:prod, then firebase emulators:start
npm run firebase:deploy   # build:prod, then firebase deploy --only hosting,firestore
```

Package manager is pinned via `"packageManager": "npm@11.12.1"`.

### 4.6 Environments

- `.firebaserc` pins the default (and only) Firebase project to `intellectura-3b26a`.
- `src/environments/environment.ts` / `environment.development.ts` carry `production` and `useEmulators` flags — no secrets or API keys live here, consistent with the runtime-config-fetch approach described in §2.3.
- `src/environments/environment.e2e.ts` sets `useEmulators: true` and is swapped in only by the `e2e` build/serve configuration (`angular.json`, `fileReplacements`) used by the Cypress suite (§4.3) — never by `start`/`build`/`build:prod`.
- Production build budgets (`angular.json`): 500 KB warning / 1 MB error (initial bundle), 4 KB warning / 8 KB error (per component style); output hashing enabled for cache-busting.

---

## 5. Project History (from commit log)

1. **Initial scaffold** — Angular + Firebase + Open Trivia DB, "Phase 1" of the trivia app (setup/play/game-over flow, services, Tailwind).
2. **Firebase Hosting integration** — connected the app to the `intellectura-3b26a` Firebase project.
3. **CI fix** — granted `checks`/`pull-requests` write permissions to resolve a 403 from the Hosting deploy GitHub Action.
4. **CI enhancement** — added automatic Firestore rules/indexes deployment on merge (previously only Hosting deployed).
5. **Tooling** — added an Angular CLI analytics ID to `angular.json`.

---

## 6. Known Gaps / Not Yet Implemented

- Email-alias blocking is client-side only (regex on sign-up) — a determined user could still call the Auth API directly to create alias accounts. Closing that gap requires a Firebase Auth blocking Cloud Function (`beforeCreate`), which needs the Blaze plan and a `functions/` CI deploy step; scoped out for now. The rules-enforced "not anonymous, verified if password" check is the actual anti-flood defense and doesn't depend on this.
- Play Games and Game Center sign-in are listed in the Firebase console but not offered in the app — no Web SDK equivalent exists for either (native Android/Apple only).
- The `/add-question` screen only supports *creating* a question — no in-app way to edit or delete an existing `custom_questions` doc yet (console-only for now, per the rules comments). There's also no moderation/review step: any fully authenticated account can add directly to the shared, public bank.
- The e2e suite (§4.3) covers the core unauthenticated/authenticated flows but not OAuth sign-in (Google/Facebook/etc. — popup-based, not practical to automate against the emulator), the "mixed" question source end-to-end (unit-level coverage only), or the `/add-question` screen (no spec yet).
- The `E2E (preview)` job (§4.2a) needs to actually be turned on as a required status check in GitHub branch protection settings for `main` — it's not enforced yet. GitHub Actions jobs can't gate a merge on their own; that has to come from branch protection, and setting it up needs repo-admin access that CI/automation credentials don't have.
