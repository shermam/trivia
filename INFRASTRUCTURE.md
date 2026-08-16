# Infrastructure Playbook

This document captures every **infra/tooling choice** behind this repo that is independent of what the app actually does (that's `PROJECT_OVERVIEW.md`'s job). It exists so:

1. Claude Code (or a human) can understand _why_ a piece of tooling was chosen, not just that it's there.
2. A brand-new project can be scaffolded from scratch with the identical stack, wiring, and CI/CD setup, by following §9 below.

If you change any infra choice (swap a tool, bump a major version, restructure CI), update this file in the same change.

---

## 1. Stack at a glance

| Concern                   | Choice                                                                      | Why (vs. alternatives)                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend framework        | **Angular** (latest major, standalone components, signals, no NgModules)    | Batteries-included (router, forms, HTTP, DI, CLI, build system) — one framework decision covers most of the frontend surface without picking a router/state/build tool separately.             |
| Styling                   | **Tailwind CSS** via `@tailwindcss/postcss`                                 | Utility classes only, no component-level CSS framework (no Material/PrimeNG) — keeps styling colocated in templates and bundle size predictable.                                               |
| Unit test runner          | **Vitest** (Angular CLI's `@angular/build:unit-test`, jsdom environment)    | Angular CLI's own current default builder — no separate Karma/Jasmine setup or browser launcher to maintain.                                                                                   |
| E2E test runner           | **Cypress**, against a real local **Firebase Emulator Suite**               | Real backend behavior (Firestore rules, Auth, Functions triggers) instead of mocks — mocks would drift from `firestore.rules`/Functions behavior and mask real regressions.                    |
| Backend-as-a-service      | **Firebase**: Firestore (data), Auth, Cloud Functions, Hosting              | One vendor covers DB + auth + serverless compute + static hosting + a matching local emulator suite — minimal glue infra for a small/solo-maintained app.                                      |
| Payments                  | **Stripe**, driven from owned Cloud Functions (not a marketplace extension) | Marketplace/extension integrations can be deprecated out from under you (this project's own history, §8) — owning the functions means the integration only depends on the Stripe API directly. |
| CI/CD                     | **GitHub Actions**                                                          | Native to GitHub, no separate CI vendor/account, generous free tier for a small project.                                                                                                       |
| Performance/a11y auditing | **Lighthouse CI** (`@lhci/cli`)                                             | Same Lighthouse engine as Chrome DevTools, runnable both locally and in CI with numeric thresholds instead of eyeballing scores.                                                               |
| Formatting                | **Prettier** + **EditorConfig**                                             | Zero-config-argument formatting, one shared config file, editor-agnostic baseline via EditorConfig.                                                                                            |
| Package manager           | **npm**, version-pinned (`packageManager` field)                            | No extra tool to install; pinning avoids "works on my machine" lockfile drift.                                                                                                                 |

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
- **`"strict": true` in `tsconfig.json` plus `"strictTemplates": true` in `angularCompilerOptions`, from day one.** The Angular CLI scaffolds both on; if they ever go missing (as they had here), nothing announces it — the build stays green and every `T | null` silently collapses to `T`, so the null-handling the code is visibly written for stops being verified. Templates are the easier half to overlook: without `strictTemplates` they're an entirely unchecked surface, and a renamed signal or a wrongly-typed binding only fails at runtime. Verify both are actually on rather than assuming the scaffold set them, and check any nested package (e.g. a serverless-functions dir with its own `tsconfig.json`) separately — this repo's `functions/` had `strict` on while the frontend didn't. Retrofitting onto a codebase already written in a null-aware style is usually far cheaper than it looks; measure before assuming otherwise.
- Angular CLI build **budgets** (`angular.json`): set explicit `initial` bundle and `anyComponentStyle` budgets (this project: 500 KB warn / 1 MB error initial; 4 KB warn / 8 KB error per component style) — catches bundle bloat at build time, not after a Lighthouse regression.
- Add a dedicated Angular build **configuration per non-production runtime target** that needs different config-at-build-time behavior (this project has `e2e` and `lighthouse`, both swapping in an emulator-pointed environment file via `fileReplacements` — see §4). Don't branch this kind of thing on `environment.production` alone.
- **Icons: inline SVG via one shared component, not an icon-font/library dependency.** Fetch the source library's raw SVG path data (e.g. from its `-static` npm package's CDN mirror) once, embed the literal `<path>` data in a `@switch`-based Angular component (`stroke="currentColor"` so callers control color via an ancestor text-color class), and never ship the library itself. Keeps the dependency count at zero and the bundle free of an icon font/sprite sheet.
- **Self-host web fonts. Do not hot-link them.** This was originally written the other way round — load a brand font from Google Fonts via a preconnected `<link>` and let the Lighthouse budget be the guardrail — and that advice was wrong on the point that mattered. A Google-hosted font makes every visitor's browser send its IP address to Google before the page has asked for consent, which LG München I (3 O 17493/20) held to be a GDPR breach; no performance budget catches a legal exposure. Self-hosting is also strictly faster: it removes two preconnects and a render-blocking stylesheet from the critical path, and lets the font be preloaded from your own origin. Take the `woff2` subsets the foundry or Google Fonts serves, commit them, ship the licence text alongside (the SIL OFL requires it), and put the font's revision **in the filename** if your host serves fonts with a long `immutable` cache and your asset pipeline doesn't content-hash them. Keep `unicode-range` per subset — it is what makes shipping an extended subset free, since the browser only fetches one whose glyphs are actually rendered.

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
- **Only claim `purpose: maskable` if the icon was actually designed with a maskable safe zone** (important content kept within the inner ~80%-diameter circle, i.e. a 40% radius, so Android's adaptive-icon mask never crops it mid-glyph) — the schematic defaults every icon to `purpose: "maskable any"` regardless. If the source mark is a full-bleed icon that wasn't designed with that safe zone in mind (common for an icon that started life as a plain favicon), ship `purpose: any` only rather than an unverified maskable claim.
- **The right fix is a second, padded icon, not a relaxed claim** — and it is worth doing, because the alternative is a cropped glyph on every Android home screen. Ship the mark scaled down inside a **full-bleed** ground under its own filenames, leaving the `any` icons untouched: a padded icon shown unmasked just looks small, so the two purposes genuinely want different artwork. Three things this project learned doing it (`scripts/make-maskable-icons.mjs`):
  - **Drop the rounded corners.** A maskable canvas belongs to the OS. A transparent or pre-rounded corner shows the launcher background through and produces the icon-inside-an-icon artefact that maskable exists to remove.
  - **Measure the overshoot; don't assume the "10% padding" shorthand.** That shorthand is the 40% radius read along an axis and only holds for artwork widest on an axis. Here the glyph measured 49.9% of canvas width — ×1.247 over budget — so it needed a 0.78 scale, not 0.9.
  - **Never overwrite the existing files** if images are served with a long `immutable` cache, or a corrected icon stays wrong in clients' caches for the full max-age. New filenames.
- **Verify the claim mechanically, because no tool will.** Lighthouse removed its PWA category in v12, so there is no `maskable-icon` audit any more, and a wrong `purpose` renders perfectly everywhere except an actual Android home screen. A ~150-line dependency-free PNG reader can measure the committed files against the manifest and fail CI (`scripts/verify-icons.mjs`, `npm run icons:verify`). Note the asymmetry that makes this cheap: **generating** the icons needs a browser, **checking** them needs only Node and `zlib` — so the check can run in CI even where the generator cannot.

**Don't let an app-level background task (e.g. an offline-data prefetch) fire unconditionally on every build** — gate it behind the project's existing environment-file split (§4) the same way `useEmulators` already is, and turn it off specifically under the `e2e`/`lighthouse` build configurations: a background task that fires its own HTTP requests on a timer can race Cypress's `cy.intercept`-based request waits (satisfying the wrong intercepted request) and has no reason to compete for resources during a Lighthouse-audited page load either. **An environment-file gate alone isn't enough if the project also has a real-preview e2e job (§6.4)** — a preview channel deploys the plain production build, not the `e2e` config, so anything gated only on the environment file is still fully active there. Add a second, environment-independent gate: `navigator.webdriver` is set to `true` by every browser-automation framework (Cypress, Selenium, Playwright) per spec, and never by a real user's browser — checking it is what actually stops a background task from firing during an automated run against a live deployed preview. Caught the hard way: this task's own requests, firing on every one of a Cypress suite's page visits against a real, shared, rate-limited backend, was enough added load on a CI runner to time out multiple unrelated specs — investigated by reproducing the deployed preview in a real (Playwright-driven) browser rather than guessing from CI logs alone.

**The same `navigator.webdriver` gate belongs on the service worker's own registration, not just an app-level background task riding on top of it** — registering/activating the worker and integrity-checking its precached app shell is itself real work competing for the same main thread and network as whatever the automated run is actually testing. On this project, gating only the offline-prefetch task (above) fixed the one spec it was directly responsible for, but two _other_, functionally unrelated specs (real Firebase Auth flows) were still measurably slower and occasionally timing out against a live preview until the service worker's `provideServiceWorker(..., { enabled: !isDevMode() && !navigator.webdriver })` itself picked up the same check. Confirmed by timing the exact same specs against a clean baseline run (no PWA changes) before concluding it was a real regression and not pre-existing flakiness — don't assume, measure.

**Keep `ngsw-config.json` to the default app-shell `assetGroups`** (prefetch the JS/CSS/HTML/manifest, lazily cache images/fonts) rather than reaching for its `dataGroups` to cache calls to a third-party API. A rate-limited third-party API (or one needing app-level normalization/filtering, like this project's Firestore-backed question bank) is better served by a purpose-built app-level cache (e.g. IndexedDB) that the app controls the fetch/eviction policy for, than by the service worker's generic HTTP-cache-with-a-strategy model.

**Exclude `ngsw-worker.js` from any blanket long-lived-cache header rule** (e.g. a `**/*.js` → `immutable, max-age=31536000` rule aimed at hashed build output) — add a dedicated header rule for that exact path with `Cache-Control: no-cache`, declared _after_ the blanket rule so it wins (§3's "last-declared matching rule per header key"). The service worker script's own filename is never hashed/versioned, so the browser's update-check mechanism depends on actually being able to re-fetch and byte-compare it; caching it long-term defeats that. Verified directly against the live deployed site's response headers, not assumed from the config alone.

---

## 3. Firebase project setup

**Scaffold:**

```bash
npm install -g firebase-tools   # or use npx --yes firebase-tools@<pinned-major> per script, see §7
firebase login
firebase init firestore hosting functions
```

- `.firebaserc` pins the default project ID. One Firebase project for the whole app (no separate staging _database_ — see §6 on preview channels for why that's an accepted tradeoff for a small app).
- `firestore.rules` is the actual security boundary — never trust client-side gating alone for anything that matters (auth checks, role/entitlement checks, schema validation). Write rules that validate exact key sets and value bounds on every collection accepting client writes, not just `allow read/write: if request.auth != null`.
- **Never commit a Firebase config/API key to source.** Firebase Hosting auto-serves a reserved `/__/firebase/init.json` endpoint for whatever project is serving the current origin — fetch that at runtime instead of hardcoding config. In local dev, proxy that path (`proxyConfig` in the dev-server build target, e.g. `src/proxy.conf.json`) to the real Hosting URL so `ng serve`/equivalent gets a real config with zero secrets in the repo.
- Wrap every Firestore/Auth SDK call that's expected to resolve quickly in an explicit timeout helper. The Firestore SDK's promises don't reject on their own if the backend is unreachable (e.g. placeholder credentials, network partition) — without a timeout, that's a silently-infinite loading spinner instead of a surfaced error.
- **Local emulator suite** (`firebase.json` → `emulators`): pick fixed ports for every product you emulate (Firestore, Auth, Functions, Hosting) plus `"ui": { "enabled": true }` and `"singleProjectMode": true`. Use a distinct, throwaway project ID for the emulator suite (e.g. `demo-<app-name>-e2e`) — never point emulators at the real project ID.
- **Hosting header rule ordering matters**: Hosting applies the _last_-declared matching rule per header key for a given request path. If you have both a catch-all (`**`) header rule and more specific rules (hashed JS/CSS, images/fonts), declare the catch-all _first_ and the specific overrides _after_, or the specific rule's cache policy will never apply.
- If you need `Cross-Origin-Opener-Policy: same-origin-allow-popups` (needed for Firebase Auth popup sign-in to read `popup.closed`), set it on the actual served routes (the SPA rewrite fallback `**`, not a literal path like `/index.html` that a client-side router never actually requests).

---

## 4. Environment/config layering

A three-way split, so no build ever ships secrets and every build config is explicit about which backend it talks to:

- `environment.ts` / `environment.development.ts` — flags only (`production`, `useEmulators`), no secrets. Real Firebase config is fetched at runtime (§3), never embedded here.
- `environment.e2e.ts` — sets `useEmulators: true`; swapped in only by a dedicated `e2e` build/serve configuration (`fileReplacements` in `angular.json`), never by the default `build`/`serve`.
- A same-shaped `lighthouse` build configuration reusing the same `e2e` environment file, so Lighthouse audits run against the emulator suite too (see §6.4 for why).

Cloud Functions get their own env layer, kept **separate** from the frontend's:

- Real secrets (API keys, webhook secrets) go through the functions framework's Secret-Manager-backed secret mechanism (e.g. `firebase-functions/params`' `defineSecret`), set once per project via the CLI — never `process.env` read directly from a committed file.
- A **placeholder-only** local secrets file lets the emulator run without real Secret Manager access (which a fresh checkout / CI runner won't have by default) — and pins every declared secret so the emulator can't silently fetch a real one where a Google credential _is_ present (it will try, at the first invocation of any function declaring secrets — measured on firebase-tools 15). Commit it as a `.example` template copied into the real filename by an install hook, never under the real name itself: the real-named file stays gitignored, so putting genuine keys in it for local against-real-services testing is safe by default (see §10.2).
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
- If a real popup/redirect can't be triggered from an automated test (e.g. `Location.assign` isn't stubbable in a real browser context), add a narrowly-scoped "mock mode" flag — env-gated to the test project only (§4) — that swaps the real third-party API call for a deterministic, same-origin fake response, so the _rest_ of the flow (your own function, your own Firestore write, your own client listener) still gets exercised for real.

---

## 6. CI/CD (GitHub Actions)

Four independent workflows, deliberately not one monolith — so a slow suite never blocks fast feedback on a different one, and a red job is unambiguous about what broke:

### 6.1 Unit tests (`unit-tests.yml`)

Every PR to `main` + push to `main`. Checkout → setup Node (LTS, matching the functions runtime) → `npm ci` → run the unit test command. Fastest signal, kept separate from everything else.

### 6.1a Lint & format (`lint.yml`)

Every PR to `main` + push to `main`. Same shape as §6.1, running `format:check` then `lint` (cheapest first — formatting is a text comparison, lint needs a TypeScript program). Both in one job: they answer a single "does this meet the bar" question, and splitting them would pay for a second `npm ci` to say what a step name already shows.

Separate from §6.1 rather than bolted onto it, per §8's one-workflow-per-concern rule — they run concurrently, so a lint failure and a test failure surface on the same push instead of the first masking the second.

### 6.1b Security-rules tests (`rules-tests.yml`)

Every PR to `main` + push to `main`. Needs a JDK and the emulator binary (cache both), then runs the rules suite against the database emulator alone — no auth, no functions, no dev server, no browser, so it lands much closer to §6.1's cost than §6.2's.

Its own workflow rather than steps in §6.1, per §8: paying a JDK and emulator download on every fast unit-test run, purely to avoid adding a workflow file, is the wrong trade.

**Write the reject cases, and then break the rules on purpose to confirm the suite notices.** A rules suite is uniquely prone to passing vacuously — a context constructed slightly wrong (see §8's note on unset token claims) makes a test pass for a reason unrelated to the rule it names. Mutate the rule, watch a test fail, restore. That's the only evidence the suite has teeth.

### 6.2 E2E (`e2e.yml`)

Every PR to `main` + push to `main`. Needs, beyond Node: a JRE (if your DB emulator runs on the JVM, e.g. Firestore's), and caching for both the emulator binaries and the e2e tool's own binary cache (e.g. `~/.cache/Cypress`) keyed off the runner OS. Steps: install root deps, install the serverless-functions package's deps separately (it's a separate npm package, §4), run its unit tests, then run the full e2e suite (which itself wraps `emulators:exec` so the emulator trio starts/stops around the test run). Upload screenshots/videos as a build artifact on failure only.

### 6.3 Merge-to-deploy (`firebase-deploy.yml`)

Fires only on a PR **closed and merged** into `main` (not just closed). Checkout `main` → install → production build → deploy Hosting (via the platform's official GitHub Action, authenticated with a repo-secret service account) → deploy database rules/indexes separately (own step, so a rules-only failure is distinguishable from a Hosting failure) → install + deploy the serverless functions package separately again (own step, same reasoning). Always clean up any temp credential files, even on failure (`if: always()`). Scope job permissions to the minimum the deploy actions actually need (e.g. `contents: read`, plus `checks: write`/`pull-requests: write` only if the hosting-deploy action posts PR comments/checks).

This is a **deploy-on-merge** pipeline: it doesn't re-run e2e itself. That's only safe because of §6.4 gating merges in the first place.

**Never write `__name__` into a composite index definition, even though the API reports it there.** This broke this project's deploy pipeline for four consecutive merges, and the shape of the failure is why it is worth a rule rather than a note:

- The deploy that _introduces_ the index **succeeds** — it creates it. Every deploy afterwards fails, on unrelated PRs, having already shipped Hosting. So the pipeline breaks with a red step on a change that has nothing to do with indexes, and stays broken.
- The two CLI majors disagree, and only one direction is safe. The version used here to deploy rules/indexes **strips `__name__` from every index it reads back from the project**, then compares field counts against the file verbatim — so a declared `__name__` makes the file describe a _different_ index from the live one, the CLI decides the live one should be deleted, and in non-interactive mode it refuses without `--force`. The newer major instead _appends_ `__name__` to the spec when absent, so it matches either way. **Omitting it is correct under both; declaring it is correct under only one.**
- `--dry-run` does not catch it. It validates the file and the rules, not the diff against the project.
- Nothing local catches it either: an emulator does not enforce index configuration at all, so the whole test suite is blind to this class of error by construction.

The durable guard is a test that reads the indexes file and asserts no index declares `__name__` (`firestore-tests/indexes.spec.ts` here). It costs nothing and is the only thing between this mistake and a silently broken deploy pipeline. And the general lesson: **`--force` would have "fixed" this by deleting the production index** — when a deploy tool asks for `--force`, it is describing an intent, and the right response is to find out which intent, not to grant it.

### 6.3a Knowing a deploy broke, and undoing it

A deploy-on-merge pipeline has two failure modes that nothing else in CI covers, and this project hit both.

**A deploy can fail silently.** Ours went red on four consecutive merges while Hosting kept shipping, and nobody noticed — the run is not attached to a PR anyone is still looking at, and a failure email is easy to miss. Two cheap mechanisms close it:

- **A post-deploy smoke test** that asks the deployed site whether it works — app shell served, security headers intact, runtime config resolving, static `public/` assets reachable, callables deployed and still rejecting unauthenticated callers. Put the checks in a **script**, not in workflow steps: a script can be run against production from a laptop, while a workflow step can only be tested by merging it. Ours is `scripts/smoke-test.mjs`, runnable as `node scripts/smoke-test.mjs https://<host>`. It retries a _timed-out_ request once, because a fresh Hosting deploy can leave a cold CDN edge that hangs the first fetch of a path while the site is healthy — that once filed a false deploy-failure alarm — but only a timeout earns the retry: an HTTP error status is a response, and a failed assertion (a missing header, a wrong project ID) fails as loudly as ever.
- **A failure that opens an issue.** An issue stays open until someone closes it, which a red run and an email do not. De-duplicate on a label so a pipeline that is broken for every merge produces one issue with comments rather than twenty issues.

**Deploys are not atomic across layers.** Hosting ships first, then rules/indexes, then functions — so a failure part-way through leaves a _newer client against an older backend_. Whatever reports the failure should say so, because "the deploy failed" invites the wrong assumption that nothing shipped.

**Rollback, in order of speed.** Verify which commands actually exist in the CLI major you run — several plausible ones do not:

1. **Fastest, Hosting only** — the Console's Hosting → Release history → Rollback, or `firebase hosting:clone <site>:<channel> <site>:live` to re-point live at a known-good version. Seconds, no CI cycle, but it moves _only_ Hosting: rules and functions stay where they are, which widens the very client/backend split above if they were the problem.
2. **The coherent one** — `git revert` the offending merge and merge the revert. The pipeline redeploys all three layers from one commit, so they end up consistent with each other, and the revert is reviewable. Costs a full CI cycle.
3. **Emergency stop** — `firebase hosting:disable` stops serving the site entirely. Reach for it only when serving nothing beats serving what is live.

There is **no `hosting:rollback` command** and no rollback command for Cloud Functions at all; functions are restored by deploying an earlier commit. Confirm this against `firebase --help` for your pinned major rather than trusting a plausible-sounding command name.

### 6.4 Preview deploy + real-preview E2E (`firebase-preview.yml`)

Every PR to `main` on open/sync/reopen, with a `concurrency` group keyed on the PR number so a new push cancels a stale in-flight run. Two sequential jobs, plus a third on `closed`:

1. Deploy to an ephemeral preview channel (not `live`) named after the PR (short expiry, e.g. 7 days). Parse the deploy action's URL output for the next job.
2. Run a **scoped** slice of the e2e suite against that real, live preview URL — the parts that are safe to run against a real, shared, persistent backing project (see the caveats below).
3. **Delete the channel when the PR closes** — see the quota note below. The deploy jobs are guarded with `github.event.action != 'closed'` so adding that trigger doesn't make them redeploy a PR that just merged.

Then make that preview-e2e job a **required status check** in branch protection on `main`, so nothing merges (and therefore nothing reaches §6.3) without a real deployed preview actually passing e2e. This is what makes it safe for §6.3 to not re-run e2e on its own.

Caveats worth carrying into a new project:

- Preview channels are typically **hosting-only** — there's usually still one shared database for the whole project, so a preview build's e2e run reads/writes the same data as production. Exclude specs that would pollute real, persistent data, or that depend on emulator-only testing endpoints (e.g. reading an email-verification link programmatically) with no live equivalent.
- Exclude specs that exercise serverless functions if those functions aren't preview-channel-scoped either (commonly true) — a preview build shares the _already-deployed_ production functions, so running a real side-effecting flow (e.g. a real payment checkout) against them from every preview is the wrong tradeoff. Keep a mock-mode escape hatch (§5) for exactly this.
- Give any preview-created test data unique-per-run identifiers (e.g. timestamp-suffixed) so two previews running concurrently against the same real backend never collide.
- Track and sweep up anything a preview-e2e run creates in the real backend (an `after`/teardown hook + a real-project-flavored variant of your task/seed helpers) — there's no throwaway emulator to just tear down here.
- **Delete the preview channel when its PR closes, rather than relying on the expiry you set.** Firebase Hosting caps preview channels at **50 per site**, and the cap is a hard failure, not a warning: once it's reached, every new PR's deploy dies with `429 … channel quota reached` and there is nothing in the PR's own diff to explain it. A TTL only bounds a channel's age, not the count — so any repo merging PRs faster than the TTL expires them accumulates toward the cap, and the ceiling arrives on whichever unlucky PR happens to be next. This one hit at 50 channels of which **49 were for already-merged or closed PRs**, i.e. the cap was entirely consumed by garbage. The fix is a one-line trigger (`closed`) and a job that deletes `pr-<number>`, which keeps the count proportional to _open_ PRs instead of to time.
- **That cleanup job still needs a repo checkout, even though it builds nothing.** `hosting:channel:delete` refuses to run outside a Firebase app directory ("could not locate `firebase.json`"), because it resolves the target site from that file — `--site` and `--project` do not substitute for it. The job otherwise has no use for the repo, which is exactly why the checkout is easy to leave out, and it then fails on every single merge. Worth knowing generally: a CLI that reads project config from the working directory needs the checkout even in a job that only calls one command.
- **In that cleanup job, treat "channel not found" as success but nothing else.** It legitimately won't exist when the deploy was skipped (e.g. Dependabot) or when the deploy itself failed — which is exactly the state the quota outage leaves behind. Distinguishing that from a real error matters: blanket `continue-on-error` here would also swallow a credential or permission failure, letting channels silently accumulate again, which is precisely the failure the job exists to prevent.

**Preview channels cover hosting, not compute.** A preview deploys the PR's static build against the project's _already-deployed_ serverless functions, so a PR that adds a new function shows a broken feature on its own preview until it merges — the client calls something that isn't there. Worth knowing before debugging a phantom bug, and worth handling in the client: map the platform's "no such function" error to a message saying so, because the default advice to retry is wrong in a way the user cannot discover. Verify these features against the local emulator instead, and re-check on the live site after merge.

### 6.5 Lighthouse (`lighthouse.yml`)

Every PR to `main` + push to `main`. Build with a dedicated Lighthouse build configuration (same optimizations as production, but pointed at your local emulator suite via the same environment-swap mechanism as e2e — §4), start the Hosting (+ any backend your app calls on load) emulators, run Lighthouse CI 3× against the emulator-served Hosting URL, assert median scores per category against `lighthouserc.json`. Upload HTML/JSON reports as a build artifact unconditionally (`if: always()`), pass or fail.

**Serve from the real Hosting emulator, not a bare static file server**, if your app depends on a Hosting-specific reserved endpoint (like Firebase's `/__/firebase/init.json`, §3) to initialize anything at runtime — a bare static server will make that initialization silently fail, which can _look like_ a better best-practices score (nothing initialized, so nothing logged a runtime error) while actually hiding the exact class of regression the check exists to catch.

---

## 7. Tooling version pinning

- Pin the package manager itself (`"packageManager": "npm@<version>"` in `package.json`) to avoid lockfile-format drift across contributor/CI Node installs.
- **Pin the Node version itself, and bump it in one place at a time everywhere it's declared**: the serverless-functions package's `engines.node` (this is what the deploy platform actually provisions), every CI workflow's `setup-node` step (kept at the same version as the functions runtime — §6.1), and a committed root `.node-version` for local `nodenv` users so a fresh clone auto-selects the right version instead of silently building/testing against whatever a contributor's shell happens to default to. Treat these three as one unit — bumping only one is how "works in CI, fails/differs locally" (or vice versa) drift creeps in.
- If a CLI tool's _major version_ behaves differently depending on what else is in the repo (e.g. a serverless-functions runtime major-version bump removing an API the CLI's older major still probes for unconditionally), pin _different_ majors of that CLI per script depending on what the script touches, rather than forcing one global version that breaks half your scripts. Document exactly why in the script/README — this kind of pin looks like an accident if unexplained.
- When different scripts genuinely need different majors of the same CLI, you can't make it a single `devDependency` (one package name, one version, in `package.json`). Handle the two majors asymmetrically instead of falling back to `npx` for both: make the major that backs your _frequently-run_ local scripts (e.g. an e2e suite invoked many times a day) a real `devDependency`, pinned exactly — `npm` scripts already put `node_modules/.bin` first on `PATH`, so those scripts can call the bare tool name and always get that exact locally-installed version, no per-run `npx` cache/registry round-trip. Leave the rarer major on `npx <tool>@<pinned-major>`. Either way, pass `--yes` on the `npx` calls — without it, npm ≥7 stops and prompts ("Need to install the following packages... Ok to proceed?") the first time that pin isn't already in the local npx cache, which only ever surfaces locally (CI's non-interactive shell never sees the prompt either way, so this is purely a local-DX fix, not a CI behavior change). A CI step that deploys with one of these tools can stay on the explicit `npx <tool>@<pinned-major>` form even after the same major becomes a local `devDependency` — a one-shot deploy on a fresh runner doesn't benefit from the local-cache win, and an explicit, self-contained pin on that one line keeps "what exact tool version did the last deploy" answerable without cross-referencing `package.json`.
- A package with its own `package.json`/lockfile nested in the repo (e.g. a Firebase Functions source dir) is invisible to the root `npm install`/`npm ci` — wire a root `postinstall` script that installs it too, so a single `npm install` after cloning is enough to run every local script, instead of a manual extra install step that's easy to forget and shows up as a confusing "Cannot find module" from that package's own build/typecheck step. **Have that hook run `npm ci`, not `npm install`** (see §10.5), and keep a separate `…:install:update` script running `npm install` for the one case that genuinely needs it — adding or bumping a dependency in the nested package. Then the everyday path is deterministic and the lockfile-changing path is explicit, rather than every root install silently being allowed to rewrite a lockfile.

---

## 8. Formatting & editor baseline

- **Prettier**: pin `printWidth`/`singleQuote` project-wide; add a `files`-scoped override for any template language your framework uses that Prettier doesn't parse with its default parser (e.g. Angular HTML templates need `"parser": "angular"`).
- **EditorConfig**: charset, indent style/size, final-newline, trailing-whitespace — plus per-extension overrides where a language has a different natural convention (e.g. Markdown often wants trailing-whitespace trimming _off_, since two trailing spaces is a hard linebreak in Markdown).
- **PostCSS**: a one-line `.postcssrc.json` wiring in the CSS framework's PostCSS plugin (e.g. `@tailwindcss/postcss`) is all that's needed — don't hand-roll a PostCSS config beyond what the framework's own `add`/init schematic generates.
- **A formatter nobody runs is decoration.** Prettier sat in this repo as a devDependency with no `format:check` script and no CI step, and 12 files had drifted out of style — including two of the three docs that serve as the project's reference material. Add `format`/`format:check` scripts and a CI step in the same change that adds the formatter, not later.
- **Prettier needs a `.prettierignore`**, or `prettier --check .` walks build output, generated reports and lockfiles and fails on files nobody edits by hand. Its only built-in ignore is `node_modules`.
- **Linting: `ng add angular-eslint@<matching-major>`**, version-pinned to the installed Angular major for the same reason §2a's PWA schematic is. Beyond the recommended sets, two additions earn their keep: **type-aware linting** (`projectService: true`, enabling `no-floating-promises` / `no-misused-promises` — the only mechanical defence against a forgotten `await` on a backend call, which fails silently and leaves the UI stuck) and a handful of template rules the recommended sets omit (`button-has-type`, `no-duplicate-attributes`, `no-positive-tabindex`, `eqeqeq`). Leave purely stylistic rules off: Prettier owns formatting, and a lint run that cries wolf gets ignored.
- **One workflow per concern, even when that means a manual step to enable the gate.** Lint/format, unit tests, e2e and Lighthouse each get their own. They run concurrently rather than in sequence, so one failing class of check can't hide another, and a red check names the actual problem without anyone opening a log. The pull to instead bolt new steps onto an already-required job — because a brand-new status check gates nothing until a repo admin adds it to the ruleset — is a real convenience and the wrong trade: it buys a one-off settings step at the cost of a permanently muddier signal. Add the workflow, and say plainly in the PR that the check still needs enabling.
- **Never give Dependabot a deployment credential — skip the jobs that need one instead.** A workflow triggered by a Dependabot PR runs `npm ci` and a build, which executes the install scripts and build-time code of the _very dependency version under review_. If that job also holds a deploy service account, untrusted package code is running in a job that can reach production — on a PR whose whole purpose is changing a dependency. The instinct when such a job fails with `Input required and not supplied` is to copy the secret into Settings → Secrets → **Dependabot** (a separate store from Actions secrets, which is why it is missing). Don't: gate the job on `if: github.actor != 'dependabot[bot]'` and let the credential-free checks do the work. Two further reasons the copy is a poor trade even ignoring the risk — the secret cannot be read back out of GitHub, so you must mint a _new_ service-account key to do it, and Dependabot-triggered workflows get a read-only `GITHUB_TOKEN` that a `permissions:` block cannot elevate, so any step posting a PR comment fails next anyway. Revisit only when there is a fully isolated dev project whose credentials cannot touch production.
- **A required check can be skipped without blocking the merge — if the condition sits on the job.** A job skipped by a job-level `if` reports a `skipped` conclusion, and branch protection counts that as success. A job that never appears at all — a workflow filtered out by `paths:` or `branches:`, say — leaves the check permanently "expected", which blocks forever. Same intent, opposite outcome, and the difference is only visible once a PR is stuck.
- **Never add a `name:` to a job whose id is a required status check.** The context is the job id unless a display name overrides it, so adding one silently renames the check and detaches it from the ruleset — the gate stops applying and nothing announces it. Worth a comment in the workflow itself, because it looks like a harmless cosmetic edit.
- **Check what your quality gate actually aggregates before trusting a green run.** Lighthouse CI's `aggregationMethod` defaults to `optimistic`, which for a `minScore` assertion asserts the _best_ of N runs — so a build scoring 0.84/0.66/0.62 passes a 0.75 threshold on the strength of one lucky run, and the check reports green while two thirds of the evidence says otherwise. Set `median` explicitly. Don't reach for `pessimistic` without looking at the data first: on this project the _first_ run of every CI batch is a cold-start outlier (0.90, 0.68, 0.52 across three real runs, against 0.91–0.92 for runs 2 and 3), so asserting the worst run would fail constantly for reasons unrelated to the code. Median over three runs discards exactly one outlier, which matches that noise shape.
- **A threshold is only meaningful next to the aggregation it is asserted against.** Changing `optimistic` to `median` silently makes an existing threshold stricter, so re-baseline in the same change, from real CI numbers rather than local ones — CI runners are slower and noisier, and the gap is where flaky gates come from. Download the reports the workflow already uploads as artefacts; several runs of real data beats a guess.
- **Verify what a linter actually enforces before relying on it.** Several guardrails in `CLAUDE.md` §4 were written assuming a lint rule existed for them; wiring ESLint up showed five had no rule anywhere in the ecosystem (notably: nothing validates an Angular `@for` track expression's semantics, and no accessibility rule _requires_ an `aria-expanded` or a `role="radiogroup"` to be present — they only validate ARIA that is already there). "A linter will catch it" is a hypothesis, not a plan.

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

Write (or update) this same file, and the app-functionality-focused `PROJECT_OVERVIEW.md` counterpart (an index over `docs/`), as the new project's infra takes shape — don't backfill either from memory after the fact.

---

## 10. Infra guardrails that must not regress

The app-layer counterpart to this list lives in `CLAUDE.md` §4. Everything here was a real gap found in an audit of this repo, and every one of them is generalizable — if you scaffold a new project via §9, these are the infra decisions that are easy to get wrong once and then never look at again.

### 10.1 Deploy ordering and gating

- **Deploy the backend contract before the frontend that depends on it.** Rules and serverless functions go out _first_, hosting last. The reverse order (this repo's original) puts a new client live against an old backend for the length of the remaining deploy steps — a window that only ever bites on the release where it matters, because that's the release that changed both. Worth being precise about _why_ this is the right order rather than a coin flip, because the symmetric-looking risk is real: an **old client against a new backend** is not avoidable by ordering at all, since anyone with the app open across a deploy — or served a precached shell by a service worker — is running one whichever way the steps run. A backend change therefore has to stay compatible with the deployed client regardless; and once that holds, backend-first strictly dominates, because it is the only order that _also_ closes the new-client window. Build before deploying anything, too, so a compile error aborts without having touched production.
- **Writing the guardrail is not applying it.** This repo carried the bullet above while the workflow still deployed hosting first — the reasoning was documented, agreed and simply never wired up, and nothing in CI compares a stated ordering against the file that implements it. When a deploy-ordering rule matters, check the workflow rather than the doc asserting it.
- **A deploy pipeline that runs no tests is only as safe as the thing gating merges into it.** Merge-to-deploy is a fine pattern, but it means branch protection _is_ your test gate. A required status check that was never actually enabled in repo settings is not a gate — it's a comment in a YAML file. Verify the setting exists, don't infer it from the workflow. This is repo-admin-only and cannot be set from CI, so it's easy to write the workflow, believe it's enforced, and never check.
- **…and verify it at the right endpoint.** GitHub now has two independent mechanisms — classic _branch protection_ and _rulesets_ — and the legacy `GET /repos/{owner}/{repo}/branches/{branch}/protection` API reports `404 "Branch not protected"` for a branch fully protected by a ruleset. The 404 is not evidence of anything. Check `GET /repos/{owner}/{repo}/rules/branches/{branch}` (effective rules from all sources) or `/rulesets` before concluding gating is missing — this repo's `main` is ruleset-protected and 404s on the legacy path, which is a false negative waiting to be acted on by anyone auditing it.
- **Have a post-deploy signal and a rollback path.** A multi-step deploy (hosting, then rules, then functions) can half-succeed. Without a smoke check afterwards, a partial deploy is indistinguishable from a clean one until a user finds it.

### 10.2 Secrets in CI

- **Pass secrets through `env:`, never interpolate them into a `run:` string.** `echo '${{ secrets.FOO }}' > file` makes the secret part of the command line, which is the documented anti-pattern: it breaks on any value containing a quote, and it puts the value somewhere shell tracing and error messages can reach. Bind it as an environment variable and `printf '%s' "$FOO" > file` instead.
- **Clean up written credential files with `if: always()`**, so a failed step doesn't leave a service account key on the runner.
- **Prefer the narrowest workflow trigger that works.** `pull_request` withholds secrets from fork PRs by default, which is what you want; `pull_request_target` does not, and is how CI secrets get exfiltrated by a PR that only changed a build script.
- **Never track a file whose name conventionally promises "local, gitignored"** (`.secret.local`, `.env.local`) — even with placeholder contents. The name is an instruction to put secrets there, and tracking the file turns that instruction into a committed credential on the next careless `git commit -am`. Commit a `.example` template and copy it into place from an install hook instead; the real-named file stays ignored, so following the name's promise is safe. (This repo shipped exactly this trap: a committed `functions/.secret.local` whose own comment told developers to delete it before putting real keys anywhere — fixed as audit finding D5.)

### 10.3 Dependency and audit policy

- **Triage production and development advisories separately.** A single `npm audit` number conflates "ships to users" with "runs on a CI box", and the two deserve completely different urgency. In a repo with a nested serverless-functions package, run the audit _there_ too — its dependencies are production runtime, even though the root's overlapping ones are dev-only.
- **Never take `npm audit fix --force` without reading the plan.** Its "fix" for a transitive advisory with no upstream patch is frequently a multi-major _downgrade_ to a version that predates the vulnerable subtree entirely. That's not a patch; it's a regression with a green audit score.
- **Record why an unfixable advisory is being accepted, where the fix is blocked, and what unblocks it.** An undocumented accepted advisory is indistinguishable from one nobody noticed.

### 10.4 Hosting response headers

- **Security headers are part of the app's contract, not an optional extra.** A static SPA still needs `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy` and a `Permissions-Policy`. Lighthouse's best-practices category does not score these, so a 1.0 there says nothing about whether they exist.
- **Verify header rules against real response headers, never against your reading of the config.** Hosting header/rewrite precedence is genuinely unintuitive — this repo has already shipped one rule scoped to `/index.html` that silently never matched any request (every route is served via the `**` rewrite, so nothing ever requests that path literally). `curl -I` the emulator or a preview channel.
- **If the app supports iframe embedding, scope it.** Omitting `X-Frame-Options` to allow embedding is not the same as deciding who may embed; use CSP `frame-ancestors` to state the allowlist explicitly.

### 10.5 Lockfile determinism

- **`npm ci` must mean `npm ci` all the way down.** A root `postinstall` that runs `npm install` inside a nested package (§7) quietly reintroduces non-determinism into every CI run that thought it was doing a clean install, and can rewrite the nested lockfile as a side effect. Use `npm ci` there too when a lockfile is present.
- **Every workflow's dependency cache key covers every lockfile that workflow installs**, or the cache silently serves the wrong tree. Easy to get half-right: this repo had `cache-dependency-path` listing both lockfiles in two workflows and only the root one in the other three — and because the nested install happens via a `postinstall` hook rather than an explicit step, nothing in those three workflows visibly mentioned the second package at all. Audit by grepping every `setup-node` block, not by reading the steps.

### 10.6 Operational note: verification cannot be parallelized

The emulator ports (Firestore `8080`, Auth `9099`, Functions `5001`, Hosting `5000`) and the Cypress dev-server port (`4200`) are fixed in `firebase.json`, `cypress.config.ts` and the npm scripts. Two `npm run e2e` or `npm run lighthouse` invocations on the same machine collide immediately. Plan long batches of work as sequential — splitting the _writing_ across parallel workers doesn't help when every unit still has to take its turn on the one emulator suite, and it multiplies conflicts in the files (`firestore.rules`, `PROJECT_OVERVIEW.md`, `package.json`) that most changes touch.
