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

| #   | Item                                                                  | Size | Status |
| --- | --------------------------------------------------------------------- | ---- | ------ |
| 1   | [Coverage & hygiene sweep](#1-coverage--hygiene-sweep)                | S    | ⬜     |
| 2   | [Firestore client SDK → REST](#2-firestore-client-sdk--rest)          | L    | ⬜     |
| 3   | [Rate limit on `custom_questions`](#3-rate-limit-on-custom_questions) | M    | ⬜     |
| 4   | [Review before publish](#4-review-before-publish)                     | L    | ⬜     |

### Why this order

The two rules driving it are _don't write code twice_ and _don't rewrite on a suite you don't trust_.

- **1 first** because it is the cheapest and because everything after it is safer on a suite that has been made honest. B11 is the argument: `parseSavedGame` rejected every save made after the player touched the question-count picker, and the whole persistence feature had looked green since it shipped, because both unit suites construct their config in TypeScript where `amount` is a number by construction, and no e2e had ever reloaded mid-game. Neither layer was lying; the seam between them was simply never crossed. Item 1 also lints `functions/`, which items 3 and 4 both add code to.
- **2 second, not last.** It rewrites every Firestore call site. Doing it after items 3 and 4 means their new call sites get written against the SDK and immediately rewritten; doing it before means they are written against REST once. Foundation first, features on top.
- **3 before 4** because it is much smaller, and because it has to choose a write-path mechanism (counter document vs. Cloud Function) that item 4 can then reuse. Choosing that mechanism with item 4 in view is most of the design work — see the note in item 3.
- **4 last**: the largest, the only one with a schema migration against an exact-key `hasOnly()` allowlist, and the only one that changes what the product promises a paying subscriber.

---

## 3. The items

### 1. Coverage & hygiene sweep

**Size: S. Status: ⬜**

Close what B11 exposed, plus the small accumulated items in `docs/known-gaps.md` that have no reason to keep waiting.

- **Lint `cypress/` and `functions/`.** `ng lint`'s `lintFilePatterns` in `angular.json` is `src/**/*.ts` and `src/**/*.html`, so neither directory is linted today — including `functions/`, which is the code that actually ships to the Cloud Functions runtime. Both need their own flat-config entry in `eslint.config.js` with `projectService` wiring against their own `tsconfig`, and `cypress/` additionally needs the Cypress globals. Expect this to find real defects: F2 found 25 the first time ESLint was pointed at `src/`.
- **Close the e2e blind spot around persistence.** `game-resume.cy.ts` (added by [#104](https://github.com/shermam/trivia/pull/104)) is the only spec that reloads mid-game. It should not be the only one — reload on `/game-over`, and resume via the setup screen's banner rather than only via the `/play` route, are both untested paths through the same feature.
- **Clear IndexedDB between tests.** `cy.resetBackend()` resets the Firebase emulators and nothing else, and Cypress's test isolation does not clear IndexedDB — so a saved game, the offline question pool and the theme all leak from one test into the next. Nothing has broken because of it yet, which is precisely the state in which to fix it: the failure it produces is order-dependent and would be blamed on anything but the real cause.
- **A `maskable` icon variant.** Every entry in `public/manifest.webmanifest` is `purpose: "any"`, so Android's adaptive-icon mask crops the Trivimind glyph, which was not drawn with a safe zone. Needs a padded variant, not a manifest edit.

**Watch out for:** the two lint entries are the risky part, not the volume of fixes. Type-aware linting over a second `tsconfig` is where `projectService` misconfiguration silently lints nothing — confirm each entry actually reports by breaking a rule on purpose in each directory, the same discipline the rules tests use. A lint config that covers a directory in name only is worse than not claiming to cover it.

### 2. Firestore client SDK → REST

**Size: L. Status: ⬜**

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

**Size: M. Status: ⬜**

A single Pro subscriber can submit questions in a loop; nothing bounds it. Deferred from A10 by an explicit decision (`AUDIT_REMEDIATION.md` §4) on the grounds that — unlike attribution, which could never be added retroactively once an exact-key `hasOnly()` allowlist existed — a rate limit can be added at any time. That is still true, which is why this is item 3 rather than item 1.

**The design problem is the mechanism, and it is the whole task.** `firestore.rules` cannot count a user's documents, so a cap needs one of:

- **A counter document the client also writes.** Cheap, no server code — but the client can simply decline to update it, so the two writes must be forced into a single batch and the rules must require the counter's presence and increment on every question write. Verifiable in the rules tests.
- **A Cloud Function on the write path.** Authoritative and uncheatable, at the cost of a function invocation per submission and a latency the contributor feels.

**Choose it with item 4 in view.** Review-before-publish also needs something on the write path, and if that turns out to be a Cloud Function, then building a counter-document scheme here means building a mechanism that item 4 replaces within one or two PRs. Sketch item 4's write path far enough to know, before committing to a mechanism here.

**Watch out for:** `CLAUDE.md` §4.6 — the accept case. A cap is exactly the kind of rule that can fail 100% closed and look correct doing so, and there is precedent in this repo: `string(math.floor(x))` rendered `"5954006.0"` and the session-document volume cap built on it rejected every legitimate checkout while a suite of nothing but `assertFails` passed. Probe any arithmetic against the emulator before relying on it.

### 4. Review before publish

**Size: L. Status: ⬜**

Today any fully authenticated Pro subscriber publishes straight into the shared question bank. H4 shipped the reporting half — submissions are attributed (`createdBy`) and any player can flag a question mid-game and file the report at game over — so abuse is actionable end-to-end, report → attributed author → console removal. What is missing is the step before publication.

Reserved rather than deferred: it is a product feature, recorded in `AUDIT_REMEDIATION.md` §4 and `docs/known-gaps.md` §6. It needs:

- a pending/approved status field, **against an exact-key `hasOnly()` allowlist that currently forbids it** — so this is a schema migration over existing documents, not an added field;
- an admin role, and rules that distinguish it from `stripeRole`;
- query and index changes, so that only approved questions are served;
- a decision about the **product promise**: Pro currently means contributions appear instantly, and this removes that. Worth deciding before building, not after.

**Watch out for:** the index changes. D3 is the precedent and it is the most expensive mistake this repo has made — a `firestore.indexes.json` error took the production deploy pipeline down for four merges while Hosting kept shipping happily, and `--dry-run` reported success the whole time. **The emulator cannot verify index configuration.** There is a smoke test now, but the habit is the real defence: after the merge, check that the deploy actually went green.

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

- **Second run of the leaderboard migration** now that [#103](https://github.com/shermam/trivia/pull/103) has deployed — it sweeps up any score written into the old flat collection between the first run and the client switch going live. The script is idempotent and deletes nothing.
- **Rotate the service-account key** used for that migration if it was pasted into a Codespaces secret.
- **Add `functions-tests` to `main`'s branch ruleset** — it reports on every PR but does not block a merge until someone adds it under Settings → Rules.
- **Legal review of [#37](https://github.com/shermam/trivia/pull/37)**, plus the outstanding legal questions and the Firestore region confirmation.
- **Stripe go-live checklist** — the deployed key is still `sk_test_…`, and portal configurations, webhook endpoints and public business details do not carry over from test mode. `docs/known-gaps.md` §6 has the full list.
