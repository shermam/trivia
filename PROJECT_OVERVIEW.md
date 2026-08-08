# Trivia App — Project Overview

A single-page trivia quiz game built with Angular, styled with Tailwind CSS, and backed by Firebase (Firestore for data, Cloud Functions for backend logic, Hosting for deployment). It pulls questions from the public Open Trivia DB API and/or a custom Firestore-backed question bank, runs a timed multiple-choice quiz, and tracks a global high-score leaderboard. A paid **Pro tier** ($0.99/month, via Stripe) unlocks the ability to contribute questions to the shared bank.

Live project: Firebase project `intellectura-3b26a` · Repo: `shermam/trivia`

---

## 1. Application Functionality

### 1.1 Game flow

The app is a five-screen flow, implemented as five lazily-loaded standalone Angular routes:

| Route           | Component              | Purpose                                                                    |
| --------------- | ---------------------- | -------------------------------------------------------------------------- |
| `/`             | `GameSetupComponent`   | Configure and start a new game                                             |
| `/play`         | `QuizLoopComponent`    | Answer questions one at a time, against a timer                            |
| `/game-over`    | `GameOverComponent`    | Show final score, submit to leaderboard, view top 10                       |
| `/add-question` | `AddQuestionComponent` | Submit a new question to the custom question bank (**Pro only**, see §1.6) |
| `/pricing`      | `PricingComponent`     | Compare Starter vs. Pro and subscribe via Stripe Checkout (§1.6)           |

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
- Shows final score (`X / N`) and accuracy percentage, plus a derived performance label ("Outstanding!" / "Great job!" / "Good effort!" / "Keep practicing!" based on accuracy).
- If fully authenticated (see §1.5), lets the player enter a name (≤30 chars, prefilled from their profile) and submit their score to the Firestore `leaderboard` collection — one entry per account, keeping their best score. Anonymous or unverified players see a sign-in/verify prompt instead of the form.
- Displays the **top 10 leaderboard**, sorted by score descending, loaded from Firestore and refreshed after a successful save. After a successful save, if the player's own entry is present in that fetched top 10, their row is highlighted and their rank ("You're ranked #N on the leaderboard") is shown — derived entirely from the already-fetched top-10 list (matched by `uid`), not a dedicated rank query, so a saved score outside the top 10 shows no rank claim rather than an invented one.
- "Play Again" resets all in-memory game state and returns to `/`.

**Add a question (`/add-question`)**

