# Instructions for Claude Code

These apply to every session in this repository. Follow them without being asked.

## 0. Branching & PRs

- Never commit directly on `main`, and never keep piling unrelated work onto whatever branch happens to be checked out. For any new task, start from an up-to-date `main` and create a fresh branch off it before making changes:
  ```bash
  git checkout main
  git pull origin main
  git checkout -b <type>/<short-description>   # e.g. feature/..., fix/..., docs/..., ci/..., chore/...
  ```
- Once the change is complete and the verification suite in §3 is green, push the branch and open a PR against `main` (`gh pr create`). Don't push straight to `main` and don't merge the PR yourself unless explicitly asked to.

## 1. Before starting any task

- **Read `PROJECT_OVERVIEW.md` first — it is now an index, and it is short.** It maps five documents under `docs/`, each with a "read it when" line: `app.md` (§1, everything under `src/app/`), `stack.md` (§2, dependencies, Firebase wiring, `functions/`), `data-model.md` (§3, collections and `firestore.rules`), `ci-cd.md` (§4, workflows, e2e, Lighthouse, npm scripts), `known-gaps.md` (§5–§6, history and what is deliberately missing). **Then read the one your task touches, in full** — and `known-gaps.md` too if you are planning rather than implementing. Together these are the source of truth for what this app does and how it is built; don't assume, confirm against them before touching code. This used to be one 148 KB file read in full every session, which is what finding F5 was about; the section numbers did not change in the split, so an old `§4.2a` reference still resolves — it just lives in `ci-cd.md` now.
- **Read `INFRASTRUCTURE.md`** whenever the task touches build tooling, hosting, CI/CD, or any other infra-layer decision rather than app/game functionality. It documents this project's stack choices (Angular, Firebase, Stripe, Cypress, GitHub Actions, Lighthouse CI, etc.) independently of the trivia app itself, and is the reference to follow if scaffolding a new project on the same infra.
- **Read `AUDIT_REMEDIATION.md`** — an audit produced 55 findings that are being fixed as a long series of small PRs, spanning many sessions. It records what is done, what is next, the working rules for the series, and the decisions already taken (so they aren't silently revisited). If the task is "continue the audit work", that file _is_ the brief. If the task is an unrelated feature, still skim §5 — you may be about to touch something with a known open finding against it, and §4 may already record why it looks the way it does.

## 2. After making any change

- **Update the relevant document under `docs/`** so it stays accurate: new/changed routes or services in `app.md`, dependencies or `functions/` changes in `stack.md`, Firestore collections/rules in `data-model.md`, CI steps and config in `ci-cd.md`, closed items in `known-gaps.md`. A stale overview is a bug — treat it as part of the change, not an afterthought. Update `PROJECT_OVERVIEW.md` itself only when the _map_ changes (a document added, removed or repurposed).
- If the change is to tooling/CI/hosting rather than app functionality, update `INFRASTRUCTURE.md` instead (or in addition).
- **If the change closes an audit finding, update `AUDIT_REMEDIATION.md`** — mark the finding in §5 with its PR link and refresh the counts in §1, in the same PR. It's the only thing tracking that series across sessions; a stale plan is worse than none.

## 3. Before sending a PR / concluding a task

Run the full local verification suite, in this order, and treat all of it as required:

```bash
npm test                # unit tests (Vitest)
npm run functions:test  # Cloud Functions unit tests
npm run e2e             # full Cypress e2e suite against the local Firebase Emulator Suite
npm run lighthouse      # Lighthouse CI (perf/accessibility/best-practices/SEO) against a local build
```

- **Fix every failure before concluding the task.** Do not report work as done, open a PR, or hand back control with a known-red test, e2e, or Lighthouse run.
- If a failure looks pre-existing and unrelated to your change, say so explicitly to the user and get confirmation before ignoring it — don't silently skip it.
- Never "fix" a failure by loosening a threshold (e.g. `lighthouserc.json` scores), deleting/skipping a test, or adding `continue-on-error`/`--no-verify` to make CI green. Fix the underlying issue.
- Only once all four commands are green (or the user has explicitly signed off on a documented exception) is the task ready for a PR.

### 3a. Risk-scoped local verification (standing exception)

`npm run e2e` and `npm run lighthouse` each take minutes. Running all four commands on a change that cannot possibly affect runtime behavior is pure cost, so the following exception is **signed off as standing policy** — it is the only sanctioned deviation from §3, and it does not weaken the gate, because `e2e.yml`, `lighthouse.yml` and `firebase-preview.yml` still run the full suite on every PR regardless.

Run **all four** commands when the change touches any of:

- anything under `src/app/` other than a comment
- `firestore.rules`, `firestore.indexes.json`, `firebase.json`
- anything under `functions/src/`
- `angular.json`, `ngsw-config.json`, `src/index.html`, `src/styles.css`, routing, or an `environment.*.ts`

Run **`npm test` + `npm run functions:test` + `npm run build:prod`** only when the change is confined to:

- Markdown/docs, `.editorconfig`, `.prettierrc`, `.gitignore`
- CI workflow files (they are exercised by being run on the PR itself)
- lint/format configuration that produces no source changes

When you take the exception, say so explicitly in the PR body and name which commands you ran. Never take it silently, and never take it for a change you are unsure about — the whole point is that the judgment call is visible.

---

## 4. Invariants that must not regress

Everything below was a real defect found in an audit of this repo. Each one is cheap to reintroduce while adding an unrelated feature, and most are invisible to the existing test suite. Treat this section as a contract: if a change violates one of these, either fix the change or update this section _with the reasoning_ in the same PR — don't leave a silent exception.

Each guardrail is tagged with the mechanism that catches a violation:

- **[review-only]** — nothing automated will ever catch this. It depends on you actually checking.
- **[lint]** — `npm run lint` fails. **Live now**, reported by the `lint` CI check.
- **[rules tests]** — `npm run rules:test` fails (`firestore-tests/`). **Live now**, reported by the `rules-tests` CI check.
- **[functions tests]** — `npm run functions:test` fails. **Live now**, reported by the `functions-tests` CI check.

**Reporting is not the same as gating.** Every suite above runs on each PR, but a workflow cannot add itself to a branch ruleset — a new check reports without blocking until a repo admin adds it under Settings → Rules (`functions-tests` is currently in that state; `lint` and `rules-tests` went through the same lifecycle and are required today). Check which are actually required before treating a green PR as proof; see `docs/ci-cd.md` §4.2a for the current list.

**A note on what lint turned out not to be able to do.** When these tags were first written, five guardrails were optimistically marked `[lint]`. Wiring ESLint up showed that no rule exists — in `angular-eslint`, `typescript-eslint` or core ESLint — for any of them:

| Guardrail                                       | Why lint can't catch it                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `@for` track must be a stable id, not user text | `use-track-by-function` is about `*ngFor` trackBy functions; nothing inspects an `@for` track expression's semantics |
| Never cache a rejected promise                  | Needs whole-program dataflow, not a syntactic rule                                                                   |
| Every timer/listener has a teardown             | Same — requires reasoning about component lifetime                                                                   |
| Disclosure widgets need `aria-expanded`         | `valid-aria` checks that ARIA attributes present are _correct_; nothing requires one to _exist_                      |
| Grouped controls need `role="radiogroup"`       | `role-has-required-aria` validates a role once declared; nothing requires the role                                   |

All five are now correctly marked `[review-only]`. This is worth remembering as a general point: **"a linter will catch it" is a hypothesis, not a plan.** Check that the rule exists before relying on it, or the guardrail is weaker than it reads.

### 4.1 Trust boundaries and data

- **A value a client can write is not a value you can trust — anywhere it has security or billing consequence.** Firestore is a _public API_: any authenticated user can write straight to it from a console, entirely bypassing the app. If a Cloud Function reads a client-written field and acts on it (a Stripe price, a redirect URL, a mode flag), that field must be validated **both** in `firestore.rules` and again in the function. Rules alone are not enough — rules can't check a value against an external catalog. _(This is how `createCheckoutSession` ended up passing an arbitrary client-chosen `price` and `success_url` straight to Stripe.)_ **[review-only]**
- **Every client-writable collection needs all three of:** an exact-key `hasOnly()` allowlist, a type-and-range check on every field, and an ownership check (`request.auth.uid == ...`). A new client-writable collection or subcollection ships its rules and its rules tests in the same PR as the feature. _(`checkout_sessions` and `portal_sessions` shipped with an ownership check and nothing else, so any field of any size could be written.)_ **[rules tests]**
- **Any public ranking or score a user writes about themselves must be server-attested or hard-bounded.** Shape validation is not anti-cheat: `score >= 0` and `totalQuestions >= score` still permit `999999`. If a number is going to be shown to other users as an achievement, the server has to have a reason to believe it. **[rules tests]**
- **No unbounded collection reads in app code.** Every `getDocs` needs a `where` and a `limit`. Filtering client-side over a whole collection is billed per document, scales linearly with someone else's contributions, and on a public-read collection is trivially scriptable into a bill. **[review-only]**
- **Any client-writable path that triggers a Cloud Function needs a volume cap**, or a user can spend your Functions quota and your Stripe rate limit at will just by writing documents in a loop. **[rules tests]**
- **User-generated content that renders publicly stores its author's uid at write time.** Retrofitting attribution is impossible; without it you cannot ban, bulk-remove, or even answer an abuse report. Note that an exact-key `hasOnly()` allowlist actively _prevents_ adding this later, so it has to be in the schema from the start. **[rules tests]**

### 4.2 Auth, claims, and privilege

- **Set custom claims by key, never wholesale.** `setCustomUserClaims` replaces the _entire_ claims object, so both obvious calls are destructive: `setCustomUserClaims(uid, null)` erases every claim on the user, and `setCustomUserClaims(uid, { yourKey: v })` erases every claim that isn't yours. Read the existing claims, change your key, write the merged object (`functions/src/claims.ts`). This costs nothing while there is only one claim, which is precisely why it survives — it starts deleting data the day someone adds a second. **[functions tests]**
- **Revoking a privilege revokes the session carrying it — which is not the same as closing the window, so don't claim it is.** Unsetting a claim only changes what the _next_ ID token says; the one already in the browser keeps asserting the old role. A downgrade that matters (paid → unpaid, admin → not) therefore calls `revokeRefreshTokens` as well, which stops the user minting a fresh token and forces re-authentication. It does **not** make `firestore.rules` reject the token already issued — rules don't check revocation, so a rules-gated privilege survives until the token's own `exp`, up to an hour. Closing that last gap needs rules to compare `request.auth.token.iat` against something (verified addressable — but A13 in `AUDIT_REMEDIATION.md` is closed by decision: the ≤1h window is accepted while `stripeRole` gates nothing more valuable than adding questions). Revocation is the floor here, and for now it is also the chosen ceiling. **[functions tests]**
- **Client-side entitlement signals are UX, never authority.** `SubscriptionService.isProUser` exists so the UI can react instantly; the thing that actually gates a privileged write is the `stripeRole` custom claim checked in `firestore.rules`. Never add a privileged operation whose only gate is a client signal, and never "optimize away" the rules check because the UI already checked. **[review-only]**
- **…and a client entitlement signal must never be _broader_ than the server's gate.** Being optimistic about _timing_ is the point — the subscription document lands before the next token refresh does. Being optimistic about the _condition_ is a bug: it unlocks UI the server is bound to reject, which the user experiences as a form they can fill in and can never submit. This shipped — the signal accepted any `status: active` subscription while the claim requires the price's `firebaseRole` metadata too, so an active subscription mirrored with `role: null` unlocked add-question forever. Whenever a client mirrors a server predicate, mirror **all** of it, and pin it with a test asserting the _stricter_ half (see `subscription.service.spec.ts`'s `role: null` case). **[review-only]**

### 4.3 External events and payments

- **Webhook handlers verify the signature, assert the mode, and tolerate reordering.** Stripe does not guarantee delivery order and retries on failure, so a handler that blindly `set()`s state can overwrite newer data with older. Keep a high-water mark (event timestamp or id) per synced document, and assert `event.livemode` matches the mode this deployment is configured for, so a test-mode delivery can never mutate production state. **[functions tests]**
- **Derive "which mode is this deployment" from the credential, not from the environment's name.** The first version of the `livemode` check above read it from the project ID — a real project must mean live mode — and that was wrong on this very project, which deliberately runs a test key before launch. It refused every genuine delivery, and the symptom would have been checkout silently never granting Pro. The deployed secret key _defines_ which Stripe the code talks to, so a check derived from it cannot contradict reality, while one derived from the project name is a guess about configuration that configuration is free to disagree with. Applies to any "am I in production" test that gates behaviour on an external system. **[functions tests]**
- **A mock/test-mode flag must be structurally impossible to enable in production.** Gate it on something that cannot be true in a real project (a `demo-` project ID prefix), not on an environment variable alone. An env var can be set anywhere; a project ID cannot. **[functions tests]**

### 4.4 Frontend correctness

- **`@for` track expressions must be a stable unique id, never user-controlled text — and the same value must not double as a truth test.** Two answers with the same string produced duplicate track keys _and_ let a wrong answer score as correct, because the display text was serving as identity and as the correctness check at once. Answers now carry `{ id, text, isCorrect }`: track the id, compare the id, read the flag. Fix data like this at both ends — `firestore.rules` rejects a question repeating an answer, but Open Trivia DB is not ours to constrain and the bank already holds documents written before the rule, so the reader has to be right regardless of the writer. **[review-only]**
- **A native `<select>` bound with `[value]` writes a _string_ into the form control, whatever the control's declared type says.** `[value]` sets the option's DOM value, and `SelectControlValueAccessor` writes that DOM string back — so `<option [value]="5">` on a `FormControl<number>` yields `"5"`, and TypeScript sees a `number` at every point in the chain. Use **`[ngValue]`** for any option value that is not a string; it keeps the real value. This shipped, and it was invisible because a numeric string coerces correctly nearly everywhere — a query string, `Firestore.limit()`, `Math.min`, `Array.slice` all took it — until it reached the one consumer that type-checks, `parseSavedGame`, which rejected the whole saved game and cleared it. Two general points survive the specific bug: **a runtime type that only one consumer checks is a type nobody checks**, and a test that sets the control directly (`setValue(5)`) proves nothing about it, because the accessor is the thing that's wrong. Drive the real element. **[review-only]**
- **Never cache a rejected promise.** A memoized `Promise` that isn't cleared in a `.catch` turns one transient network blip into a permanently degraded session. `SubscriptionService.getProPriceId()` has the correct pattern; copy it. **[review-only]**
- **Every `setTimeout`, `setInterval`, `addEventListener` and `onSnapshot` has a matching teardown**, including inside a `Promise.race` helper that resolves early — racing a listener leaves it attached, receiving and billing for events nobody is waiting on. **[review-only]**
- **A timeout should cancel the work, not just stop waiting for it.** `Promise.race` against a timer abandons the request: it runs to completion, and the caller pays for a result it will never read. Use the mechanism the API provides — `AbortSignal.timeout()` for `fetch`, `HttpsCallableOptions.timeout` for Firebase callables, `unsubscribe()` for `onSnapshot`, RxJS `timeout()` for `HttpClient` (unsubscribing aborts). Check the SDK before assuming there is one: Firestore's `getDocs`/`getDoc`/`setDoc`/`addDoc` and Auth's `signInAnonymously` take no options argument at all, which is why `giveUpAfter()` still exists for those and is named for what it can actually do. **[review-only]**
- **Error messages must not narrate a cause they didn't verify.** Mapping a broad error code (`permission-denied`) onto one friendly story ("your best score is already higher") tells users something false whenever the real cause was different, and here it also blocked retry. Either distinguish the cases or stay generic. **[review-only]**
- **State a user would be annoyed to lose survives a reload.** An in-progress game held only in signals is gone on refresh, tab crash, or PWA relaunch — which is exactly the population offline play is for. **[review-only]**
- **Apply transformations per-source, not globally.** `decodeHtmlEntities` exists because Open Trivia DB returns entity-encoded text; running it over Firestore-authored questions silently rewrites what a user typed. Normalize at the adapter for each source, not in the shared mapper. **[review-only]**
- **No inline `<script>`, `<style>`, `on*=` handler or `style="…"` attribute — in `index.html` _or_ in a component template.** The CSP in `firebase.json` allows none of them. `style="…"` is the easy one to miss: it is governed by `style-src-attr` (falling back to `style-src`), and when it is refused **the attribute stays in the DOM while its declarations are silently dropped** — so the element renders wrong and `getAttribute('style')` still returns what you wrote. That is how the brand mark shipped a `fill:#ffffff` that never applied. Use a presentation attribute (`fill="#fff"`), a class, or an Angular `[style.x]` binding — the last is safe because it goes through CSSOM, which CSP does not govern. The CSP in `firebase.json` allows none, and — this is the part worth remembering — a hash-based allowance would fail _silently_: the browser refuses the script, the app still boots, still styles itself, and nothing goes red in the console, Lighthouse or e2e. Verified by breaking a hash on purpose. And this is what a CSP costs if you assume instead of measuring: the `errors-in-console` audit is worth 1 point of Lighthouse best-practices, so a violation drops it to 0.93 against a 0.95 threshold — the only automated signal there is, and only on the routes Lighthouse actually loads. If something must run before Angular bootstraps, put it in `public/` and reference it with `<script src>` (and give it a `no-cache` header rule, since `public/` filenames carry no content hash). The same applies to build settings that _generate_ inline content: `optimization.styles.inlineCritical` is off precisely because it emits both an inline `<style>` and an inline `onload=` handler. **[review-only]**
- **A timer that enforces a deadline reads the wall clock.** Accumulating `setInterval` ticks drifts, and browsers throttle timers in background tabs — so a countdown built that way pauses when the tab is hidden. **[review-only]**

### 4.5 Accessibility

**A Lighthouse accessibility score of 1.0 is not accessibility coverage.** Its automated audits reach roughly a third of WCAG and cannot detect any of the failures below. Do not treat a green Lighthouse run as evidence that a new interactive component is accessible.

Any new interactive UI is checked by hand against these before the PR:

- **Disclosure/menu widgets**: trigger has `aria-expanded` + `aria-haspopup` + `aria-controls`; panel has a role; Escape closes it; focus moves in on open and returns to the trigger on close. One scoped exception: `aria-haspopup` belongs only on a trigger whose panel is a genuine popup with a matching role (`dialog` like the auth menu, `menu`, `listbox`) — its ARIA values enumerate exactly those. A panel that expands **in place** (game-over's report form, `role="group"`) is the WAI-ARIA _disclosure_ pattern, which takes `aria-expanded` + `aria-controls` and deliberately no `aria-haspopup`; announcing a popup that isn't one misleads the same way omitting one that is would. **[review-only]**
- **A modal dialog traps Tab in both directions, and three plausible ways of writing that trap don't work.** `aria-modal="true"` is a promise to assistive tech only — nothing about it stops Tab walking out into the page behind, which is still rendered and still focusable. Three traps for the trap, all of which shipped and all of which _look_ right: (a) Angular's `keydown.tab` binding **does not fire when Shift is held**, so the direction that escapes backwards past the first control ends up with no handler at all — use a plain `(keydown)` and check `event.key` yourself; (b) filtering the focusable list on `offsetParent !== null`, the usual visibility idiom, returns nothing for a `position: fixed` dialog (that is what `offsetParent` does) and nothing at all in jsdom, which silently empties the list — don't filter for visibility unless the template actually hides rather than removes; (c) restoring focus on close to whatever `document.activeElement` was at open time, which is correct for a panel with several openers but wrong for a dialog with one, because a click does not focus a `<button>` on Safari/macOS — the capture reads `<body>`, which is connected, so the restore "succeeds" into nothing. Capture the trigger element for a single-opener dialog. **[review-only]**
- **Async status** (saved, failed, correct, incorrect) is announced via `role="status"` or `aria-live` — otherwise a screen reader user gets nothing, which matters most when the UI auto-advances on a timer. **[review-only]**
- **Grouped form controls** (segmented pickers, custom radios) carry `role="radiogroup"` and `aria-labelledby`, or the group's label is never conveyed. **[review-only]**
- **Timing limits** are adjustable, extendable, or can be turned off (WCAG 2.2.1). A hard 15-second countdown with no alternative is a real barrier. **[review-only]**
- **Route changes** are announced, and there's a skip link. SPA navigation is otherwise silent to assistive tech. **[review-only]**
- **Inputs collecting data about the user carry the matching `autocomplete` token** (WCAG 1.3.5): `email`, `current-password`/`new-password` switched by sign-in/sign-up mode, `nickname` for display-name fields. Content fields (quiz questions, answers, categories) take none — the tokens describe the user, not the app. Nothing audits a _missing_ token, same as the aria rules in the table above, so the values are pinned in the e2e suite instead. **[review-only]**

### 4.6 Test coverage obligations

These are not suggestions — a PR that changes one of these without its test is incomplete:

- **A `firestore.rules` change ships with rules unit tests in the same PR** (`firestore-tests/`, `npm run rules:test`), covering the reject cases, not just the happy path. The rules are the app's real security boundary; inferring their behavior from a green e2e run is how a hole stays open. **Then break the rule on purpose and confirm a test fails.** Rules tests are unusually easy to write vacuously — an auth context built slightly wrong passes for a reason unrelated to the rule it names, and keeps passing after the rule is deleted.
- **Cover the accept case too — a rule can fail 100% closed and no `assertFails` will notice.** `string(math.floor(x))` in the rules language renders `"5954006.0"`, because `math.floor()` returns a float; the session-document volume cap built on it rejected every legitimate checkout and looked perfectly correct doing so. A suite of nothing but reject cases passes against a rule that denies everything. The rules language resembles JavaScript closely enough to be trusted by reflex and does not behave like it — probe the expression against the emulator before relying on it, the same way `math.round()` was checked for the leaderboard.
- **A Cloud Function that makes a security or billing decision has a direct unit test for that decision.** Keep the decision in a pure function (see `functions/src/role.ts`) so this stays cheap.
- **A new or changed service holding auth, entitlement, or payment logic ships with a spec.** `AuthService` alone has already produced three real bugs found only by e2e; unit-level coverage is much cheaper feedback.
- **A bug fix ships with the test that would have caught it.** Every item in §4 exists because something shipped without one.
