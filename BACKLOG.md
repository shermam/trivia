# Backlog

The queue of work after the audit. **`AUDIT_REMEDIATION.md` is finished** — every finding it can close is closed, and the one row still open there ([#37](https://github.com/shermam/trivia/pull/37)) is waiting on a lawyer rather than on an engineer. This file is what replaces it as the "what's next" document.

It is deliberately separate rather than a new section in `AUDIT_REMEDIATION.md`. That file is the record of one specific audit and its 60 findings; folding unrelated work into it would make its title a lie and its counts meaningless. Two documents, two jobs — which is the same reasoning F5 applied to `PROJECT_OVERVIEW.md`.

Related documents:

- **`AUDIT_REMEDIATION.md`** — the closed audit: the findings register, the decisions taken, and a narrative per finding. Several items below were _deferred by a decision recorded there_, so read the linked §4 row before redesigning one from scratch.
- **`CLAUDE.md` §4** — the invariants these fixes established, as a contract. Everything in this queue is bound by them.
- **`docs/known-gaps.md` §6** — the running record of what is open in the product. An item here should have a matching entry there, and closing one should strike it.

---

## 1. Working rules

**`AUDIT_REMEDIATION.md` §3 applies unchanged** — one PR per item, branch fresh off `main`, rebase rather than merge, risk-scoped verification per `CLAUDE.md` §3a with the commands named in the PR body, rules changes ship mutation-tested rules tests, new CI checks get their own workflow.

Two additions specific to this queue:

1. **Order is a judgment call, not a priority ranking.** The sequence below is chosen to minimise rewriting the same call sites twice, and the rationale is written down so it can be argued with. If an item's premise changes, re-order it and say why.
2. **An item that turns out to be bigger than its row says gets split, not crammed.** G7 shipped as two PRs ([#101](https://github.com/shermam/trivia/pull/101), [#103](https://github.com/shermam/trivia/pull/103)) for exactly this reason and was better for it.

---

## 2. The queue

Legend: ✅ done · 🔵 in review · 🟡 in progress · ⬜ not started

| #   | Item                                                                                            | Size | Status |
| --- | ----------------------------------------------------------------------------------------------- | ---- | ------ |
| 1   | [Coverage & hygiene sweep](#1-coverage--hygiene-sweep)                                          | M    | ✅     |
| 2   | [Firestore client SDK → REST](#2-firestore-client-sdk--rest)                                    | L    | ✅     |
| 3   | [Rate limit on `custom_questions`](#3-rate-limit-on-custom_questions)                           | M    | ✅     |
| 4   | [Review before publish](#4-review-before-publish)                                               | L    | ✅     |
| 5   | [Report retention vs. account deletion](#5-report-retention-vs-account-deletion)                | S    | ⬜     |
| 6   | [Edit and delete your own submitted questions](#6-edit-and-delete-your-own-submitted-questions) | M    | ⬜     |
| 7   | [Recover from a wedged service worker](#7-recover-from-a-wedged-service-worker)                 | S    | ⬜     |
| 8   | [In-app role management](#8-in-app-role-management)                                             | M    | ⬜     |

### Why this order

The two rules driving it are _don't write code twice_ and _don't rewrite on a suite you don't trust_.

- **1 first** because it is the cheapest and because everything after it is safer on a suite that has been made honest. B11 is the argument: `parseSavedGame` rejected every save made after the player touched the question-count picker, and the whole persistence feature had looked green since it shipped, because both unit suites construct their config in TypeScript where `amount` is a number by construction, and no e2e had ever reloaded mid-game. Neither layer was lying; the seam between them was simply never crossed. Item 1 also lints `functions/`, which items 3 and 4 both add code to.
- **2 second, not last.** It rewrites every Firestore call site. Doing it after items 3 and 4 means their new call sites get written against the SDK and immediately rewritten; doing it before means they are written against REST once. Foundation first, features on top.
- **3 before 4** because it is much smaller, and because it has to choose a write-path mechanism (counter document vs. Cloud Function) that item 4 can then reuse. Choosing that mechanism with item 4 in view is most of the design work — see the note in item 3.
- **4** is the largest, the only one with a schema migration against an exact-key `hasOnly()` allowlist, and the only one that changes what the product promises a paying subscriber.
- **5 and 6 are unordered against the rest** — both came out of publishing the policies rather than from the audit, and neither blocks anything. 5 is a decision that happens to need a small change; 6 is genuinely cheaper _after_ 4, because an edit that can bypass moderation is a hole, so editing has to know whether review exists before it can be designed.
- **8 is last on purpose, and its absence is a feature.** Granting a role by hand in the console works, is instant, and leaves `user_roles` with no client write path to defend. Building the UI is what turns the privilege register into something a client can write, which is what creates the need for an `admin` role, rules to gate it and tests to prove them. Nothing is waiting on it.
- **7 is unordered and independent of everything above it.** It came out of the Google sign-in investigation ([#115](https://github.com/shermam/trivia/pull/115)) rather than the audit, touches nothing any other item touches, and is the only item here whose triggering failure has never been reproduced — which is why it is queued small rather than queued early.

**Items 5 and 6 change published policy text, and item 4 already did**, and each one says so in its own section. That is not bookkeeping: the two documents state, in present tense, that submissions are published immediately and cannot be edited or withdrawn. Ship any of those features without touching the text and the app is misdescribing itself to its users — see `CLAUDE.md` §4.0.

---

## 3. The items

### 1. Coverage & hygiene sweep

**Size: S → M. Status: ✅ done** — [#106](https://github.com/shermam/trivia/pull/106) (lint), the maskable icon, and [#108](https://github.com/shermam/trivia/pull/108) (the two Cypress items). `apple-touch-icon.png` was split out deliberately and lives in `docs/known-gaps.md`, not here.

Close what B11 exposed, plus the small accumulated items in `docs/known-gaps.md` that have no reason to keep waiting.

- ~~**Lint `cypress/` and `functions/`.**~~ ✅ [#106](https://github.com/shermam/trivia/pull/106) — three config blocks, the Angular set narrowed to `src/`, and a `tsc --noEmit` over `cypress/` added to `lint.yml` after it turned out nothing had ever typechecked that tree. Mutation-verified in all four blocks with a type-aware rule. **Still unlinted and deliberately excluded**: `firestore-tests/` (also untypechecked — Vitest transpiles without checking, exactly the position `cypress/` was in) and `scripts/` (plain `.mjs`, no tsconfig, so it wants a JS-flavoured block rather than a type-aware one). Both are small; they were left out to keep one PR reviewable, not because they are fine.
- ~~**Close the e2e blind spot around persistence.**~~ ✅ [#108](https://github.com/shermam/trivia/pull/108) — `game-resume.cy.ts` goes from one test to six: reload on `/game-over`, the setup banner reached by a fresh page load (the PWA-relaunch path), Discard proved against storage rather than against the banner, and a flag round-tripping through a reload. The resume banner grew `data-cy` hooks so none of it selects on the words "Resume"/"Discard". Each test was mutation-verified individually, and reintroducing B11 itself (`[ngValue]` → `[value]`) now fails five of the six — the coverage that finding went without.
- ~~**Clear IndexedDB between tests.**~~ ✅ [#108](https://github.com/shermam/trivia/pull/108) — `cy.clearOfflineStorage()`, from the `beforeEach` in both support files, before the first `cy.visit()`. **The leak was real and visible**: a test that starts a game leaves its record in `game-state`, and the next test's setup screen renders the resume banner for a game it never started. Pinned by `test-isolation.cy.ts`, whose two tests are deliberately order-dependent — the first leaves a mess so the second has something to be clean of — because a hook that isolates nothing passes every other spec in the suite exactly as it does today.

  **Two of the three plausible placements are wrong, and both were run rather than reasoned about.** `deleteDatabase` blocks while any connection is open, so _when_ it runs is the whole design. `Cypress.on('window:before:load')` fires on **every** page load inside a test, `cy.reload()` included, and resolves in 16–45 ms — so it reliably deletes the saved game _in the middle of_ the specs that exist to prove the game survives a reload. An `afterEach` is worse than it looks: the app's own connection is still open, the deletion `onblocked`s and was still blocked after a full 5 s on every test, then lands whenever the window is torn down — and the next test came out **clean anyway**, which is exactly the trap. Only `beforeEach`-before-visit works, and it needed one thing checked rather than assumed: the pre-visit `about:blank` window serializes its origin as `"null"` but shares storage with the app's, verified by writing a sentinel database from one and reading it back from the other. Had that not held, the hook would have deleted a database nobody uses and looked healthy doing it.

  **One claim in the row above turned out to be false, and is worth correcting rather than quietly dropping.** The offline question pool does _not_ leak: `questions` is written only by `TriviaService.refillOfflinePool()`, reachable only through `initOfflinePrefetch()`, which returns early under `navigator.webdriver` — true for every Cypress run, in both suites. Measured empty after a full game. The hook deletes the whole database anyway, so the day that gate moves it keeps working; but only `game-state` was ever actually leaking. (The theme is `localStorage`, which `testIsolation` already clears.)

- ~~**A `maskable` icon variant.**~~ ✅ Two padded variants at 192 and 512, generated from the same `favicon.svg` by `scripts/make-maskable-icons.mjs`, plus `scripts/verify-icons.mjs` in `lint.yml` because Lighthouse dropped its PWA category and nothing else can check the claim. The measurement that drove it: the glyph reaches 49.9% of canvas width against a 40% budget, ×1.247 over, so a mask would have clipped it. Mutation-verified — an oversized glyph, transparent corners, a manifest declaring no maskable icon at all, and a size mismatch are each rejected with the right message.
- **`apple-touch-icon.png` has the same defect and is deliberately not fixed here.** Its four corners are transparent, and iOS does not honour alpha in a touch icon — it composites onto **black** and then applies its own superellipse mask, so the home-screen result is a black-cornered tile inside a rounded tile. Same root cause, but different geometry (iOS wants full-bleed at _full_ scale, not padded), and it is referenced by a fixed filename served `immutable` for a year, so correcting it needs a rename plus an `index.html` edit rather than an overwrite. Split out rather than crammed in; see `docs/known-gaps.md`.

**Watch out for:** ~~the two lint entries are the risky part~~ — settled, and the warning was right for a reason slightly different from the one written down. `projectService` did resolve all three trees with no `project` array needed, so the feared silent no-op never happened; what it hid instead was **`cypress/tsconfig.json` being inert config**, loaded by nothing, with a live type error in it. The general lesson survives intact: a config that claims to cover a directory has to be shown doing it. Every block was mutation-probed with a _type-aware_ rule specifically, because a syntactic rule passes whether or not the project service resolved anything.

That risk is now settled too. It was a different one from the lint half: **`npm run e2e` cannot be run from the cloud sandbox** — `download.cypress.io` is a 403 policy denial at the network gateway, so the binary cannot be installed. **That also means a bare `npm ci` fails outright there** — the download is a `postinstall`, so it aborts the whole install and leaves `node_modules` half-populated, which then presents as `ng: not found` and a scatter of unrelated failures rather than as a network error. Use `CYPRESS_INSTALL_BINARY=0 npm ci`. Easy to miss, because a sandbox that already has `node_modules` from a previous session never hits it. Everything else in the gate runs there now (`npm test`, `functions:test`, `rules:test` with the JDK 21 that is present, `lighthouse` with `CHROME_PATH` pointed at the Playwright Chromium, `build:prod`, `lint`, `format:check`).

**One qualification learned since, about `lighthouse` specifically: it runs there but does not _measure_ reliably there.** Twelve runs across two branches during [#110](https://github.com/shermam/trivia/pull/110) put `main` at 0.84–0.87 and the branch at 0.75–0.87, which looks like a regression until you check what moved: on the slow runs the **Angular framework chunk, byte-identical between the two branches, took 352 ms to evaluate instead of 173 ms**, and `styleLayout` went from 210 ms to 340 ms alongside it. Nothing in a `FirebaseService` diff can slow Angular's own bootstrap by 80%; the whole profile scales together because the CPU is shared. So a local score below the 0.85 threshold in this sandbox is evidence of nothing on its own — compare an unchanged chunk's evaluation time across the two runs before believing it, and let `lighthouse.yml` on a GitHub runner be the verdict. The signals that _are_ trustworthy locally are the ones that do not depend on wall-clock: byte sizes, CLS (steady at 0.063–0.065 across all twelve runs), and the network request list. Spec changes therefore either go to a machine that can run Cypress, or are driven through CI — and B11 is the standing argument for the former: three CI rounds of inference lost to what one local `console.log` answered.

That is how this item finished: the two Cypress bullets went to a machine with a browser, and it paid for itself immediately. Three candidate placements for the IndexedDB hook were run and observed in about ten minutes; two of them are wrong in ways no amount of reading the Cypress docs would have settled, and one of those two _looks like it works_. The same machine needed a JDK 21 on `PATH` (`/usr/local/opt/openjdk@21` via Homebrew) — `firebase-tools` refuses to start the Firestore emulator on anything older, and the default `java` there is 14.

### 2. Firestore client SDK → REST

**Size: L. Status: ✅ done** — split into three PRs, because the SDK only leaves the bundle on the last one and a single PR rewriting every Firestore call site at once is not reviewable:

| PR                                                        | What                                                                                                                      | Bundle              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| ✅ A — [#109](https://github.com/shermam/trivia/pull/109) | `FirestoreRestClient` + wire codec, behind unit tests. **No call sites change**, so it is fully tree-shaken out.          | unchanged           |
| ✅ B — [#110](https://github.com/shermam/trivia/pull/110) | `FirebaseService`'s six one-shot reads and writes move to REST. The SDK stays in the bundle, held by the listeners alone. | unchanged           |
| 🔵 C — [#111](https://github.com/shermam/trivia/pull/111) | Both `onSnapshot` listeners replaced, `getFirestore()` deleted, the win measured.                                         | **the whole chunk** |

**Result, measured 2026-08-18** — every emitted JS file, both builds on the same machine after `rm -rf dist`, brotli at Node's default quality, reproducible byte for byte. **kB is 1000 bytes**, matching Angular's build report; raw byte counts are given because an earlier draft of these very figures divided by 1024 and labelled the result kB (see `FIRESTORE_SDK_VS_REST.md` §11):

|                    |                   before |                     after |                  change |
| ------------------ | -----------------------: | ------------------------: | ----------------------: |
| JavaScript, raw    | 1,325,892 B (1325.89 kB) | **772,759 B (772.76 kB)** | **−553,133 B (−41.7%)** |
| JavaScript, brotli |    337,591 B (337.59 kB) | **198,016 B (198.02 kB)** | **−139,575 B (−41.3%)** |

`firebase/firestore` is imported nowhere under `src/`, and `onSnapshot` appears in no emitted file. `FIRESTORE_SDK_VS_REST.md` §11 records how the design document's predictions held up — including the two places it was wrong, and the fact that the one bug the migration produced was in neither of the two spots it warned about.

**Baseline re-measured on 2026-08-18** (this item's own instruction, below): `npm run build:prod` reports the Firestore chunk at **558.98 kB raw / 141.26 kB transfer** — identical to the 2026-08-16 figure, so there has been no drift, and `FIRESTORE_SDK_VS_REST.md`'s 545.8 kB / 161.0 kB remains the stale one. Initial bundle for context: 178.19 kB raw / 36.19 kB transfer.

Replace the Firestore client SDK with direct REST calls. **Already costed and decided** — read [`FIRESTORE_SDK_VS_REST.md`](FIRESTORE_SDK_VS_REST.md) in full before starting; it is the design document, and its §9 recommends the migration outright.

The case is §2 of that document and is close to lopsided: the SDK is **545.8 kB raw / 161.0 kB gzipped**, for thirteen API symbols over five collections of flat documents, in an app whose own `main` is 30.3 kB gzipped and whose entire initial bundle is 33.7 kB. It is the largest single thing the app ships. On a low-end phone the parse cost of 546 kB of JavaScript competes directly with becoming interactive.

Two secondary wins come free, and both are things the audit worked around rather than fixed:

- **Cancellation.** `getDocs`/`getDoc`/`setDoc`/`addDoc` take no options argument at all, which is why `giveUpAfter()` exists and is named for the fact that it stops waiting without stopping the work (`CLAUDE.md` §4.4). `fetch` takes an `AbortSignal`. A timeout would cancel the request instead of abandoning it.
- **Quota control.** Direct control over what is requested, rather than through a layer with its own retry and stream behaviour.

**Why it was deferred until now:** a hybrid keeps the SDK in the bundle, so the entire win lands only when the _last_ call site converts. That makes it a poor thing to have half-finished across an audit series that was touching the same files every week. The series is over, so that objection is gone.

**Watch out for:**

- **This is not a call-site-at-a-time refactor you can leave half-done.** Plan it as a sequence that ends with the SDK import removed, and treat "the SDK is still in the bundle" as the definition of not finished. Measure the bundle before and after — the whole justification is a number, so an unmeasured migration has not proven anything.
- **Re-measure before quoting the figure.** `npm run build:prod` on 2026-08-16 reports the Firestore chunk at **558.98 kB raw / 141.26 kB transfer**, against the 545.8 kB / 161.0 kB in `FIRESTORE_SDK_VS_REST.md`. The raw size grew and the compressed size fell, which is what a dependency bump plus a change in Angular's compression estimate looks like — harmless, but it means the document's numbers are a snapshot, not a live figure. The conclusion is unaffected: it is still by a wide margin the largest thing the app ships. Take a fresh baseline as the migration's first step and update that document with it.
- **Auth stays on the SDK.** The Firebase Auth SDK (125.9 kB raw / 35.6 kB gz) is a separate dependency and is not in scope; REST Firestore calls will need the ID token from it.
- **`firestore.rules` still applies** — REST goes through the same rules engine with the same token, so the security boundary does not change. The rules tests stay exactly as valuable, and `npm run rules:test` remains the check that matters.
- **`persistentLocalCache` is declined by decision** (`AUDIT_REMEDIATION.md` §4) and REST does not change that reasoning: Open Trivia DB questions never pass through Firestore, so `OfflineQuestionsService` has to exist regardless, and two offline mechanisms covering two halves of one feature is worse than one.

### 3. Rate limit on `custom_questions`

**Size: M. Status: ✅ done** — [#119](https://github.com/shermam/trivia/pull/119). **20 per hour per account**, enforced in `firestore.rules` against a `custom_question_quota/{window}-{uid}` counter the client must increment in the same batched commit.

**The mechanism question this item posed, answered.** Neither of the two options it listed won outright, and a third — the `{window}-{slot}` document-ID trick already proven twice here — turned out to be unusable on this collection for a non-obvious reason: `getCustomQuestions()` samples the bank by generating a random Firestore auto-ID and reading forward, so question IDs have to stay uniformly distributed across that keyspace. A `{window}-{uid}` ID starts with digits, which sort before every auto-ID, so capped questions would cluster at the start and be nearly unreachable by a forward scan. C1's sampling fix and A3's cap are quietly incompatible.

**Cost was not the discriminator; cost _under abuse_ was.** All three options are free at any volume this app will see. What differs is what an attacker's rejected attempt costs: a rules refusal is not billed at all, so spam costs only the rules read, whereas every rejected call to a Cloud Function is a billed invocation. And Firestore has no synchronous before-write trigger — `onDocumentCreated` fires _after_ commit, so a function could only have deleted over-quota questions once they were already public in a world-readable collection. Rules refuse synchronously, before anything is stored, and add no latency to the submissions that succeed.

**Item 4 does not need a Cloud Function either**, which is what this item asked to check before committing to a mechanism: a status field, an admin claim distinguished from `stripeRole`, and query/index changes are all rules-expressible, with moderation console-only to begin with. So nothing here has to be rebuilt for it.

**The arithmetic was probed against the emulator first**, as this item insisted. `string(millis / 3600000)` renders a plain integer; the `math.floor()` form that produced `"5954006.0"` renders the float. Both directions are pinned, and the accept cases matter most — downgrading `getAfter` to `get` in a mutation run broke every _accept_ test, which is the fails-100%-closed mode this item warned about.

A single Pro subscriber can submit questions in a loop; nothing bounds it. Deferred from A10 by an explicit decision (`AUDIT_REMEDIATION.md` §4) on the grounds that — unlike attribution, which could never be added retroactively once an exact-key `hasOnly()` allowlist existed — a rate limit can be added at any time. That is still true, which is why this is item 3 rather than item 1.

**The design problem is the mechanism, and it is the whole task.** `firestore.rules` cannot count a user's documents, so a cap needs one of:

- **A counter document the client also writes.** Cheap, no server code — but the client can simply decline to update it, so the two writes must be forced into a single batch and the rules must require the counter's presence and increment on every question write. Verifiable in the rules tests.
- **A Cloud Function on the write path.** Authoritative and uncheatable, at the cost of a function invocation per submission and a latency the contributor feels.

**Choose it with item 4 in view.** Review-before-publish also needs something on the write path, and if that turns out to be a Cloud Function, then building a counter-document scheme here means building a mechanism that item 4 replaces within one or two PRs. Sketch item 4's write path far enough to know, before committing to a mechanism here.

**Watch out for:** `CLAUDE.md` §4.6 — the accept case. A cap is exactly the kind of rule that can fail 100% closed and look correct doing so, and there is precedent in this repo: `string(math.floor(x))` rendered `"5954006.0"` and the session-document volume cap built on it rejected every legitimate checkout while a suite of nothing but `assertFails` passed. Probe any arithmetic against the emulator before relying on it.

### 4. Review before publish

**Size: L. Status: ✅ done** — [#120](https://github.com/shermam/trivia/pull/120) (the `user_roles` register), [#121](https://github.com/shermam/trivia/pull/121) (the `status` field and its backfill), [#122](https://github.com/shermam/trivia/pull/122) (the reviewer capability and `/review`), and this PR (review before publish).

| Sub-PR    | What                                                                                                                                                                                                                                                                                                                                       | Status                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **4a**    | The `user_roles` register: rules, lockdown, rules tests, docs. Grants nothing — nothing reads it yet.                                                                                                                                                                                                                                      | ✅ this PR                               |
| **4b-i**  | The `status` field: allowlist widening, the client writing it, the three composite indexes, and the backfill script. Nothing reads the field, so nothing behaves differently.                                                                                                                                                              | ✅ this PR                               |
| **4b-ii** | Reviewer capability: `isReviewer()`, reviewer-only approve/reject, the client read filter, `ReviewerService` and the `/review` queue. Submissions still publish immediately, so the Pending tab is empty — but **rejecting** an approved question now takes it out of games, which is the first in-app moderation action this app has had. | ✅ this PR                               |
| **4c**    | Flip new submissions to pending, **and tighten the `custom_questions` read rule**. Policy text in both documents, `LEGAL_LAST_UPDATED`, the contributor-facing "awaiting review" state, the `docs/known-gaps.md` strike.                                                                                                                   | ✅ this PR — the only one a user notices |

**Why split.** Each part is independently deployable and only the last changes behaviour, so the schema migration and the index changes — the two things most likely to go wrong — land with nothing else moving. 4a ships alone specifically so the register can be exercised in production, by hand, before any privilege depends on it.

**4b turned into two PRs once the migration order was worked out, and the reason is a hard dependency on a human.** `scripts/backfill-question-status.mjs` has to run _between_ the PR that adds the field and the PR that starts filtering on it — a document with no `status` matches no equality filter, so filtering first makes every question predating the change vanish from the game. That is the whole bank, not a subset. Splitting there puts the manual step at a boundary where neither side is broken while it is pending, instead of inside one PR's deploy window.

The backfill has been run against production, which is what unblocked 4b-ii.

**The review queue UI exists as of 4b-ii, which is what makes 4c landable.** Without it the Firestore console would be the queue and every contributor would wait on the owner opening it.

#### Decisions taken (4a)

- **A reviewer role, not an admin role**, and it is a **Firestore document, not a custom claim**. The Firebase console cannot set custom claims at all, and a claim revokes slowly — up to an hour of a token already issued, which A13 accepted for `stripeRole` on the recorded grounds that it gates nothing more valuable than adding a question. Approving other people's questions is more valuable than that, so the acceptance does not transfer. Full reasoning and the emulator probes behind it: `data-model.md` § `user_roles`.
- **There is no `admin` role yet, and that is the design, not a gap.** `user_roles` has no client write path at all, so there is nothing for one to guard — no bootstrapping problem, no self-escalation path. Item 8 is what creates the need for one.
- **Reviewer read access to `question_reports` is deliberately _not_ in 4a.** The Privacy Policy states that reports are "readable by nobody through the app". Opening them to reviewers is a real policy change and belongs with the PR that updates the text, not smuggled in alongside a rules register.
- **`isReviewer()` is deferred to 4b-ii.** A rules helper that no rule calls cannot be mutation-tested, and an untestable security helper is worse than a later one.

#### Decisions taken (4b-ii)

- **The `custom_questions` read rule stays `if true` for one more release.** Tightening it is 4c's job. Rules are not filters, so `resource.data.status == 'approved' || isReviewer()` refuses the unfiltered query a browser cached from before this change still sends; shipping the client filter first means that when the rule does require it, only a client stale by two releases breaks. The residual cost — a rejected question stays readable to a direct query until 4c — is written up in `data-model.md`.
- **A reviewer may change `status` and nothing else**, enforced with `affectedKeys().hasOnly(['status'])`. Editing a submission is item 6's job and belongs to the author, not to a moderator.
- **Deletion stays console-only.** Stopping a question being served and erasing it are different powers.
- **The queue query carries no `orderBy`**, so it needs no composite index; the page is sorted in the browser. The trade is a page boundary that is not strictly by age, against a whole class of D3 deploy risk.

#### Decisions taken (4b-i)

- **Status field, not a separate `custom_questions_pending` collection** — the fork below, now closed. The separate collection avoids the allowlist widening, the backfill and the index changes, but approval would mean writing into `custom_questions` on behalf of another user, which needs either a Cloud Function on the write path or a rules branch letting a reviewer create a document whose `createdBy` is not their own uid. That weakens `isValidCustomQuestion()`'s cleanest invariant. The status field keeps approval as a one-field update authored by the reviewer, with `createdBy` immutable.
- **`status` is mandatory on create, and set by `FirebaseService` rather than by the caller.** Reasoning in `data-model.md` § `custom_questions`.
- **The three composite indexes ship one PR before anything queries them.** The emulator cannot verify index configuration (D3) and index builds are asynchronous, so declaring them early means a mistake surfaces on a deploy where nothing depends on them yet.

#### Was to decide (4b), now closed

**Status field vs. a separate `custom_questions_pending` collection.** The separate collection avoids the allowlist widening, the backfill and the index changes entirely — but approval would then mean writing into `custom_questions` on behalf of another user, which needs either a Cloud Function on the write path or a rules branch letting a reviewer create a document whose `createdBy` is not their own uid. That weakens `isValidCustomQuestion()`'s cleanest invariant. **Decided: the status field**, where approval is a one-field update authored by the reviewer and `createdBy` stays immutable, at the cost of a one-off Admin SDK backfill and three new composite indexes: `getCustomQuestions` runs four filter shapes, and while `status` alone rides the automatic single-field index, `status+category`, `status+difficulty` and `status+category+difficulty` all need declaring.

Today any fully authenticated Pro subscriber publishes straight into the shared question bank. H4 shipped the reporting half — submissions are attributed (`createdBy`) and any player can flag a question mid-game and file the report at game over — so abuse is actionable end-to-end, report → attributed author → console removal. What is missing is the step before publication.

Reserved rather than deferred: it is a product feature, recorded in `AUDIT_REMEDIATION.md` §4 and `docs/known-gaps.md` §6. It needs:

- a pending/approved status field, **against an exact-key `hasOnly()` allowlist that currently forbids it** — so this is a schema migration over existing documents, not an added field;
- an admin role, and rules that distinguish it from `stripeRole`;
- query and index changes, so that only approved questions are served;
- a decision about the **product promise**: Pro currently means contributions appear instantly, and this removes that. Worth deciding before building, not after.

**Watch out for:** the index changes. D3 is the precedent and it is the most expensive mistake this repo has made — a `firestore.indexes.json` error took the production deploy pipeline down for four merges while Hosting kept shipping happily, and `--dry-run` reported success the whole time. **The emulator cannot verify index configuration.** There is a smoke test now, but the habit is the real defence: after the merge, check that the deploy actually went green.

**Policy impact — this PR is not done without it.** Shipping this falsifies a sentence that appears, in near-identical wording, in both published documents:

> Submissions are published immediately, without review.

Update `privacy-policy.component.html` (the "Questions you contribute" section), `terms-of-service.component.html` (the "Questions you contribute" section), and `LEGAL_LAST_UPDATED` in `legal.ts`, in the same PR. See `CLAUDE.md` §4.0 for why this is not optional.

---

### 5. Report retention vs. account deletion

**Size: S. Status: ⬜**

`question_reports` stores the reporter's uid in the `reportedBy` field **and** repeats it inside the document ID (`firestore.rules`). `deleteAccount` never touches the collection — `question_reports` appears nowhere in `functions/src/`. So deleting your account leaves your identifier behind in every report you ever filed, in two places.

Found while writing the Privacy Policy from source (H2, [#37](https://github.com/shermam/trivia/pull/37)), which is the only exercise that asks "what is actually left after deletion?" of every collection in turn.

It is not obviously a bug — an abuse signal that evaporates the moment its author deletes their account is worth much less, and a bad actor could file harassing reports and then erase the trail by deleting an account they can recreate in one click. But **nobody chose it**, and the account-deletion path is otherwise careful and deliberate about exactly this question.

**Decided, on review of [#37](https://github.com/shermam/trivia/pull/37): anonymise, on two conditions.** Lean towards what regulation prefers — erasure — while keeping the signal for as long as it is actually useful. A report's reporter identifier is anonymised when **both** of these are true:

1. the reporter has deleted their account, **and**
2. the report has been reviewed.

Condition 2 is what makes this better than anonymising on deletion alone: an unreviewed report still needs its author, because triaging it may mean looking at what else that account filed. Once it has been reviewed, the identifier has done its job and keeping it is retention without a purpose — which is the thing LGPD art 18(IV) and GDPR's storage-limitation principle both push against.

**None of this exists yet**, and the Privacy Policy deliberately describes today's behaviour instead: reports are kept indefinitely, including the reporter's identifier, with the accountability reason given. Update that section in the same PR that ships the change.

Two things this needs that do not exist today:

- **A notion of "reviewed".** `question_reports` has no status field, and review is console-only. This is really the first piece of moderation tooling, so it may want to land with — or after — item 4.
- **A way to run the anonymisation.** Both conditions can become true in either order (a report is reviewed after its author left; an author leaves after their report was reviewed), so `deleteAccount` alone is not enough. It needs either a check at both points or a sweep.

**Watch out for:** the uid is in the document **ID** as well as the `reportedBy` field — the ID is `{window}-{slot}-{uid}` and the rules use it to cap how many reports one user can file. Anonymising the field but not the ID would be a fix that looks complete and is not. Changing the ID scheme means changing that cap, which is a rules change, which means rules tests **and** a mutation pass — per `CLAUDE.md` §4.6, the accept case as much as the reject cases. Also update `docs/data-model.md` and consider adding `question_reports` to the data export, which today omits it.

---

### 6. Edit and delete your own submitted questions

**Size: M. Status: ⬜**

`/add-question` only creates. `firestore.rules` says `allow update, delete: if false` on `custom_questions`, so there is no in-app way to fix a typo in a question you wrote, and no way to withdraw one — the only route is emailing for a manual console removal. Recorded in `docs/known-gaps.md` since long before the policies were published; queued now because publishing them made the gap a _stated_ one.

Both halves are one item because they share every hard part: the rules change, the ownership check, and the same two sentences of published policy.

- **Rules.** `update` and `delete` both flip from `if false` to an ownership check — and ownership is `createdBy == request.auth.uid`, which is **absent on documents predating A10** and is the `[deleted-user]` sentinel on documents whose author has left. Neither can be edited by anyone, and the rules have to say so rather than crash into it. An `update` also has to re-run the full `isValidCustomQuestion()` validator and must not permit rewriting `createdBy` or `createdAt`.
- **Interaction with item 4.** If review-before-publish lands first, an edit has to decide whether it re-enters review. Almost certainly yes, or editing becomes the way to bypass moderation — which makes this cheaper to build _after_ item 4 than before it.
- **Interaction with the licence.** The Terms grant an **irrevocable** licence that survives account deletion, which is what lets a departed contributor's questions stay in the bank. A per-question delete is a permission granted to the user on top of that, not a limitation of it — but the Terms currently say withdrawal is impossible, so they have to be rewritten carefully enough that the two do not appear to contradict each other.

**Policy impact — this PR is not done without it.** Shipping either half falsifies this sentence, which appears in both published documents:

> There is currently no way to edit or withdraw a question from within the app; to have one removed, write to the address above.

A **delete** additionally touches the Privacy Policy's retention list, which currently states that contributed questions stay in the bank indefinitely, and the Terms' account-deletion section. Update those, plus `LEGAL_LAST_UPDATED`, in the same PR.

**Watch out for:** `CLAUDE.md` §4.6 — a rules change ships with rules tests covering the reject cases, then gets mutation-tested. The reject cases here are the interesting ones: editing someone else's question, editing an unattributed legacy document, editing a `[deleted-user]` document, and rewriting `createdBy` to steal or disown authorship.

---

### 7. Recover from a wedged service worker

**Size: S. Status: ⬜**

`grep -rn "SwUpdate\|unrecoverable\|versionUpdates" src/` returns nothing. The app registers `ngsw-worker.js` (`app.config.ts`) and then never speaks to it again: no `unrecoverable` listener, no `versionUpdates` subscription. Angular's service worker **does** emit `unrecoverable` when its cached version fails an integrity check and it cannot repair itself, and today nothing is listening — so the app cannot recover, and cannot tell the user anything either. The only escape is a hard reload, which is not a thing a non-technical user knows to try.

Came out of the Google sign-in investigation, as step 4 of the brief that produced [#114](https://github.com/shermam/trivia/pull/114) and [#115](https://github.com/shermam/trivia/pull/115).

**The failure was never reproduced, and that is the honest status of this item.** `/ngsw/state` on production was checked repeatedly across that investigation and reported `Driver state: NORMAL ((nominal))` every time, with a single version and an empty debug log. This is a latent robustness gap, not a known-live bug — which is why it is an S and sits at the bottom.

**It does not supersede [#115](https://github.com/shermam/trivia/pull/115), and the distinction is the interesting part.** That PR fixed a _different_ kind of service-worker staleness: the worker's **policy container**, which holds the CSP delivered with its script and is fixed at install time. `unrecoverable` says nothing about that — a worker serving a year-old CSP is working perfectly by its own lights. Cache corruption and policy staleness are two separate failure modes of the same component, and the fingerprint in `scripts/stamp-service-worker.mjs` covers only the second.

What it needs: inject `SwUpdate`, subscribe to `unrecoverable`, surface a plain message and offer `location.reload()`. `versionUpdates` is worth considering in the same pass — the app currently has no "a new version is available" affordance either — but that is UX with a design question attached, and `unrecoverable` is the part that is purely a hole.

**Watch out for:**

- **`SwUpdate.isEnabled` is `false` in dev and under Cypress.** `app.config.ts` gates registration on `!isDevMode() && !navigator.webdriver`, so anything written here must tolerate a disabled `SwUpdate` rather than assume its observables ever emit. That is also why the one existing spec that needs a real worker (`service-worker-oauth-origins.cy.ts`) registers it by hand and runs preview-only — see `ci-cd.md` §4.3, including what leaving it registered costs other specs.
- **A prompt that appears on a wedged app has to work on a wedged app.** Whatever renders the message must not depend on a lazy route chunk the broken cache is what failed to serve.
- The matching entry in `docs/known-gaps.md` §6 gets struck when this ships, per the note at the top of this file.

---

### 8. In-app role management

**Size: M. Status: ⬜ — lower priority than 5, 6 and 7.**

`user_roles` (item 4a, `data-model.md`) is granted entirely by hand in the Firebase console: Authentication → Users for the uid, Firestore → `user_roles/{uid}` → `reviewer: true`. That is a deliberate starting point, not an oversight — it works, it is instant, and it has **no client write path at all**, so the register has no attack surface to defend.

This item is the point at which that changes, and the cost of changing it is the reason it is queued low.

- **It is what creates the need for an `admin` role.** Today there is nothing for one to guard. An in-app grant form is a client write path into the privilege register, so it needs a role that may use it, rules that gate it, and rules tests covering the reject cases — a reviewer must not be able to recruit, and nobody must be able to promote themselves. `firestore-tests/user-roles.rules.spec.ts` already pins both of those against the current `if false`, and those rows are exactly the ones that have to be rewritten rather than deleted.
- **Bootstrapping is already solved and should stay that way.** The first admin is seeded from the console, the same way reviewers are now. Do not build a "first user becomes admin" path; it is a privilege-escalation bug with a friendly name.
- **It needs a way to find a user.** The console flow works because Authentication lists every account with its uid. In-app, an admin knows an email address, and the client cannot look up a uid from one — Auth's admin queries are Admin SDK only. So this almost certainly needs a Cloud Function, which is the bulk of the work and the rest of the reason it is an M.
- **Provenance becomes worth having** once grants are not hand-typed: `grantedBy`, `grantedAt`. The collection has no exact-key `hasOnly()` allowlist precisely so those can be added later without a migration — but note that adding a client write path is what makes an allowlist necessary in the first place, so this item both adds the fields and adds the constraint that would have blocked them.

**Watch out for:** the read rule. `allow list: if false` is what keeps the set of moderators unenumerable, and a management screen wants exactly that list. Widening it for an admin is legitimate; widening it by reflex to `allow read` is not — see the mutation note in `data-model.md`, where that specific mistake survives every test in the file but one.

---

## 4. Items considered and not queued

Recorded so they are not silently re-proposed.

| Item                                                  | Where it stands                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server-attested leaderboard scores** (A1)           | Bounded in rules instead, by decision. The cost objection was probably not binding — ~2 function invocations per completed game against a 2M/month free tier — so this was deferred on complexity, not price. **Revisit if cheating actually appears.**                      |
| **Closing the ≤1h token window** (A13)                | Closed by decision, owner-confirmed. Revisit only if `stripeRole` ever gates something more valuable than adding questions to a shared bank.                                                                                                                                 |
| **`persistentLocalCache`**                            | Declined; see item 2. Not reopened by the REST migration.                                                                                                                                                                                                                    |
| **Third-party embedding / `?embed=1`**                | Parked, and it is a real piece of work rather than a header tweak — the thing being framed today is the whole app, session and account menu included. `docs/known-gaps.md` §6 lists the two prerequisites (a path-based embed route, and a stripped anonymous-play surface). |
| **Background Sync for the offline pool**              | Not queued. The pool refills on idle callback and `online` while a tab is open; a PWA installed and never opened has a stale pool. Small user impact, real API complexity.                                                                                                   |
| **Email-alias blocking as a `beforeCreate` function** | Not queued. The infrastructure blocker is gone (`functions/` exists), but the rules-enforced "not anonymous, verified if password" check is the actual anti-flood defence and does not depend on it.                                                                         |

---

## 5. Blocked on a human

These are not engineering work; they are in `AUDIT_REMEDIATION.md` §7 with full instructions. Repeated here because they are the things a session cannot do for itself:

- **Run `scripts/backfill-question-status.mjs`** against `intellectura-3b26a`, now that item 4b-i has deployed. It stamps `status: 'approved'` onto every `custom_questions` document written before the field existed. **Item 4b-ii cannot start until this has run** — a document with no `status` matches no equality filter on it, so shipping the read filter first removes every pre-existing question from the game. Dry-run it first; it is idempotent, leaves documents that already carry a status alone, and touches no question content.

  ```bash
  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
    node scripts/backfill-question-status.mjs --project intellectura-3b26a --dry-run
  ```

- **Second run of the leaderboard migration** now that [#103](https://github.com/shermam/trivia/pull/103) has deployed — it sweeps up any score written into the old flat collection between the first run and the client switch going live. The script is idempotent and deletes nothing.
- **Rotate the service-account key** used for that migration if it was pasted into a Codespaces secret.
- **Add `functions-tests` to `main`'s branch ruleset** — it reports on every PR but does not block a merge until someone adds it under Settings → Rules.
- **A one-off professional review of the published policies.** They are live and in force, and the page's banner says plainly that no lawyer has read them. **The two open legal questions used to render as amber callouts on the live pages; they were moved here instead** ([#37](https://github.com/shermam/trivia/pull/37) review) — an unresolved-item notice is a message to the maintainer, and a reader cannot act on it, so its only effect on the page was to invite them to discount the rest of the document. Neither is unfinished work; both need judgement this repo cannot supply:
  1. **Children under Brazilian law.** The Terms state a minimum age of 13 and the Privacy Policy gives a parent/guardian deletion route, with no age gate. LGPD treats under-12s as a separate category with stricter parental-consent requirements than that threshold, and the EU rules differ again by member state. Whether an actual age gate is needed is the question.
  2. **Liability.** There is deliberately **no** numeric cap and no blanket warranty disclaimer — under Brazilian consumer law a clause excluding the supplier's liability is a nullity, and an unenforceable clause is worse than none because it marks the document as copy-pasted. Whether a cap is worth having, and in what form, is the question. Note that leaving it out is itself a choice, not an omission.

  Everything else that was blocked on a decision has been decided, and everything blocked on a _feature_ was unblocked by the features shipping.

- **Point the Stripe Billing Portal at `/privacy` and `/terms`** — newly possible now that both routes exist rather than falling through the `**` catch-all. Has to be done again on the live-mode configuration at go-live, since portal configurations do not cross Stripe modes.
- **Stripe go-live checklist** — the deployed key is still `sk_test_…`, and portal configurations, webhook endpoints and public business details do not carry over from test mode. `docs/known-gaps.md` §6 has the full list.