- Lets a **fully authenticated Pro subscriber** (leaderboard's anti-flood gate, §1.5, _plus_ an active Pro subscription, §1.6) submit a new question to the shared `custom_questions` bank. Anonymous or unverified players see the same sign-in/verify prompts as game-over; a fully authenticated but non-Pro account sees a friendly "Upgrade to Pro" empty state with a CTA to `/pricing` instead of the form.
- Reactive form: free-text category (with `<datalist>` suggestions from the same cached Open Trivia category list used by game setup, so a submitted category can actually be filtered on later), difficulty, question type (multiple-choice vs. true/false), the question text, and answers — a correct-answer text field plus 3 incorrect-answer fields for multiple-choice, or a True/False picker for boolean (incorrect answer is derived as the opposite value).
- On submit, the ID token is force-refreshed (`AuthService.refreshIdToken()`) immediately before the write, so a just-granted `stripeRole` claim is never stale at the exact moment `firestore.rules` checks it — then `FirebaseService.addCustomQuestion()` does an auto-id `addDoc` into `custom_questions`; a success state offers "Add another" (resets the form) or "Back to game". Reachable (with a PRO badge) from a link on the game-setup screen and from the profile section of the top-bar auth menu.

**Pricing (`/pricing`)**

- Compares **Starter** (free: unlimited games, leaderboard) against **Pro** ($0.99/month: everything in Starter, plus creating custom questions). See §1.6 for the full subscription flow this page drives.

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

Firestore collection `custom_questions` acts as a first-party question bank alongside Open Trivia DB. It's populated both manually via the Firebase console and by players themselves through the in-app **Add a question** screen (`/add-question`, §1.1) — gated to fully authenticated accounts _with an active Pro subscription_ (§1.6) and validated server-side by `firestore.rules` (§3). There's no in-app way to edit or delete an existing question yet — `custom_questions` writes are `create`-only from the client; that's still console-only.

### 1.5 Authentication & the leaderboard

Every visitor gets a **Firebase Anonymous Auth** uid the moment the app loads (`AuthService.ensureSignedIn()`, called once from the root `App` component) — there's no sign-in wall before playing. Signing in with a real provider is optional and only needed to save a score to the leaderboard.

- **Top bar** (`TopBarComponent`, rendered as a sibling of `<router-outlet>` in `app.html`) shows a persistent `/pricing` nav link, a light/dark theme toggle (§1.7), plus a sign-in trigger top-right on every screen. It's a self-contained, removable component — dropping it (or gating it behind `EmbedModeService`, see below) leaves just the game panel.
- **Sign-in options**: Google and email/password are the prominent choices; a "more sign-in options" disclosure reveals Facebook, GitHub, Microsoft, Apple, Twitter/X, and Yahoo (`AuthService.signInWithOAuth`). Play Games and Game Center are Firebase console options with no Web SDK equivalent (native Android/Apple only) and are intentionally not offered here.
- **Anonymous-to-real upgrade**: signing in from an anonymous session links the new credential to the existing uid (`linkWithCredential`/`linkWithPopup`) instead of minting a new one, so anything already saved carries forward. If that credential already belongs to another account, it falls back to a normal sign-in (switching uid).
- **Lazy OAuth popup resolver**: `AuthService` calls `initializeAuth(app, { persistence: browserLocalPersistence })` — deliberately _not_ the `getAuth()` convenience wrapper, which wires in `browserPopupRedirectResolver` unconditionally and, as a side effect, eagerly loads a third-party iframe on the Firebase `authDomain` (plus Google's gapi.js) on every page load to check for a pending redirect result, whether or not that visitor ever uses OAuth. Since most visitors only ever play anonymously, `signInWithOAuth` instead passes `browserPopupRedirectResolver` explicitly at call time, so that iframe/script only loads for someone actually clicking a provider button. Confirmed via a Lighthouse best-practices "third-party cookies" audit failure on a real (non-Incognito) browser profile that reproduced only when that iframe loaded — a network trace before/after this change showed the `firebaseapp.com/__/auth/iframe` and `apis.google.com` requests disappearing entirely from the anonymous-only page-load path.
- **Email alias blocking**: sign-up rejects `name+tag@domain.com`-style addresses client-side (`isAliasEmail`, `utils/email-alias.util.ts`) — this stops the UI from creating alias accounts but not a direct Auth API call; see the anti-cheat note below.
- **Email verification**: an email/password account is not treated as "fully authenticated" (`AuthService.isFullyAuthenticated`) until its email is verified. Anonymous and unverified-password users can play and view the leaderboard but the "Save Score" action is replaced with a sign-in/verify prompt.
- **Anti-cheat enforcement is server-side, in `firestore.rules`**, not just the client: a leaderboard write is only accepted if `request.auth.token.firebase.sign_in_provider` isn't `anonymous`, and — for password accounts — `email_verified` is `true`. This is what actually stops someone from bypassing the UI to flood the board with throwaway accounts; the client-side gating above is just so the UI reflects the same rule.
- **`EmbedModeService`** reads `?embed=1` from the URL to hide the top bar entirely for iframe/widget use — anonymous-only play, no leaderboard saves, no code changes needed on the embedder's side.

### 1.6 Pro subscription & billing (Stripe)

A single paid tier, "Pro" ($0.99 USD/month), gates the ability to add custom questions (§1.1, §1.4). The whole flow is serverless, backed by a `functions/` Cloud Functions package this repo owns outright (§2.4) rather than a third-party SDK or a marketplace extension — the original implementation used the official "Run Subscriptions with Stripe" Firebase Extension, but that entire product line [announced it's shutting down in March 2027](https://firebase.google.com/docs/extensions/faq-and-troubleshooting) (new installs already blocked at the time this was migrated), so it was replaced with equivalent functions using the _same_ Firestore schema and custom-claim contract — the frontend below didn't need to change shape, only where the data comes from.

- **`SubscriptionService`** is the client-side entry point: a real-time `isProUser` signal derived from the `customers/{uid}/subscriptions` Firestore subcollection (`stripeWebhook` keeps this synced from Stripe, §2.4) filtered to `active`/`trialing` status, `startProCheckout()` (creates a `customers/{uid}/checkout_sessions` doc and waits for `createCheckoutSession` to write back a hosted Stripe Checkout URL, then redirects), and a dynamic Pro-price lookup from the public `products`/`prices` collections (§3) — no Stripe price ID is ever hardcoded client-side, so changing the price in the Stripe Dashboard needs no frontend deploy.
- **The actual security gate is a custom claim, not the Firestore listener above**: `stripeWebhook` sets `stripeRole: 'pro'` on the user's Auth ID token once an active/trialing subscription's price carries `firebaseRole: 'pro'` metadata (set once in the Stripe Dashboard, §4 setup notes), and `firestore.rules` checks that claim directly (`AuthService.isProUser`, §3). `SubscriptionService`'s real-time signal is read-your-own-writes UX only — the moment its Firestore listener sees a subscription go active, it proactively calls `AuthService.refreshIdToken()` so the claim doesn't have to wait on the SDK's ~1hr natural token refresh; `AddQuestionComponent` also force-refreshes immediately before its own write as a last-mile safety net against a stale cached token.
- **Checkout redirect UX**: on success, Stripe returns the browser to `/pricing?checkout=success`, which also surfaces a "Start playing" link back to `/`; on cancel, `/pricing?checkout=cancelled`. `PricingComponent`'s Subscribe button is gated on `AuthService.authReady()` (not just `isAnonymous`/`isFullyAuthenticated`, which both default to `false` before the very first auth state resolves) so a click landing in that brief window can't misfire the "verify your email first" branch. Once subscribed, the Starter card's "Your current plan" label is hidden (only the Pro card's "You're subscribed" shows) so the two don't both claim to be current at once.
- **Nav surfacing**: the top-bar auth-menu and game-setup's "Create custom question" link both show a PRO badge (grey when locked, indigo once subscribed) next to the "Add a question" link.
- **Self-service billing management**: a subscribed user sees a "Manage subscription" link in the auth-menu profile section (replacing the "Upgrade to Pro" link shown to non-Pro users) that opens Stripe's hosted Billing Portal — `SubscriptionService.openBillingPortal()` creates a `customers/{uid}/portal_sessions` doc and waits for `createPortalSession` (`functions/`, §2.4) to write back a portal URL, then redirects; same doc-create-then-listen handshake as `startProCheckout()` above. Lets a subscriber update their payment method or cancel without needing Stripe Dashboard access.

### 1.7 Light/dark theme

A manual toggle in the top bar (sun/moon icon button) switches the whole app between light and dark mode — this is a real user choice, not just following the OS setting.

- **`ThemeService`** (`src/app/services/theme.service.ts`) is a small signal-based service: `toggle()` flips a `currentTheme` signal between `'light'`/`'dark'`, adds/removes a `dark` class on `document.documentElement`, and persists the choice to `localStorage` (`trivia-theme`).
- **Tailwind is repointed at that class**, not its default `prefers-color-scheme` media strategy: `@custom-variant dark (&:where(.dark, .dark *));` in `src/styles.css` makes every `dark:` utility class key off an ancestor `.dark` instead. Every themed template/component pairs its light-mode utility classes with `dark:` variants inline (mapping documented in `BRAND_DESIGN_SYSTEM.md` §1's "Dark Theme" section) rather than a separate dark stylesheet.
- **No flash of the wrong theme on load**: an inline `<script>` in `index.html`, which runs before Angular bootstraps, reads the same `trivia-theme` `localStorage` key (falling back to `prefers-color-scheme: dark` if nothing's stored yet) and applies the `dark` class immediately. `ThemeService`'s constructor just reads that already-applied class back into its signal rather than deciding the initial theme itself, so the two stay in sync by construction.
- Not persisted server-side or per-account — it's a local browser preference, same as most theme toggles.

### 1.8 Installable PWA & offline play

The app is an installable Progressive Web App (scaffolded via `ng add @angular/pwa`, the Angular-recommended path — see `INFRASTRUCTURE.md` §2a for the setup notes) and can start a game with no network connection at all.

- **`public/manifest.webmanifest`**: name/short_name "Trivimind", `theme_color`/icons matching the brand mark (`BRAND_DESIGN_SYSTEM.md` §1's Primary Emerald `#059669`), `display: standalone`, and `icons` at every size Chrome's installability check + Android's home-screen/splash-screen icons need (72–512px, rasterized from `public/favicon.svg` via `rsvg-convert`, `purpose: any` — the source mark wasn't designed with a maskable safe-zone, so it isn't claimed as `maskable`). Linked from `index.html` alongside a `theme-color` `<meta>` tag matching the manifest.
- **`@angular/service-worker`** (`ngsw-config.json`, registered in `app.config.ts` via `provideServiceWorker('ngsw-worker.js', { enabled: !isDevMode() && !navigator.webdriver, registrationStrategy: 'registerWhenStable:30000' })`) precaches the app shell (JS/CSS/HTML/manifest, `installMode: prefetch`) and static assets (icons/fonts, `installMode: lazy`) — this is what makes a repeat visit (and the install prompt itself) work offline, and is Angular's own default asset-group split, left as scaffolded. The `navigator.webdriver` half is not scaffolded — added after a real preview-e2e CI run showed registering/activating the worker measurably slowing down Firebase Auth-dependent specs even with the offline-prefetch task (below) separately gated off the same way: `profile.cy.ts`'s two tests went from ~7s combined to 46s+ with a timeout, `sign-in-save-score.cy.ts` from ~55s to 1m+ with a timeout, confirmed against a clean baseline run with no PWA changes at all. Same reasoning as the prefetch's own `navigator.webdriver` check below — never true for a real user's browser.
- **Offline question pool (`OfflineQuestionsService`, `src/app/services/offline-questions.service.ts`)**: a small IndexedDB-backed store (raw `indexedDB` API, no dependency — same no-added-dependency convention as `FirebaseService`/`AuthService`, §2.3) holding a rolling pool of up to 200 previously-fetched `TriviaQuestion`s, upserted by question text (so re-fetching the same question is a no-op, not a duplicate) and trimmed oldest-first past that cap.
- **Background prefetch (`TriviaService.initOfflinePrefetch()`, called once from the `App` root component's constructor alongside `AuthService.ensureSignedIn()`)**: schedules a best-effort refill of the offline pool up to 100 questions — once when the browser goes idle (`requestIdleCallback`, capped at a 10s timeout; `setTimeout` fallback where unsupported), and again on every `window` `online` event. Fetches a `mixed`-source batch (same Open Trivia DB + `custom_questions` split `getQuestions()` already does) capped at 50 questions per run (Open Trivia DB's own `amount` ceiling) and stores it via `OfflineQuestionsService`. Failures are swallowed — a missed refill just means it retries on the next idle window/reconnect.
- **`TriviaService.getQuestions()` falls back to the offline pool only when the network fetch itself throws** (`TriviaService.playingOffline` signal reflects this) — a legitimate "no questions matched this filter" _result_ (empty array, no error, e.g. a very narrow category/difficulty combo) is left alone. Deliberately does **not** pre-check `navigator.onLine` to skip straight to the offline pool: that property is well-known to misreport `false` in some headless/CI/sandboxed browser environments even when the network is fine — confirmed the hard way when it made a real GitHub Actions preview-e2e run silently serve cached content instead of a perfectly working live Firestore fetch (root-caused via the preview deploy's own screenshot artifact, which showed a random cached Open Trivia question instead of the two just-seeded custom ones). Every underlying network call already has its own timeout, so always attempting the real fetch first costs nothing in the genuinely-offline case.
- **`OfflineQuestionsService.getOfflineQuestions()` never crosses `source`**: a `'custom'` request only ever draws from cached `custom`-sourced questions (never substituting `open_trivia` ones, or vice versa) — this is what the bug above actually surfaced once the `navigator.onLine` fast-path was masking it: the offline pool's `mixed`-source prefetch data was getting served for an explicit `'custom'`-only request. Within a source-scoped pool, category/difficulty are only a _preference_ — falls back to the rest of that same-source pool if too few match, since a mismatched-topic offline game beats no offline game at all.
- **`GameSetupComponent` shows an inline banner** (`ConnectivityService.isOnline`, a small signal-based service listening to `window`'s `online`/`offline` events, same pattern as `ThemeService`) when offline, telling the player how many questions are cached (`OfflineQuestionsService.cachedCount`) before they even submit the form.
- **Disabled under the `e2e`/`lighthouse` Angular build configurations** (`environment.enableOfflinePrefetch`, `false` only in `environment.e2e.ts`) **and under `navigator.webdriver`** (true for every browser-automation framework — Cypress, Selenium, Playwright — by spec, never for a real user's browser): the background prefetch's own `opentdb.com`/Firestore requests would otherwise race Cypress's `cy.wait('@questions')` intercepts and, confirmed live against a real deployed preview, compete for a real, shared, rate-limited backend closely enough on a CI runner to time out unrelated specs. The environment flag alone doesn't cover the preview-e2e job specifically — that one deploys the plain production build (`environment.ts`), which is exactly why the `navigator.webdriver` check exists as a second, environment-independent layer.
- Not wired into `ngsw-config.json`'s `dataGroups` — Open Trivia DB is a third-party, rate-limited API, and `custom_questions` needs Firestore-rules-aware normalization the service worker can't do; the IndexedDB pool above is the deliberate alternative.
- **`ngsw-worker.js` is excluded from `firebase.json`'s blanket `**/*.@(js|css)` immutable-cache rule** (`no-cache` instead, via a dedicated header rule declared after it) — Angular's own guidance is that the service worker script itself must never be cached long-term, or the browser's own update-check mechanism (which needs to re-fetch and byte-compare it) can't detect a new deploy. Caught by inspecting the live preview's actual response headers, not by assumption.

---

## 2. Frameworks, Tools & Libraries

### 2.1 Core stack

| Layer                   | Technology                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework               | **Angular 22** (standalone components, signals, `@if`/`@for` control-flow syntax, `OnPush` change detection throughout)                                                                      |
| Language                | **TypeScript ~6.0**                                                                                                                                                                          |
| Styling                 | **Tailwind CSS 4** (via `@tailwindcss/postcss`), utility classes only — no component CSS frameworks                                                                                          |
| Backend-as-a-service    | **Firebase** — Firestore (data), Auth (anonymous + Google/email/Facebook/GitHub/Microsoft/Apple/Twitter-X/Yahoo), Cloud Functions (Pro subscription backend, §2.4), Hosting (static deploy). |
| Payments                | **Stripe** — Checkout (hosted payment page) + webhooks, driven entirely from `functions/` (§2.4); no Stripe code ships in the Angular bundle.                                                |
| Reactive/async plumbing | **RxJS 7.8** (`Observable`s in the Firebase/Trivia services, `firstValueFrom` to bridge to async/await)                                                                                      |
| HTTP                    | Angular's `HttpClient` (`provideHttpClient()`), used for Open Trivia DB calls                                                                                                                |
| Forms                   | Angular `ReactiveFormsModule` (game setup) and `FormsModule` + `ngModel` (game-over name input)                                                                                              |
| Routing                 | Angular Router with lazy-loaded (`loadComponent`) standalone routes                                                                                                                          |

The visual design system (colors, typography, shadows, radii, component styling directives) is documented in **`BRAND_DESIGN_SYSTEM.md`** — the single reference for styling any new or restyled UI component; there is no Figma export in the repo to cross-check against. Icons are inline SVG (lucide-static path data, ISC license) rendered via a single shared `IconComponent` (`src/app/components/icon/icon.component.ts`) — same no-dependency convention as `ProviderIconComponent`'s OAuth brand marks — rather than an `lucide-angular`/icon-font dependency. `Inter` (the brand typeface) is loaded via a preconnected Google Fonts `<link>` in `index.html` rather than self-hosted, the one deliberate exception to this app's general third-party-request avoidance (§1.5's OAuth-popup-resolver note); Lighthouse (§4.4) is the guardrail that keeps this from silently regressing performance.

App icons (`public/favicon.svg`/`.ico`, `public/apple-touch-icon.png`, linked from `index.html`) are the Trivimind mark: a `#059669` (Primary Emerald, matching `BRAND_DESIGN_SYSTEM.md` §1 exactly) rounded-square (`rx="32"` on a 144×144 box) with a bold white `?` glyph on top. An earlier version used a much more intricate brain/lightbulb/`?` illustration, but that much line art doesn't survive being scaled down to actual favicon sizes (16–32px) — it reads as a blurred blob rather than a mark, no matter how the raster assets are generated — so it was replaced with this single bold glyph, which stays legible from 16px up to a full-size hero icon. `favicon.ico` still embeds six sizes (16 up to 256px), each rasterized directly from the vector. Static icon files hardcode this hex directly (no ambient CSS `color` for a browser-tab/OS icon to inherit from), unlike the in-app mark below.

The same mark is also used in-app as the brand badge — top bar logo, `GameSetupComponent`'s hero icon, and the Pro card badge on `/pricing` — via a dedicated `LogoComponent` (`src/app/components/logo/logo.component.ts`, selector `app-logo`) that inlines the identical SVG (byte-identical path data to `favicon.svg`), fills its background with `fill="currentColor"`, and sets `host: { class: 'inline-block' }` in the `@Component` decorator. Both of those matter: the background is `currentColor` (not a hardcoded hex) so callers set the exact shade via a `text-emerald-600` class on `app-logo` itself, keeping it tied to the same design-system value everywhere instead of a second hardcoded copy that can drift out of sync (as it once did — an earlier hardcoded `#0fa968` didn't quite match Primary). `inline-block` matters because `app-logo` is a real host element wrapping the `<svg>`, not the svg itself — Tailwind's preflight already makes a raw `<svg>` size correctly from its own `width`/`height` attributes (it's a replaced element), but the host has no intrinsic size of its own, so a plain `block` class left it stretching to 100% of its container width; any `rounded-*`/`shadow-*` class on `app-logo` then wrapped that invisible full-width box instead of the icon, producing a left-aligned icon with an elongated shadow trailing off to the right. `LogoComponent` is kept separate from the shared `IconComponent`'s single-color 24×24 stroke-icon `@switch` (same convention as `ProviderIconComponent`'s OAuth brand marks) since it's a fixed filled mark, not a 24×24 stroke glyph. The purely decorative sparkle accents elsewhere (game-setup's "Start Game" button, pricing's "Subscribe" button, add-question's hero badge) still use `IconComponent`'s `sparkles` icon — only the three brand-badge placements above were switched.

### 2.2 Tooling

- **Node 24** — the version floor everywhere: `functions/package.json`'s `engines.node` (the actual Cloud Functions deploy runtime), every CI workflow's `actions/setup-node`, and the repo-root `.node-version` for local `nodenv` users (`nodenv` auto-selects it on `cd` into the repo; other version managers should match it manually until/unless an `.nvmrc` is added). All three are bumped together on purpose, so `npm ci`-vs-local drift and the functions deploy runtime never disagree — see INFRASTRUCTURE.md §7.
- **Angular CLI 22** (`@angular/cli`, `@angular/build`) — build, dev-server, scaffolding.
- **Vitest 4** — the project's unit test runner (Angular CLI's new default test builder, `@angular/build:unit-test`), using **jsdom** as the DOM environment. Run via `npm test` (`ng test`).
- **fake-indexeddb** (devDependency) — polyfills `indexedDB` for `OfflineQuestionsService`'s/`TriviaService`'s unit tests (jsdom itself has no IndexedDB implementation); imported via `fake-indexeddb/auto` at the top of the relevant `.spec.ts` files only, never shipped in the app bundle.
- **@angular/service-worker** — scaffolded via `ng add @angular/pwa` (§1.8); precaches the app shell for offline/installable use. See `INFRASTRUCTURE.md` §2a for the setup notes (including an `ng add` version-pinning pitfall worth knowing before re-running it).
- **Cypress 15** — end-to-end tests (`npm run e2e` / `npm run e2e:open`), driven against a real local Firebase Emulator Suite instance rather than mocks; see §4.3.
- **firebase-admin** (devDependency) — used only from Cypress's Node-side tasks to seed/reset emulator Auth users and Firestore docs, bypassing `firestore.rules`; never shipped in the app bundle.
- **@lhci/cli (Lighthouse CI) 0.15** — audits the production build's performance/accessibility/best-practices/SEO scores (`npm run lighthouse`); see §4.4.
- **Prettier 3** — code formatting; configured for 100-char print width, single quotes, and the Angular HTML parser for `.html` templates (`.prettierrc`), with a `.prettierignore` covering build output, generated reports and lockfiles. Enforced by `npm run format:check` in CI (`lint.yml`) — before that step existed it was advisory only, and 12 files had drifted.
- **ESLint 10 + angular-eslint 22 + typescript-eslint 8** — static analysis (`npm run lint`, `eslint.config.js`, flat config, scaffolded via a version-pinned `ng add angular-eslint@22.1.0`). Runs the recommended TS/Angular/template sets plus `templateAccessibility`, extended with **type-aware** `no-floating-promises`/`no-misused-promises` (via `projectService`) and four template rules the recommended sets omit (`button-has-type`, `no-duplicate-attributes`, `no-positive-tabindex`, `eqeqeq`). Enforced in CI by its own `lint.yml` workflow alongside `format:check` (§4.6), one workflow per concern like the rest. Currently covers `src/` only — `cypress/` and `functions/` are not linted yet (see Known Gaps).
- **PostCSS** — pipes Tailwind through `@tailwindcss/postcss` (`.postcssrc.json`).
- **EditorConfig** — enforces 2-space indentation, UTF-8, single quotes in TS across editors.
- **Firebase CLI** (`firebase-tools`) — local emulation and deployment; invoked both from local npm scripts and CI. Two majors are in play on purpose: **`@13`** for the Auth/Firestore-only scripts (unchanged, long-stable), but **`@14`** for anything touching `functions/` (`e2e`, `e2e:open`, the Cloud Functions deploy step) — `@13`'s bundled Functions tooling unconditionally probes for `functions.config()`, an API `firebase-functions` v7 removed outright, crashing every invocation; `@14` detects v7+ and skips that legacy path. Confirmed by running the emulator directly with `--debug` and comparing the two. Since `@14` is what the frequently-run local `e2e`/`e2e:open` scripts need, it's a real **`devDependency`** (`^14.27.0`) rather than an `npx`-fetched tool — `npm` scripts already put `node_modules/.bin` first on `PATH`, so those two scripts just call the bare `firebase` binary and always get the exact locally-installed version, with no per-run npx cache/registry round-trip. `@13` only backs the single `lighthouse` script, so it stays on `npx --yes firebase-tools@13` — a second major can't coexist as a second `devDependency` entry under the same package name, and `--yes` skips npm's interactive "ok to install?" prompt the first time that pin isn't already in the local npx cache (CI never sees that prompt either way, since its shell is non-interactive). The CI functions-deploy step (`firebase-deploy.yml`, §4.2) is deliberately left on `npx firebase-tools@14 deploy` rather than switched to the devDependency too — a one-shot deploy on a fresh runner doesn't benefit from the local-cache win, and keeping that line's version pin self-contained makes "what exact tool deployed production" answerable by reading that one line alone.
- **firebase-functions 7** / **stripe (Node SDK) 22** — the `functions/` package's only two runtime dependencies beyond `firebase-admin`; see §2.4.

### 2.3 Firebase client integration details

`FirebaseService` and `AuthService` wrap the Firebase modular SDK (`firebase/app`, `firebase/firestore`, `firebase/auth`) directly — **no AngularFire** — by design, so they can later be reused unmodified in non-Angular shells (e.g. Capacitor/Tauri) per an in-code comment.

Notably, the app **never commits a Firebase config/API key to source**. Instead it fetches `/__/firebase/init.json` at runtime — a reserved endpoint that Firebase Hosting auto-generates for whatever project is serving the current origin. In local dev, `src/proxy.conf.json` proxies that path to the live Hosting site (`https://intellectura-3b26a.web.app`) so `ng serve` gets a real config without any secrets in the repo. `FirebaseAppService.getApp()` fetches that config and calls `initializeApp` exactly once, shared by both Firestore and Auth.

All Firestore calls (`getCustomQuestions`, `saveHighScore`, `getTopScores`) are wrapped in a `withTimeout()` helper (10s) — the Firestore SDK's promises never reject on their own if the backend is unreachable (e.g. placeholder/misconfigured credentials), which would otherwise leave the UI stuck in a permanent loading state.

### 2.4 Cloud Functions backend (`functions/`)

A separate npm package (own `package.json`/lockfile/`tsconfig.json`, TypeScript compiled to `lib/` — never committed) holding the entire Pro-subscription backend, deployed alongside Hosting/Firestore rules but as its own `firebase deploy --only functions` target:

- **`createCheckoutSession`** (`onDocumentCreated` on `customers/{uid}/checkout_sessions/{sessionId}`): lazily creates the Stripe customer on first use (`customers.ts`, storing `stripeId` on `customers/{uid}`), creates the Stripe Checkout Session, and writes `{sessionId, url}` (or `{error}`) back onto the triggering doc — the other half of the handshake `SubscriptionService.startProCheckout()` (§1.6) is waiting on.
- **`createPortalSession`** (`onDocumentCreated` on `customers/{uid}/portal_sessions/{sessionId}`, `billing-portal.ts`): same handshake shape as `createCheckoutSession`, but creates a Stripe Billing Portal session for the caller's existing `stripeId` and writes back `{url}` (or `{error}`) — the other half of `SubscriptionService.openBillingPortal()` (§1.6).
- **`stripeWebhook`** (`onRequest`, HTTPS, `invoker: 'public'`): verifies the Stripe signature (`stripeWebhookSecret`), then dispatches `customer.subscription.created/updated/deleted` to `subscriptions.ts` (upserts `customers/{uid}/subscriptions/{id}`, keyed by a `firebaseUID` carried in the Subscription's own metadata since checkout time — no Firestore reverse-lookup needed — then recomputes the `stripeRole` custom claim from _all_ of that user's subscription docs, so an unrelated subscription canceling can't clobber a still-active one) and `product.*`/`price.*` to `products.ts` (mirrors the public `products`/`prices` catalog, §3). `invoker: 'public'` is required explicitly: Cloud Run (what 2nd-gen `onRequest` functions deploy onto) defaults to requiring a Google-issued auth token on every invocation, but Stripe's webhook deliveries carry none — they authenticate via the `Stripe-Signature` header instead, verified inside the handler — so without it every real delivery is rejected with a 403 at the Cloud Run/IAM layer before the handler ever runs. **This has now been exercised against real Stripe deliveries** (manually triggered events against the deployed endpoint), confirming signature verification, event dispatch, the Firestore subscription upsert, and the resulting `stripeRole` claim all work end to end — not just the simulated outcome the e2e suite seeds via `setProSubscription` (§4.3).
- **`role.ts`** is a small pure function (`deriveClaimRole(status, priceRole)`) isolating the one security-relevant decision (does this status grant this role) so it's unit-tested directly (`node --test`, via `npm run functions:test`) without mocking Stripe or Firestore.
- **Secrets**: `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` are bound via `firebase-functions/params`' `defineSecret` (Secret Manager–backed, set once per project with `firebase functions:secrets:set`) — never committed, never touch `process.env` directly in source.
- **`STRIPE_MOCK_CHECKOUT`**: a plain (non-secret) flag, true only for the `demo-trivia-app-e2e` project via a committed `functions/.env.demo-trivia-app-e2e` (Firebase Functions v2 auto-loads `.env.<project-id>` files). When set, `createCheckoutSession` skips the real Stripe API call entirely and writes back a deterministic, **same-origin, hash-only** mock URL instead of an external one — deliberately, since `Location.assign`/`href` are non-configurable/read-only in real Chromium/Electron and can't be stubbed in Cypress, so letting the real (harmless, in-page) navigation happen was the only way to exercise the redirect for real. This is what lets the e2e suite (§4.3) drive the _actual_ `createCheckoutSession` function against the Functions emulator, not just a Firestore-seeded simulation of its outcome.
- **`functions/.secret.local`** (committed, placeholder values only — see the comment in the file) lets the emulator start without real Secret Manager access, which neither a fresh contributor checkout nor CI has by default; the emulator's own startup warning suggests exactly this mechanism.

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
- **Create**: requires a "real" account — same `isRealAuthedUser()` gate as the leaderboard (non-anonymous, and email-verified if it's a password account) — **plus an active Pro subscription** (`isProUser()`: `request.auth.token.stripeRole == 'pro'`, §1.6) — plus schema validation (`isValidCustomQuestion()`: exact key set, `type` in `['multiple','boolean']`, `difficulty` in `['easy','medium','hard']`, string length bounds, `incorrect_answers` a list of 1–5 entries). Written from the client via the `/add-question` screen (§1.1, §1.4).
- **Update / Delete**: none from the client (`allow update, delete: if false`) — console-only for now.

### `customers` — Stripe subscription state (managed by `functions/`, §2.4)

```
customers/{uid}
  stripeId: string                          (Stripe customer ID)

customers/{uid}/checkout_sessions/{id}
  price, mode, success_url, cancel_url: string  (written by the client)
  sessionId, url: string                        (written back by createCheckoutSession)
  error?: { message: string }

customers/{uid}/portal_sessions/{id}
  return_url: string                            (written by the client)
  url: string                                   (written back by createPortalSession)
  error?: { message: string }

customers/{uid}/subscriptions/{id}
  status: string      (Stripe subscription status, e.g. 'active' | 'trialing' | 'canceled' | ...)
  role: string | null (from the price's `firebaseRole` metadata)
  price, product: string | null
  cancel_at_period_end: boolean
```

- **Read** (all four): only the owning uid (`isRealAuthedUser() && request.auth.uid == uid`).
- **Create**: `checkout_sessions` and `portal_sessions`, by the owning uid — kick off `createCheckoutSession` / `createPortalSession` (§2.4) respectively. Never updated/deleted from the client.
- `customers/{uid}` and `subscriptions/{id}` are never written by the client at all — only by `functions/` via the Admin SDK, which bypasses these rules entirely.

### `products` — Stripe product/price catalog (managed by `functions/`, §2.4)

```
products/{id}
  active: boolean
  name: string
  description: string | null
  role: string | null       (from the product's `firebaseRole` metadata)
  images: string[]

products/{id}/prices/{id}
  active: boolean
  currency: string
  unit_amount: number | null   (smallest currency unit, e.g. cents)
  type: 'one_time' | 'recurring'
  interval: 'day' | 'week' | 'month' | 'year' | null
  interval_count: number | null
```

- **Read**: public on both levels — lets `/pricing` and `SubscriptionService.getProPriceId()` (§1.6) resolve the current Pro price with no secrets involved.
- **Write**: client-side none at all; kept in sync from Stripe Dashboard `product.*`/`price.*` events by `stripeWebhook` (§2.4) via the Admin SDK.

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

### Rules test suite

`firestore.rules` is the app's real security boundary, so it has a dedicated unit suite (`npm run rules:test`, `firestore-tests/`, 86 tests) built on `@firebase/rules-unit-testing` and run against the Firestore emulator. Deliberately outside `src/` and driven by its own `vitest.rules.config.ts`, so the Angular build, `ng test` and the ESLint globs never pick it up.

- **Every branch is covered by its reject case, not just its happy path** — signed-out, anonymous, unverified-password, verified-but-not-Pro, a `stripeRole` that is set but isn't `pro`, cross-uid writes, every schema bound, and default-deny on an undeclared collection.
- **Auth contexts always set `firebase.sign_in_provider` explicitly** (`firestore-tests/helpers.ts`). Omitting it yields a provider that satisfies `!= 'anonymous'`, so a test leaning on the default would pass for the wrong reason and would keep passing if the anonymous check were deleted outright.
- **Each spec file uses its own `projectId`**, because `clearFirestore()` wipes a whole project — sharing one would make parallel files race each other's fixtures.
- **The suite was mutation-tested when written**: breaking `isProUser()` to always return true, deleting the anonymous check, and dropping the leaderboard's improving-score condition each produced failures (3, 4 and 2 respectively). A rules suite that passes against broken rules is worse than none, so this is worth repeating whenever the suite is extended.
- **Two findings are pinned with `assertSucceeds` and a `CURRENTLY ACCEPTS` label** — the unbounded leaderboard score (A1) and the unvalidated checkout-session payload (A2/A3). They document today's behaviour rather than endorsing it; the PRs that close those findings flip the expectation to `assertFails`, so the change is visible in the diff instead of silent.

---

## 4. Deployment & CI/CD

### 4.1 Hosting & Functions configuration (`firebase.json`)

- Hosting serves the compiled Angular app from `dist/trivia-app/browser`.
- SPA rewrite: all paths (`**`) fall back to `/index.html` (client-side routing).
- **Header rule ordering matters here**: the catch-all `**` headers rule (no-cache + `Cross-Origin-Opener-Policy: same-origin-allow-popups`, needed so Firebase Auth's popup-sign-in polling can read `popup.closed` without the browser blocking it — see §1.5) is listed _first_, with the more specific hashed-asset rules (`**/*.@(js|css)`, images/fonts) listed _after_ — Hosting applies the last-declared matching rule per header key, so the specific rules' `immutable` `Cache-Control` correctly overrides the broad one for those paths. An earlier version of this scoped the no-cache/COOP headers to the literal `source: "/index.html"`, which silently never matched any real request — every route (`/`, `/play`, `/game-over`, ...) is served via the `**` rewrite above, never a literal request for `/index.html` itself.
- `functions` config points at the `functions/` package (§2.4), with a `predeploy` hook (`npm --prefix functions run build`) so `firebase deploy --only functions` always deploys freshly-compiled code.
- Local emulator ports: Firestore `8080`, Auth `9099`, Functions `5001`, Hosting `5000`, plus the Emulator UI. `singleProjectMode` is enabled. The Auth and Functions emulators exist solely for the e2e suite (§4.3) — the app never talks to either outside that configuration.

### 4.2 GitHub Actions workflow (`.github/workflows/firebase-deploy.yml`)

**Trigger**: fires only when a pull request targeting `main` is **closed and merged** (not just closed).

Steps:

1. Checkout `main`.
2. Set up Node 24 (with npm cache, keyed off both `package-lock.json` and `functions/package-lock.json`).
3. `npm ci`.
4. `npm run build:prod` (production Angular build).
5. Deploy the built app to **Firebase Hosting** via `FirebaseExtended/action-hosting-deploy@v0` (channel: `live`), authenticated with the `FIREBASE_SERVICE_ACCOUNT_INTELLECTURA_3B26A` repo secret.
6. Deploy **Firestore rules + indexes** separately via `npx firebase-tools@13 deploy --only firestore:rules,firestore:indexes`, using the same service account written to a temp `GOOGLE_APPLICATION_CREDENTIALS` file.
7. `npm ci --prefix functions`, then deploy **Cloud Functions** (§2.4) via `npx firebase-tools@14 deploy --only functions` (`@14`, not `@13` — see §2.2) — a separate step from #6 on purpose, so a functions-only failure is easy to spot on its own.
8. Always clean up the temp service-account credentials file, even on failure.

Job permissions are scoped to `contents: read`, `checks: write`, `pull-requests: write` — the minimum needed for the hosting-deploy action to post a check/PR comment (this was tightened in a dedicated fix after the action initially hit a 403).

This is a **merge-to-deploy** pipeline: every PR merged into `main` auto-deploys hosting + Firestore rules/indexes + Cloud Functions to the single production project (`intellectura-3b26a`). It deliberately doesn't re-run e2e itself — see §4.2a for why that's still safe.

**One-time setup this pipeline depends on** (not automatable from CI, done once by someone with Stripe/GCP console access): a Stripe Product/Price with `firebaseRole: pro` metadata and a webhook endpoint pointed at the deployed `stripeWebhook` URL (§2.4); `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` set via `firebase functions:secrets:set`; and the deploying service account granted Cloud Functions Admin / Service Account User / Secret Manager Secret Accessor IAM roles. This has now been completed against the real project, so step 7 above is expected to succeed on every merge going forward (no longer `continue-on-error`, so a regression here will now turn the workflow red instead of failing silently).

### 4.2a Preview channel deploy + real-preview e2e (`.github/workflows/firebase-preview.yml`)

**Trigger**: every PR targeting `main`, on open/sync/reopen (not close — that's what §4.2 handles on merge). A `concurrency` group keyed on the PR number cancels a stale in-flight run if the PR gets pushed again before it finishes.

Two sequential jobs:

1. **`deploy-preview`** — checkout → Node 24 → `npm ci` → `npm run build:prod` → `FirebaseExtended/action-hosting-deploy@v0` deploying to an ephemeral channel named `pr-<number>` (7-day expiry) instead of `channelId: live`. The action posts/updates a PR comment with the preview URL on every push. The step's `urls` JSON output is parsed (`jq`) into a job output consumed by the next job.
2. **`e2e-preview`** (job name `E2E (preview)`) — runs a scoped slice of the Cypress suite (§4.3) against the just-deployed preview URL, hitting the **real** `intellectura-3b26a` project instead of an emulator.

Preview channels are a **Hosting-only** feature — there's still a single Firestore database for the project, so a preview build (and its e2e run) reads/writes the same production `custom_questions`/`leaderboard` data as `main` and live. Firestore rules/indexes are also not redeployed per-preview (they're project-wide, not channel-scoped); only §4.2's merge pipeline touches them. There is no isolated staging _database_ — just an isolated hosting URL, backed by production data, that's now also exercised end-to-end before merge.

**Merge gating is live, and it covers every CI check — not just this one.** `main` is protected by a repository **ruleset** (`enforcement: active`) requiring all five status checks to pass before a PR can merge, and therefore before §4.2's deploy can fire at all:

| Required check           | Workflow               |
| ------------------------ | ---------------------- |
| `test`                   | `unit-tests.yml`       |
| `e2e`                    | `e2e.yml`              |
| `lighthouse`             | `lighthouse.yml`       |
| `Deploy preview channel` | `firebase-preview.yml` |
| `E2E (preview)`          | `firebase-preview.yml` |
| `lint`                   | `lint.yml`             |
| `rules-tests`            | `rules-tests.yml`      |

> **`lint` and `rules-tests` are not in the ruleset yet.** Both run on every PR and report pass/fail, but a workflow cannot add itself as a required check — that needs a repo admin in Settings → Rules. Until they are added, a red `lint` or `rules-tests` will not block a merge. Adding a new check is the accepted cost of keeping one workflow per concern (see `INFRASTRUCTURE.md` §8); the alternative, bolting the steps onto an already-required job, trades a permanently muddier signal for a one-off settings step.

`strict_required_status_checks_policy` is on, so a branch must also be up to date with `main` before merging. The ruleset additionally requires a pull request (with zero required approvals — this is a solo repo) and blocks branch deletion and non-fast-forward pushes.

One practical gotcha when verifying this: it's a **ruleset**, not classic branch protection, so the legacy `GET /repos/{owner}/{repo}/branches/main/protection` endpoint returns **404 "Branch not protected"** even though `main` is fully protected. Check `GET /repos/{owner}/{repo}/rules/branches/main` (or `/rulesets`) instead — the legacy endpoint's 404 is not evidence of anything.

### 4.3 E2E testing (Cypress + Firebase Emulator Suite)

- Suite lives under `cypress/e2e/unauthenticated/` (anonymous game flow across all three question sources, route guards, embed mode) and `cypress/e2e/authenticated/` (email sign-up + verification, sign-in, saving a score, profile management, Pro-gated `/add-question` access, and Stripe checkout), run via `npm run e2e` (headless) or `npm run e2e:open` (interactive).
- Both commands first `npm run functions:build`, then wrap `firebase emulators:exec --project demo-trivia-app-e2e --only auth,firestore,functions` (**functions** included since this PR — see §2.4), which starts a throwaway local Firestore + Auth + Functions emulator trio, runs the wrapped command, and always tears the emulators down afterward — no real project is ever touched.
- The app itself only connects to the emulators when built with the dedicated `e2e` Angular configuration (`ng serve --configuration=e2e`, see §4.5): `FirebaseAppService` skips the `/__/firebase/init.json` fetch and uses a hardcoded `demo-trivia-app-e2e` config instead, and `AuthService`/`FirebaseService` call `connectAuthEmulator`/`connectFirestoreEmulator`.
- `cypress/tasks/firebase-emulator-tasks.ts` uses `firebase-admin` (talking to the emulators only) to reset all Auth users/Firestore docs before every test, seed `custom_questions`/`leaderboard` documents bypassing `firestore.rules`, create already-verified users, fetch pending email-verification links from the Auth emulator's testing REST endpoint, and (new) `setProSubscription`/`seedProProduct` to drive a user into a "Pro" state (custom claim + subscription doc) or seed a fake Pro price without ever calling Stripe.
- **`pricing.cy.ts`** covers the Subscribe flow against the _real_ `createCheckoutSession` function (in `STRIPE_MOCK_CHECKOUT` mode, §2.4) end-to-end — click → Firestore write → Functions-emulator trigger → write-back → client listener → same-origin redirect — plus the anonymous sign-in prompt and the already-subscribed state (via `setProSubscription`). **`add-question-pro-gating.cy.ts`** covers the free-tier upgrade prompt and, for a freshly-`setProSubscription`'d account, that the real-time subscription listener + forced token refresh actually let the `custom_questions` write through under the updated `firestore.rules`.
- Real bugs found and fixed by this suite (beyond the two below, pre-dating the Pro tier): `PricingComponent` briefly misfiring "verify your email" for a click landing before the first auth state resolves (§1.6); and a pre-existing `sign-up-verify.cy.ts` race — `signInViaUi`'s `openAuthMenu()` racing the still-open dropdown from a prior "Sign out" click, which only closes after its async re-anonymous-sign-in resolves — surfaced (not caused) by the added Functions emulator's extra CPU contention, fixed with an explicit wait for the dropdown to close first.
- Two earlier real bugs were found and fixed by this suite: a race in `AuthService.ensureSignedIn()` where a returning user's persisted session could be clobbered by a fresh anonymous sign-in (fixed with `auth.authStateReady()`), and a stale-UI bug where linking an anonymous session to a real credential mutates the Firebase `User` object in place without firing `onAuthStateChanged`, so `isAnonymous`/`isFullyAuthenticated` never updated until fixed by explicitly re-pushing the user into the auth signal after linking.
- CI: `.github/workflows/e2e.yml` runs the full suite on every PR targeting `main` (and on push to `main`), separately from the merge-to-deploy pipeline in §4.2 — including installing/building `functions/` first.

**Running the same suite against a real preview instead of the emulator** (`cypress.preview.config.ts`, driven by the `e2e-preview` job in §4.2a): a deliberately narrower slice, because this hits the real, persistent, public `intellectura-3b26a` project — there's no throwaway emulator to reset:

- `specPattern` includes all of `cypress/e2e/unauthenticated/` plus only `sign-in-save-score.cy.ts` and `profile.cy.ts` from `cypress/e2e/authenticated/`. `sign-up-verify.cy.ts` is excluded permanently: it depends on the Auth emulator's testing-only `oobCodes` REST endpoint to read a verification link, which has no real-Auth equivalent without a live mailbox. `pricing.cy.ts` and `add-question-pro-gating.cy.ts` are excluded too, on purpose: Cloud Functions aren't channel-scoped (§4.2a below), so a preview build shares the _real_, already-deployed `createCheckoutSession`/`stripeWebhook` — running the mock-mode checkout spec here would either hit real Stripe or silently no-op depending on that deployed project's own `STRIPE_MOCK_CHECKOUT` state, neither of which this suite should depend on.
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
npm run functions:install # npm ci inside functions/ (also runs automatically via the root `postinstall` hook)
npm run functions:install:update # npm install inside functions/ — only when adding/bumping a functions dependency
npm run functions:build   # tsc-build functions/ (src/ -> lib/)
npm run functions:test    # build, then node --test against functions/lib
npm run rules:test        # firestore.rules unit suite (Vitest) against the Firestore emulator
npm run e2e            # functions:build, then Cypress e2e suite (headless) against the Firebase Emulator Suite (incl. Functions)
npm run e2e:open       # same, but with the interactive Cypress runner
npm run e2e:preview    # scoped Cypress suite against a real deployed preview (needs PREVIEW_URL + GOOGLE_APPLICATION_CREDENTIALS)
npm run lighthouse     # build:prod, then Lighthouse CI against a local static server
npm run firebase:emulate  # build:prod, functions:build, then firebase emulators:start
npm run firebase:deploy   # build:prod, then firebase deploy --only hosting,firestore,functions
```

Package manager is pinned via `"packageManager": "npm@11.12.1"`. `functions/` is a separate npm package with its own `package.json`/lockfile (standard Firebase CLI convention), so the root `npm install`/`npm ci` doesn't reach it on its own — a root-level `postinstall` script (`npm run functions:install`) closes that gap automatically so a plain `npm install` at the repo root is enough for `npm run functions:build`/`npm run e2e` to work right after cloning, without a separate manual step. That hook runs **`npm ci`**, not `npm install`: it used to be the latter, which meant every `npm ci` in CI — the command whose entire purpose is a reproducible tree — silently ran a non-deterministic install in `functions/` that was free to rewrite `functions/package-lock.json` as a side effect. The trade-off is that editing `functions/package.json` now makes the next root install fail loudly with an out-of-sync lockfile error; `npm run functions:install:update` is the deliberate escape hatch for that case, and the failure is the point — a lockfile should only change when someone meant to change it. `npm run e2e`/`npm run e2e:open` call the `firebase` binary directly now that `firebase-tools@14` is a real `devDependency` (§2.2) instead of an `npx`-fetched tool. `npm run lighthouse` still needs the older `@13` major, which can't also be a `devDependency` alongside `@14`, so it stays on `npx --yes firebase-tools@13` — the `--yes` skips npm's interactive "ok to install?" prompt the first time that pin isn't already in the local npx cache (CI's shell is non-interactive, so it never saw that prompt either way; this is purely a local-DX fix).

### 4.6 Environments

- `.firebaserc` pins the default (and only) Firebase project to `intellectura-3b26a`.
- `src/environments/environment.ts` / `environment.development.ts` carry `production` and `useEmulators` flags — no secrets or API keys live here, consistent with the runtime-config-fetch approach described in §2.3.
- `src/environments/environment.e2e.ts` sets `useEmulators: true` and is swapped in only by the `e2e` build/serve configuration (`angular.json`, `fileReplacements`) used by the Cypress suite (§4.3) — never by `start`/`build`/`build:prod`.
- Production build budgets (`angular.json`): 500 KB warning / 1 MB error (initial bundle), 4 KB warning / 8 KB error (per component style); output hashing enabled for cache-busting.
- `functions/` has its own env layer (§2.4): `.env.demo-trivia-app-e2e` (committed, non-secret — sets `STRIPE_MOCK_CHECKOUT=true`) and `.secret.local` (committed, placeholder-only fallback for `defineSecret`-bound values when Secret Manager isn't reachable). Everything else under `functions/.env*`/`.secret.local` is gitignored — see the comments in `functions/.gitignore` for exactly which two files are the deliberate exceptions and why.

---

## 5. Project History (from commit log)

1. **Initial scaffold** — Angular + Firebase + Open Trivia DB, "Phase 1" of the trivia app (setup/play/game-over flow, services, Tailwind).
2. **Firebase Hosting integration** — connected the app to the `intellectura-3b26a` Firebase project.
3. **CI fix** — granted `checks`/`pull-requests` write permissions to resolve a 403 from the Hosting deploy GitHub Action.
4. **CI enhancement** — added automatic Firestore rules/indexes deployment on merge (previously only Hosting deployed).
5. **Tooling** — added an Angular CLI analytics ID to `angular.json`.
6. **Custom question submission** — added the `/add-question` screen and its Firestore-backed question bank (§1.1, §1.4).
7. **Pro subscription tier (Stripe)** — added the `/pricing` screen, gated `/add-question` behind a Pro subscription, and stood up the backend twice: first via the "Run Subscriptions with Stripe" Firebase Extension, then — once that product line announced its March 2027 shutdown, before this even shipped — migrated to an owned `functions/` Cloud Functions package with the same Firestore schema/custom-claim contract (§1.6, §2.4).
8. **Installable PWA & offline play** — added a web app manifest + `@angular/service-worker` (via `ng add @angular/pwa`) for Chrome/Android installability, plus an IndexedDB-backed offline question pool and background prefetch so a game can start with no network connection (§1.8).

---

## 6. Known Gaps / Not Yet Implemented

> A full audit of this repo (security, correctness, data model, CI/CD, testing, accessibility) was carried out and is being addressed as a series of individually-reviewable PRs. Each of those PRs adds or strikes its own entry in this list as it lands, so this section is the running record of what's still open. The **invariants** those fixes establish — the things that must not silently regress once fixed — are written up as a contract in `CLAUDE.md` §4 (app layer) and `INFRASTRUCTURE.md` §10 (infra layer). Read those before adding a feature that touches Firestore rules, the Stripe backend, auth/claims, or any new interactive UI.

- Email-alias blocking is client-side only (regex on sign-up) — a determined user could still call the Auth API directly to create alias accounts. Closing that gap requires a Firebase Auth blocking Cloud Function (`beforeCreate`) — the `functions/` package and its CI deploy step (§2.4, §4.2) now exist for the Pro subscription backend, so the infrastructure blocker is gone, but the blocking function itself still isn't written. The rules-enforced "not anonymous, verified if password" check is the actual anti-flood defense and doesn't depend on this.
- Play Games and Game Center sign-in are listed in the Firebase console but not offered in the app — no Web SDK equivalent exists for either (native Android/Apple only).
- The `/add-question` screen only supports _creating_ a question — no in-app way to edit or delete an existing `custom_questions` doc yet (console-only for now, per the rules comments). There's also no moderation/review step: any fully authenticated Pro subscriber can add directly to the shared, public bank.
- The offline question pool (§1.8) is refilled only in the foreground (idle callback + `online` event) while the app has a tab open — it doesn't use the Background Sync API, so a PWA installed but never opened between sessions won't have a freshly-topped-up pool. The manifest icons are `purpose: any` only; the Trivimind mark wasn't designed with a maskable safe zone, so a true `maskable` icon variant (padded so Android's adaptive-icon mask never crops the glyph) isn't provided yet.
- The e2e suite (§4.3) covers the core unauthenticated/authenticated flows plus Pro-gated `/add-question` access and the checkout-session creation function, but not OAuth sign-in (Google/Facebook/etc. — popup-based, not practical to automate against the emulator) or the "mixed" question source end-to-end (unit-level coverage only).
- ESLint (§2.2) covers `src/` only. `cypress/` (its own tsconfig plus Cypress globals) and `functions/` (a separate npm package with its own tsconfig — and the one that actually ships to the Cloud Functions runtime) are not linted yet; both need their own flat-config entry with the right `projectService` wiring.
- `npm audit` reports a critical `tar` advisory (plus several moderate/low ones) via `firebase-tools@14`'s `@google-cloud/pubsub`/`gaxios` transitive chain — devDependency-only, never shipped in the app bundle. The real fix is bumping to `firebase-tools@15`, which resolves the critical finding, but `@15` hard-requires a JDK ≥21 for the Firestore emulator (confirmed by actually running it — this isn't just a future warning) and no such JDK is installed locally yet; CI already runs JDK 21 (`e2e.yml`), so the bump is safe there once made. A handful of remaining moderate findings (via `firebase-admin`'s and `@lhci/cli`'s own transitive deps) have no fix at all yet — both packages are already pinned to their latest published version; `npm audit fix --force`'s suggested "fix" for those is a multi-major downgrade (e.g. `@lhci/cli` 0.15.1 → 0.1.0) that only avoids the vulnerable subtree by reverting to a version that predates it, not a real patch — don't take it. `functions/`'s own `firebase-admin` dependency carries the same moderate `uuid` finding, also with no upstream fix yet.
