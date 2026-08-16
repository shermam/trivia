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
| 1   | [Coverage & hygiene sweep](#1-coverage--hygiene-sweep)                                          | M    | 🟡     |
| 2   | [Firestore client SDK → REST](#2-firestore-client-sdk--rest)                                    | L    | ⬜     |
| 3   | [Rate limit on `custom_questions`](#3-rate-limit-on-custom_questions)                           | M    | ⬜     |
| 4   | [Review before publish](#4-review-before-publish)                                               | L    | ⬜     |
| 5   | [Report retention vs. account deletion](#5-report-retention-vs-account-deletion)                | S    | ⬜     |
| 6   | [Edit and delete your own submitted questions](#6-edit-and-delete-your-own-submitted-questions) | M    | ⬜     |

### Why this order

The two rules driving it are _don't write code twice_ and _don't rewrite on a suite you don't trust_.

- **1 first** because it is the cheapest and because everything after it is safer on a suite that has been made honest. B11 is the argument: `parseSavedGame` rejected every save made after the player touched the question-count picker, and the whole persistence feature had looked green since it shipped, because both unit suites construct their config in TypeScript where `amount` is a number by construction, and no e2e had ever reloaded mid-game. Neither layer was lying; the seam between them was simply never crossed. Item 1 also lints `functions/`, which items 3 and 4 both add code to.
- **2 second, not last.** It rewrites every Firestore call site. Doing it after items 3 and 4 means their new call sites get written against the SDK and immediately rewritten; doing it before means they are written against REST once. Foundation first, features on top.
- **3 before 4** because it is much smaller, and because it has to choose a write-path mechanism (counter document vs. Cloud Function) that item 4 can then reuse. Choosing that mechanism with item 4 in view is most of the design work — see the note in item 3.
- **4** is the largest, the only one with a schema migration against an exact-key `hasOnly()` allowlist, and the only one that changes what the product promises a paying subscriber.
- **5 and 6 are unordered against the rest** — both came out of publishing the policies rather than from the audit, and neither blocks anything. 5 is a decision that happens to need a small change; 6 is genuinely cheaper _after_ 4, because an edit that can bypass moderation is a hole, so editing has to know whether review exists before it can be designed.

**Items 4, 5 and 6 all change published policy text**, and each one says so in its own section. That is not bookkeeping: the two documents state, in present tense, that submissions are published immediately and cannot be edited or withdrawn. Ship any of those features without touching the text and the app is misdescribing itself to its users — see `CLAUDE.md` §4.0.

---

## 3. The items

### 1. Coverage & hygiene sweep

**Size: S → M. Status: 🟡 in progress** — the lint half is done; the two Cypress items and the icon remain.

Close what B11 exposed, plus the small accumulated items in `docs/known-gaps.md` that have no reason to keep waiting.

- ~~**Lint `cypress/` and `functions/`.**~~ ✅ [#106](https://github.com/shermam/trivia/pull/106) — three config blocks, the Angular set narrowed to `src/`, and a `tsc --noEmit` over `cypress/` added to `lint.yml` after it turned out nothing had ever typechecked that tree. Mutation-verified in all four blocks with a type-aware rule. **Still unlinted and deliberately excluded**: `firestore-tests/` (also untypechecked — Vitest transpiles without checking, exactly the position `cypress/` was in) and `scripts/` (plain `.mjs`, no tsconfig, so it wants a JS-flavoured block rather than a type-aware one). Both are small; they were left out to keep one PR reviewable, not because they are fine.
- **Close the e2e blind spot around persistence.** `game-resume.cy.ts` (added by [#104](https://github.com/shermam/trivia/pull/104)) is the only spec that reloads mid-game. It should not be the only one — reload on `/game-over`, and resume via the setup screen's banner rather than only via the `/play` route, are both untested paths through the same feature.
- **Clear IndexedDB between tests.** `cy.resetBackend()` resets the Firebase emulators and nothing else, and Cypress's test isolation does not clear IndexedDB — so a saved game, the offline question pool and the theme all leak from one test into the next. Nothing has broken because of it yet, which is precisely the state in which to fix it: the failure it produces is order-dependent and would be blamed on anything but the real cause.
- ~~**A `maskable` icon variant.**~~ ✅ Two padded variants at 192 and 512, generated from the same `favicon.svg` by `scripts/make-maskable-icons.mjs`, plus `scripts/verify-icons.mjs` in `lint.yml` because Lighthouse dropped its PWA category and nothing else can check the claim. The measurement that drove it: the glyph reaches 49.9% of canvas width against a 40% budget, ×1.247 over, so a mask would have clipped it. Mutation-verified — an oversized glyph, transparent corners, a manifest declaring no maskable icon at all, and a size mismatch are each rejected with the right message.
- **`apple-touch-icon.png` has the same defect and is deliberately not fixed here.** Its four corners are transparent, and iOS does not honour alpha in a touch icon — it composites onto **black** and then applies its own superellipse mask, so the home-screen result is a black-cornered tile inside a rounded tile. Same root cause, but different geometry (iOS wants full-bleed at _full_ scale, not padded), and it is referenced by a fixed filename served `immutable` for a year, so correcting it needs a rename plus an `index.html` edit rather than an overwrite. Split out rather than crammed in; see `docs/known-gaps.md`.

**Watch out for:** ~~the two lint entries are the risky part~~ — settled, and the warning was right for a reason slightly different from the one written down. `projectService` did resolve all three trees with no `project` array needed, so the feared silent no-op never happened; what it hid instead was **`cypress/tsconfig.json` being inert config**, loaded by nothing, with a live type error in it. The general lesson survives intact: a config that claims to cover a directory has to be shown doing it. Every block was mutation-probed with a _type-aware_ rule specifically, because a syntactic rule passes whether or not the project service resolved anything.

The remaining risk sits with the two Cypress items, and it is a different one: **`npm run e2e` cannot be run from the cloud sandbox** — `download.cypress.io` is a 403 policy denial at the network gateway, so the binary cannot be installed. Everything else in the gate runs there now (`npm test`, `functions:test`, `rules:test` with the JDK 21 that is present, `lighthouse` with `CHROME_PATH` pointed at the Playwright Chromium, `build:prod`, `lint`, `format:check`). Spec changes therefore either go to a machine that can run Cypress, or are driven through CI — and B11 is the standing argument for the former: three CI rounds of inference lost to what one local `console.log` answered.

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
- **A one-off professional review of the published policies.** They are live and in force, and the page's banner says plainly that no lawyer has read them. **The two open legal questions used to render as amber callouts on the live pages; they were moved here instead** ([#37](https://github.com/shermam/trivia/pull/37) review) — an unresolved-item notice is a message to the maintainer, and a reader cannot act on it, so its only effect on the page was to invite them to discount the rest of the document. Neither is unfinished work; both need judgement this repo cannot supply:
  1. **Children under Brazilian law.** The Terms state a minimum age of 13 and the Privacy Policy gives a parent/guardian deletion route, with no age gate. LGPD treats under-12s as a separate category with stricter parental-consent requirements than that threshold, and the EU rules differ again by member state. Whether an actual age gate is needed is the question.
  2. **Liability.** There is deliberately **no** numeric cap and no blanket warranty disclaimer — under Brazilian consumer law a clause excluding the supplier's liability is a nullity, and an unenforceable clause is worse than none because it marks the document as copy-pasted. Whether a cap is worth having, and in what form, is the question. Note that leaving it out is itself a choice, not an omission.

  Everything else that was blocked on a decision has been decided, and everything blocked on a _feature_ was unblocked by the features shipping.

- **Point the Stripe Billing Portal at `/privacy` and `/terms`** — newly possible now that both routes exist rather than falling through the `**` catch-all. Has to be done again on the live-mode configuration at go-live, since portal configurations do not cross Stripe modes.
- **Stripe go-live checklist** — the deployed key is still `sk_test_…`, and portal configurations, webhook endpoints and public business details do not carry over from test mode. `docs/known-gaps.md` §6 has the full list.
