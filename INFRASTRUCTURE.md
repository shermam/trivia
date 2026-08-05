# Infrastructure Playbook

This document captures every **infra/tooling choice** behind this repo that is independent of what the app actually does (that's `PROJECT_OVERVIEW.md`'s job). It exists so:

1. Claude Code (or a human) can understand *why* a piece of tooling was chosen, not just that it's there.
2. A brand-new project can be scaffolded from scratch with the identical stack, wiring, and CI/CD setup, by following §9 below.

If you change any infra choice (swap a tool, bump a major version, restructure CI), update this file in the same change.

---

## 1. Stack at a glance

| Concern                | Choice                                             | Why (vs. alternatives)                                                                                          |
| ----------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Frontend framework     | **Angular** (latest major, standalone components, signals, no NgModules) | Batteries-included (router, forms, HTTP, DI, CLI, build system) — one framework decision covers most of the frontend surface without picking a router/state/build tool separately. |
| Styling                | **Tailwind CSS** via `@tailwindcss/postcss`          | Utility classes only, no component-level CSS framework (no Material/PrimeNG) — keeps styling colocated in templates and bundle size predictable. |
| Unit test runner        | **Vitest** (Angular CLI's `@angular/build:unit-test`, jsdom environment) | Angular CLI's own current default builder — no separate Karma/Jasmine setup or browser launcher to maintain. |
| E2E test runner         | **Cypress**, against a real local **Firebase Emulator Suite** | Real backend behavior (Firestore rules, Auth, Functions triggers) instead of mocks — mocks would drift from `firestore.rules`/Functions behavior and mask real regressions. |
| Backend-as-a-service    | **Firebase**: Firestore (data), Auth, Cloud Functions, Hosting | One vendor covers DB + auth + serverless compute + static hosting + a matching local emulator suite — minimal glue infra for a small/solo-maintained app. |
| Payments                | **Stripe**, driven from owned Cloud Functions (not a marketplace extension) | Marketplace/extension integrations can be deprecated out from under you (this project's own history, §8) — owning the functions means the integration only depends on the Stripe API directly. |
| CI/CD                   | **GitHub Actions**                                  | Native to GitHub, no separate CI vendor/account, generous free tier for a small project. |
| Performance/a11y auditing | **Lighthouse CI** (`@lhci/cli`)                    | Same Lighthouse engine as Chrome DevTools, runnable both locally and in CI with numeric thresholds instead of eyeballing scores. |
| Formatting              | **Prettier** + **EditorConfig**                     | Zero-config-argument formatting, one shared config file, editor-agnostic baseline via EditorConfig. |
| Package manager         | **npm**, version-pinned (`packageManager` field)     | No extra tool to install; pinning avoids "works on my machine" lockfile drift. |

---

## 2. Frontend: Angular + Tailwind

**Scaffold:**
```bash
npx @angular/cli@latest new <app-name> --style=css --routing --ssr=false
cd <app-name>
npx ng add @tailwindcss/postcss
```

Conventions to carry into a new project:
- **Standalone components only** — no `NgModule`s. Routes are lazy-loaded via `loadComponent`.
- **Signals for state**, not NgRx/other state libraries, unless the app's complexity genuinely outgrows a single injectable signal-based store. Prefer one app-wide store service over scattering state across components.
- **`OnPush` change detection** everywhere; `@if`/`@for` control-flow syntax instead of `*ngIf`/`*ngFor`.
- **No AngularFire.** Wrap the Firebase modular SDK (`firebase/app`, `firebase/firestore`, `firebase/auth`) directly in plain injectable services. This keeps those services portable to a non-Angular shell later and avoids a dependency on AngularFire's release cadence tracking Angular's own.
- Angular CLI build **budgets** (`angular.json`): set explicit `initial` bundle and `anyComponentStyle` budgets (this project: 500 KB warn / 1 MB error initial; 4 KB warn / 8 KB error per component style) — catches bundle bloat at build time, not after a Lighthouse regression.
- Add a dedicated Angular build **configuration per non-production runtime target** that needs different config-at-build-time behavior (this project has `e2e` and `lighthouse`, both swapping in an emulator-pointed environment file via `fileReplacements` — see §4). Don't branch this kind of thing on `environment.production` alone.
- **Icons: inline SVG via one shared component, not an icon-font/library dependency.** Fetch the source library's raw SVG path data (e.g. from its `-static` npm package's CDN mirror) once, embed the literal `<path>` data in a `@switch`-based Angular component (`stroke="currentColor"` so callers control color via an ancestor text-color class), and never ship the library itself. Keeps the dependency count at zero and the bundle free of an icon font/sprite sheet.
- **Third-party web fonts are a deliberate, narrow exception** to "avoid third-party requests" (this project otherwise goes out of its way to avoid them, e.g. the OAuth-popup-resolver iframe fix in §5-adjacent auth code) — if a brand system mandates one, load it via a preconnected `<link>` with `display=swap` rather than self-hosting purely for expedience, and treat the Lighthouse performance budget (§6.5) as the actual guardrail: run it after adding the font and don't merge if the median score regresses.

---

## 2a. Progressive Web App: manifest + service worker

**Scaffold** (the Angular-recommended path — do this before hand-writing a manifest or service worker):

```bash
npx ng add @angular/pwa
```

This generates `public/manifest.webmanifest`, `ngsw-config.json`, placeholder icons, wires `provideServiceWorker('ngsw-worker.js', { enabled: !isDevMode(), registrationStrategy: 'registerWhenStable:30000' })` into `app.config.ts` (or the `NgModule` equivalent on older Angular), points `angular.json`'s production build configuration at `ngsw-config.json`, and adds a `manifest`/icon `<link>`s to `index.html`.

Two sharp edges hit when doing this against a very recent Angular major, worth checking for on any future re-run:

- **`ng add @angular/pwa` (no version pin) can resolve to a wildly outdated npm dist-tag** — on this project (Angular 22), the unpinned command resolved to `@angular/pwa@12.2.18` and failed outright (`Main file (undefined) not found`) rather than doing anything harmful, so the failure mode is at least loud. Pin it to the exact Angular CLI major/minor already installed (check `@angular/cli`'s installed version first): `npx ng add @angular/pwa@<matching-version> --skip-confirmation`.
- **Even version-pinned, the schematic's own `package.json` edit can add `@angular/service-worker` with a caret range (`^22.0.0`) that `npm install` then resolves to a newer minor than the rest of the Angular packages already installed** (e.g. `22.1.0` when everything else is pinned at `22.0.8`), which fails with an `ERESOLVE` peer-dependency conflict (`@angular/service-worker@22.1.0` requiring `@angular/core@"22.1.0"` exactly). Fix by pinning that one dependency to the exact version already installed for the rest of `@angular/*` before running `npm install` again.

**Manifest content** — don't ship the schematic's placeholder Angular-logo icons or generic `name`:

- Rasterize the app's actual icon source (this project's `public/favicon.svg`) at every size Chrome/Android installability + home-screen icons need (72/96/128/144/152/192/384/512px) — `rsvg-convert -w <size> -h <size> public/favicon.svg -o public/icons/icon-<size>x<size>.png` (or an equivalent SVG rasterizer) per size, overwriting the schematic's placeholders.
- Set `name`/`short_name` to the real product name, `theme_color` to the brand's primary color (kept in sync with the `theme-color` `<meta>` tag added to `index.html`), and `background_color`/`display: standalone` deliberately rather than leaving the scaffolded defaults.
- **Only claim `purpose: maskable` if the icon was actually designed with a maskable safe zone** (important content kept within the inner ~80%-diameter circle so Android's adaptive-icon mask never crops it mid-glyph) — the schematic defaults every icon to `purpose: "maskable any"` regardless. If the source mark is a full-bleed icon that wasn't designed with that safe zone in mind (common for an icon that started life as a plain favicon), ship `purpose: any` only rather than shipping an unverified maskable claim.

**Don't let an app-level background task (e.g. an offline-data prefetch) fire unconditionally on every build** — gate it behind the project's existing environment-file split (§4) the same way `useEmulators` already is, and turn it off specifically under the `e2e`/`lighthouse` build configurations: a background task that fires its own HTTP requests on a timer can race Cypress's `cy.intercept`-based request waits (satisfying the wrong intercepted request) and has no reason to compete for resources during a Lighthouse-audited page load either.

**Keep `ngsw-config.json` to the default app-shell `assetGroups`** (prefetch the JS/CSS/HTML/manifest, lazily cache images/fonts) rather than reaching for its `dataGroups` to cache calls to a third-party API. A rate-limited third-party API (or one needing app-level normalization/filtering, like this project's Firestore-backed question bank) is better served by a purpose-built app-level cache (e.g. IndexedDB) that the app controls the fetch/eviction policy for, than by the service worker's generic HTTP-cache-with-a-strategy model.

---

## 3. Firebase project setup

**Scaffold:**
```bash
npm install -g firebase-tools   # or use npx firebase-tools@<pinned-major> per script, see §7
firebase login
firebase init firestore hosting functions
```

- `.firebaserc` pins the default project ID. One Firebase project for the whole app (no separate staging *database* — see §6 on preview channels for why that's an accepted tradeoff for a small app).
- `firestore.rules` is the actual security boundary — never trust client-side gating alone for anything that matters (auth checks, role/entitlement checks, schema validation). Write rules that validate exact key sets and value bounds on every collection accepting client writes, not just `allow read/write: if request.auth != null`.
- **Never commit a Firebase config/API key to source.** Firebase Hosting auto-serves a reserved `/__/firebase/init.json` endpoint for whatever project is serving the current origin — fetch that at runtime instead of hardcoding config. In local dev, proxy that path (`proxyConfig` in the dev-server build target, e.g. `src/proxy.conf.json`) to the real Hosting URL so `ng serve`/equivalent gets a real config with zero secrets in the repo.
- Wrap every Firestore/Auth SDK call that's expected to resolve quickly in an explicit timeout helper. The Firestore SDK's promises don't reject on their own if the backend is unreachable (e.g. placeholder credentials, network partition) — without a timeout, that's a silently-infinite loading spinner instead of a surfaced error.
- **Local emulator suite** (`firebase.json` → `emulators`): pick fixed ports for every product you emulate (Firestore, Auth, Functions, Hosting) plus `"ui": { "enabled": true }` and `"singleProjectMode": true`. Use a distinct, throwaway project ID for the emulator suite (e.g. `demo-<app-name>-e2e`) — never point emulators at the real project ID.
- **Hosting header rule ordering matters**: Hosting applies the *last*-declared matching rule per header key for a given request path. If you have both a catch-all (`**`) header rule and more specific rules (hashed JS/CSS, images/fonts), declare the catch-all *first* and the specific overrides *after*, or the specific rule's cache policy will never apply.
- If you need `Cross-Origin-Opener-Policy: same-origin-allow-popups` (needed for Firebase Auth popup sign-in to read `popup.closed`), set it on the actual served routes (the SPA rewrite fallback `**`, not a literal path like `/index.html` that a client-side router never actually requests).

---

## 4. Environment/config layering

A three-way split, so no build ever ships secrets and every build config is explicit about which backend it talks to:

- `environment.ts` / `environment.development.ts` — flags only (`production`, `useEmulators`), no secrets. Real Firebase config is fetched at runtime (§3), never embedded here.
- `environment.e2e.ts` — sets `useEmulators: true`; swapped in only by a dedicated `e2e` build/serve configuration (`fileReplacements` in `angular.json`), never by the default `build`/`serve`.
- A same-shaped `lighthouse` build configuration reusing the same `e2e` environment file, so Lighthouse audits run against the emulator suite too (see §6.4 for why).

Cloud Functions get their own env layer, kept **separate** from the frontend's:
- Real secrets (API keys, webhook secrets) go through the functions framework's Secret-Manager-backed secret mechanism (e.g. `firebase-functions/params`' `defineSecret`), set once per project via the CLI — never `process.env` read directly from a committed file.
- A committed, **placeholder-only** local secrets file lets the emulator boot without real Secret Manager access (which a fresh checkout / CI runner won't have by default) — the emulator's own startup logs typically point at this mechanism.
- A per-emulator-project `.env.<project-id>` file (committed, non-secret) can carry safe-to-commit feature flags scoped only to the throwaway e2e project (e.g. "mock the third-party payment call in this environment"), auto-loaded by the functions framework's own project-ID-based env-file convention.
- Everything else under the functions package's env/secrets directory should be gitignored by default — carve out explicit exceptions (with a comment explaining why each one is safe to commit) rather than the reverse.

---

## 5. Payments: Stripe via owned Cloud Functions

Don't reach for a marketplace/extension integration for anything you plan to depend on long-term — this project originally used a first-party Firebase Extension for Stripe subscriptions, which then announced end-of-life before the integration even shipped. Own the functions instead:

- **Entitlement = a custom claim on the Auth token** (e.g. `stripeRole: 'pro'`), set by your webhook handler once a subscription's price carries a role marker in its Stripe metadata. Firestore rules check the claim directly. A separate real-time Firestore listener mirroring subscription state is fine for UX (so the UI updates instantly) but should never be the actual security gate — the claim is.
- **Client-initiated, function-completed handshake** for anything requiring a live Stripe API call (Checkout session, Billing Portal session): the client creates a small placeholder document (e.g. `customers/{uid}/checkout_sessions/{id}`), a Firestore-triggered function (`onDocumentCreated`) does the real Stripe API call and writes the result (URL or error) back onto that same document, and the client has a real-time listener on it waiting for that write. This avoids ever giving the client a callable-function-only path that needs its own separate auth wiring, and keeps the Stripe secret key entirely server-side.
- **Webhook function must allow unauthenticated invocation** (`invoker: 'public'` or equivalent) — the platform's default HTTPS function often requires a platform-issued auth token on every request, but a third-party webhook (Stripe or otherwise) will never send one; it authenticates via its own signature header instead, verified inside the handler.
- **Never hardcode a price/product ID client-side.** Mirror the payment provider's product/price catalog into a publicly-readable collection via the same webhook (subscribing to `product.*`/`price.*` events), and have the client look up the current price dynamically. Changing a price in the provider's dashboard then needs zero frontend deploy.
- **Isolate the one security-relevant decision function** (e.g. "does this subscription status + this price's role metadata grant this claim") as a small pure function, unit-tested directly without mocking the payment SDK or the database.
- If a real popup/redirect can't be triggered from an automated test (e.g. `Location.assign` isn't stubbable in a real browser context), add a narrowly-scoped "mock mode" flag — env-gated to the test project only (§4) — that swaps the real third-party API call for a deterministic, same-origin fake response, so the *rest* of the flow (your own function, your own Firestore write, your own client listener) still gets exercised for real.

---

## 6. CI/CD (GitHub Actions)

Four independent workflows, deliberately not one monolith — so a slow suite never blocks fast feedback on a different one, and a red job is unambiguous about what broke:

### 6.1 Unit tests (`unit-tests.yml`)
Every PR to `main` + push to `main`. Checkout → setup Node (LTS, matching the functions runtime) → `npm ci` → run the unit test command. Fastest signal, kept separate from everything else.

### 6.2 E2E (`e2e.yml`)
Every PR to `main` + push to `main`. Needs, beyond Node: a JRE (if your DB emulator runs on the JVM, e.g. Firestore's), and caching for both the emulator binaries and the e2e tool's own binary cache (e.g. `~/.cache/Cypress`) keyed off the runner OS. Steps: install root deps, install the serverless-functions package's deps separately (it's a separate npm package, §4), run its unit tests, then run the full e2e suite (which itself wraps `emulators:exec` so the emulator trio starts/stops around the test run). Upload screenshots/videos as a build artifact on failure only.

### 6.3 Merge-to-deploy (`firebase-deploy.yml`)
Fires only on a PR **closed and merged** into `main` (not just closed). Checkout `main` → install → production build → deploy Hosting (via the platform's official GitHub Action, authenticated with a repo-secret service account) → deploy database rules/indexes separately (own step, so a rules-only failure is distinguishable from a Hosting failure) → install + deploy the serverless functions package separately again (own step, same reasoning). Always clean up any temp credential files, even on failure (`if: always()`). Scope job permissions to the minimum the deploy actions actually need (e.g. `contents: read`, plus `checks: write`/`pull-requests: write` only if the hosting-deploy action posts PR comments/checks).

This is a **deploy-on-merge** pipeline: it doesn't re-run e2e itself. That's only safe because of §6.4 gating merges in the first place.

### 6.4 Preview deploy + real-preview E2E (`firebase-preview.yml`)
Every PR to `main` on open/sync/reopen, with a `concurrency` group keyed on the PR number so a new push cancels a stale in-flight run. Two sequential jobs:
1. Deploy to an ephemeral preview channel (not `live`) named after the PR (short expiry, e.g. 7 days). Parse the deploy action's URL output for the next job.
2. Run a **scoped** slice of the e2e suite against that real, live preview URL — the parts that are safe to run against a real, shared, persistent backing project (see the caveats below).

Then make that preview-e2e job a **required status check** in branch protection on `main`, so nothing merges (and therefore nothing reaches §6.3) without a real deployed preview actually passing e2e. This is what makes it safe for §6.3 to not re-run e2e on its own.

Caveats worth carrying into a new project:
- Preview channels are typically **hosting-only** — there's usually still one shared database for the whole project, so a preview build's e2e run reads/writes the same data as production. Exclude specs that would pollute real, persistent data, or that depend on emulator-only testing endpoints (e.g. reading an email-verification link programmatically) with no live equivalent.
- Exclude specs that exercise serverless functions if those functions aren't preview-channel-scoped either (commonly true) — a preview build shares the *already-deployed* production functions, so running a real side-effecting flow (e.g. a real payment checkout) against them from every preview is the wrong tradeoff. Keep a mock-mode escape hatch (§5) for exactly this.
- Give any preview-created test data unique-per-run identifiers (e.g. timestamp-suffixed) so two previews running concurrently against the same real backend never collide.
- Track and sweep up anything a preview-e2e run creates in the real backend (an `after`/teardown hook + a real-project-flavored variant of your task/seed helpers) — there's no throwaway emulator to just tear down here.

### 6.5 Lighthouse (`lighthouse.yml`)
Every PR to `main` + push to `main`. Build with a dedicated Lighthouse build configuration (same optimizations as production, but pointed at your local emulator suite via the same environment-swap mechanism as e2e — §4), start the Hosting (+ any backend your app calls on load) emulators, run Lighthouse CI 3× against the emulator-served Hosting URL, assert median scores per category against `lighthouserc.json`. Upload HTML/JSON reports as a build artifact unconditionally (`if: always()`), pass or fail.

**Serve from the real Hosting emulator, not a bare static file server**, if your app depends on a Hosting-specific reserved endpoint (like Firebase's `/__/firebase/init.json`, §3) to initialize anything at runtime — a bare static server will make that initialization silently fail, which can *look like* a better best-practices score (nothing initialized, so nothing logged a runtime error) while actually hiding the exact class of regression the check exists to catch.

---

## 7. Tooling version pinning

- Pin the package manager itself (`"packageManager": "npm@<version>"` in `package.json`) to avoid lockfile-format drift across contributor/CI Node installs.
- If a CLI tool's *major version* behaves differently depending on what else is in the repo (e.g. a serverless-functions runtime major-version bump removing an API the CLI's older major still probes for unconditionally), pin *different* majors of that CLI per script depending on what the script touches, rather than forcing one global version that breaks half your scripts. Document exactly why in the script/README — this kind of pin looks like an accident if unexplained.
- Prefer `npx <tool>@<pinned-major>` in package.json scripts over a devDependency when different scripts genuinely need different majors of the same tool.

---

## 8. Formatting & editor baseline

- **Prettier**: pin `printWidth`/`singleQuote` project-wide; add a `files`-scoped override for any template language your framework uses that Prettier doesn't parse with its default parser (e.g. Angular HTML templates need `"parser": "angular"`).
- **EditorConfig**: charset, indent style/size, final-newline, trailing-whitespace — plus per-extension overrides where a language has a different natural convention (e.g. Markdown often wants trailing-whitespace trimming *off*, since two trailing spaces is a hard linebreak in Markdown).
- **PostCSS**: a one-line `.postcssrc.json` wiring in the CSS framework's PostCSS plugin (e.g. `@tailwindcss/postcss`) is all that's needed — don't hand-roll a PostCSS config beyond what the framework's own `add`/init schematic generates.

---

## 9. Scaffolding a brand-new project on this same stack

Rough order, each step independently verifiable before moving to the next:

1. `npx @angular/cli@latest new <name>` → standalone, routing, no SSR unless needed.
2. `npx ng add @tailwindcss/postcss` (or your CSS framework's own `ng add`/init step).
3. Add Prettier + `.prettierrc` (with the `angular` HTML parser override) + `.editorconfig`.
4. `firebase init firestore hosting functions` → wire `.firebaserc` to a real project; write initial `firestore.rules` (deny-by-default, add narrow allows per collection as features land).
5. Add the environment-layering split (§4): base env files with flags only, plus an `e2e`/emulator-pointed variant and matching Angular build configuration.
6. Wire the runtime-config-fetch pattern (§3) instead of committing Firebase config — verify `ng serve` actually gets a working config via the proxy before writing any app code that depends on it.
7. Stand up the emulator suite locally (`firebase emulators:start`) against a dedicated `demo-<name>-e2e` project ID; confirm each product's emulator port and the Emulator UI all come up.
8. Add Cypress; write the emulator task helpers (seed/reset via the backend's admin SDK, bypassing rules) before writing the first real spec.
9. Add the four GitHub Actions workflows (§6) one at a time, cheapest/fastest first (unit tests), confirming each goes green on a real PR before adding the next.
10. Turn on branch protection requiring the preview-e2e check (§6.4) once that workflow exists and has gone green at least once.
11. Add Lighthouse CI last, once there's a real build to audit — start with generous thresholds and tighten them once you have a few clean baseline runs, rather than guessing thresholds up front.
12. Only once all of the above are wired and green should any payment/serverless-backend integration (§5) be added — it depends on Cloud Functions + secrets + webhooks all already working.
13. `npx ng add @angular/pwa` (§2a) for installability — check the version-pinning caveats there first if the Angular major is recent. Rasterize real icons before shipping; don't leave the schematic's placeholders in.

Write (or update) this same file, and the app-functionality-focused `PROJECT_OVERVIEW.md` counterpart, as the new project's infra takes shape — don't backfill either from memory after the fact.
