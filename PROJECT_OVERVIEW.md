# Trivia App — Project Overview

A single-page trivia quiz game built with Angular, styled with Tailwind CSS, and backed by Firebase (Firestore for data, Hosting for deployment). It pulls questions from the public Open Trivia DB API and/or a custom Firestore-backed question bank, runs a timed multiple-choice quiz, and tracks a global high-score leaderboard.

Live project: Firebase project `intellectura-3b26a` · Repo: `shermam/trivia`

---

## 1. Application Functionality

### 1.1 Game flow

The app is a three-screen flow, implemented as three lazily-loaded standalone Angular routes:

| Route | Component | Purpose |
|---|---|---|
| `/` | `GameSetupComponent` | Configure and start a new game |
| `/play` | `QuizLoopComponent` | Answer questions one at a time, against a timer |
| `/game-over` | `GameOverComponent` | Show final score, submit to leaderboard, view top 10 |

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
- Lets the player enter a name (≤30 chars) and submit their score once to the Firestore `leaderboard` collection (submission is disabled after the first successful save for that session).
- Displays the **top 10 leaderboard**, sorted by score descending, loaded from Firestore and refreshed after a successful save.
- "Play Again" resets all in-memory game state and returns to `/`.

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

Firestore collection `custom_questions` acts as a first-party question bank alongside Open Trivia DB. There is currently **no in-app admin UI** to write to it — per the Firestore rules, it's read-only from the client and intended to be populated manually via the Firebase console or a future admin tool.

---

## 2. Frameworks, Tools & Libraries

### 2.1 Core stack

| Layer | Technology |
|---|---|
| Framework | **Angular 22** (standalone components, signals, `@if`/`@for` control-flow syntax, `OnPush` change detection throughout) |
| Language | **TypeScript ~6.0** |
| Styling | **Tailwind CSS 4** (via `@tailwindcss/postcss`), utility classes only — no component CSS frameworks |
| Backend-as-a-service | **Firebase** — Firestore (data) + Hosting (static deploy). No Firebase Auth is used. |
| Reactive/async plumbing | **RxJS 7.8** (`Observable`s in the Firebase/Trivia services, `firstValueFrom` to bridge to async/await) |
| HTTP | Angular's `HttpClient` (`provideHttpClient()`), used for Open Trivia DB calls |
| Forms | Angular `ReactiveFormsModule` (game setup) and `FormsModule` + `ngModel` (game-over name input) |
| Routing | Angular Router with lazy-loaded (`loadComponent`) standalone routes |

### 2.2 Tooling

- **Angular CLI 22** (`@angular/cli`, `@angular/build`) — build, dev-server, scaffolding.
- **Vitest 4** — the project's unit test runner (Angular CLI's new default test builder, `@angular/build:unit-test`), using **jsdom** as the DOM environment. Run via `npm test` (`ng test`).
- **Prettier 3** — code formatting; configured for 100-char print width, single quotes, and the Angular HTML parser for `.html` templates (`.prettierrc`).
- **PostCSS** — pipes Tailwind through `@tailwindcss/postcss` (`.postcssrc.json`).
- **EditorConfig** — enforces 2-space indentation, UTF-8, single quotes in TS across editors.
- **Firebase CLI** (`firebase-tools`) — local emulation and deployment; invoked both from local npm scripts and CI.

### 2.3 Firebase client integration details

`FirebaseService` wraps the Firebase modular SDK (`firebase/app`, `firebase/firestore`) directly — **no AngularFire** — by design, so it can later be reused unmodified in non-Angular shells (e.g. Capacitor/Tauri) per an in-code comment.

Notably, the app **never commits a Firebase config/API key to source**. Instead it fetches `/__/firebase/init.json` at runtime — a reserved endpoint that Firebase Hosting auto-generates for whatever project is serving the current origin. In local dev, `src/proxy.conf.json` proxies that path to the live Hosting site (`https://intellectura-3b26a.web.app`) so `ng serve` gets a real config without any secrets in the repo. Firestore is then lazily initialized exactly once from that config.

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
- **Write**: none from the client (`allow write: if false`) — console/admin-tool only.

### `leaderboard` — high scores
```
name: string          (1–30 chars)
score: int             (>= 0)
totalQuestions: int    (>= score)
percentage: number     (0–100)
createdAt: int         (epoch ms)
```
- **Read**: public.
- **Create**: public, but strictly schema-validated in `firestore.rules` (exact key set, types, and bounds enforced server-side).
- **Update / Delete**: disallowed — the leaderboard is append-only.

No composite indexes are currently defined (`firestore.indexes.json` is empty); the leaderboard's `orderBy('score', 'desc').limit(10)` query only needs the automatic single-field index.

---

## 4. Deployment & CI/CD

### 4.1 Hosting configuration (`firebase.json`)
- Hosting serves the compiled Angular app from `dist/trivia-app/browser`.
- SPA rewrite: all paths (`**`) fall back to `/index.html` (client-side routing).
- Local emulator ports: Firestore `8080`, Hosting `5000`, plus the Emulator UI.

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

This is a **merge-to-deploy** pipeline: every PR merged into `main` auto-deploys hosting + Firestore rules/indexes to the single production project (`intellectura-3b26a`); there's no separate staging environment or preview-channel deploy step configured.

### 4.3 Local npm scripts (`package.json`)
```
npm start              # ng serve (dev server, proxies /__/firebase/** to live Hosting)
npm run build          # ng build (dev config)
npm run build:prod     # ng build --configuration production
npm run watch          # ng build --watch --configuration development
npm test               # ng test (Vitest + jsdom)
npm run firebase:emulate  # build:prod, then firebase emulators:start
npm run firebase:deploy   # build:prod, then firebase deploy --only hosting,firestore
```
Package manager is pinned via `"packageManager": "npm@11.12.1"`.

### 4.4 Environments
- `.firebaserc` pins the default (and only) Firebase project to `intellectura-3b26a`.
- `src/environments/environment.ts` / `environment.development.ts` currently only carry a `production` boolean flag — no secrets or API keys live here, consistent with the runtime-config-fetch approach described in §2.3.
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

- No authentication — the leaderboard and question bank are fully anonymous/public, protected only by Firestore security rules.
- No admin UI for writing to `custom_questions` (console-only for now, per the rules comments).
- No end-to-end test suite (`ng e2e` is not configured — README explicitly notes Angular CLI doesn't bundle one).
- No staging/preview deploy channel — CI only deploys straight to production on merge to `main`.
