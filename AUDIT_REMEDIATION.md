# Audit Remediation Plan

A full audit of this repo (security, correctness, data model, CI/CD, testing, accessibility, product/compliance) produced **55 findings**, and fixing them has since surfaced one more — **56** in the register today. They are being fixed as a series of small, individually-reviewable pull requests.

This file is the **shared source of truth** for that work: what was found, what is done, what is next, and the decisions taken along the way. It is deliberately in the repo rather than in any assistant's private memory, so progress is reviewable and the work can be picked up in a new session — or by a different person — without reconstructing context.

Related documents:

- **`CLAUDE.md` §4** — the invariants these fixes establish, written as a contract so they can't silently regress.
- **`INFRASTRUCTURE.md` §10** — the infra-layer counterpart.
- **`PROJECT_OVERVIEW.md` §6** — Known Gaps, the running record of what is still open in the product itself.

---

## 1. Status at a glance

|                     | Findings |
| ------------------- | -------- |
| ✅ Fixed and merged | 14       |
| 🔵 In review        | 3        |
| ⬜ Not started      | 39       |
| **Total**           | **56**   |

Merged so far: [#43](https://github.com/shermam/trivia/pull/43), [#42](https://github.com/shermam/trivia/pull/42), [#34](https://github.com/shermam/trivia/pull/34), [#35](https://github.com/shermam/trivia/pull/35), [#36](https://github.com/shermam/trivia/pull/36), [#38](https://github.com/shermam/trivia/pull/38), [#39](https://github.com/shermam/trivia/pull/39), [#40](https://github.com/shermam/trivia/pull/40), [#41](https://github.com/shermam/trivia/pull/41), [#44](https://github.com/shermam/trivia/pull/44), [#45](https://github.com/shermam/trivia/pull/45), [#47](https://github.com/shermam/trivia/pull/47).

Open: [#37](https://github.com/shermam/trivia/pull/37) (legal pages — awaiting legal review), [#48](https://github.com/shermam/trivia/pull/48) (A4 + A5, claim scoping and token revocation).

---

## 2. How to resume this work in a new session

Start a new Claude Code session in this repo and paste something like:

> Read `AUDIT_REMEDIATION.md`, then continue the audit remediation from where it left off. Follow the working rules in §3 and pick up the next item in §5.

That is enough. The assistant will read this file, `CLAUDE.md`, and `PROJECT_OVERVIEW.md`, and has everything it needs.

**To work on something specific instead**, name the finding ID:

> Read `AUDIT_REMEDIATION.md`, then fix finding **B3** (cached rejected promise in `TriviaService.getCategories`). One PR, branched fresh off `main`.

**Useful things to say when resuming:**

| You want                    | Say                                                                |
| --------------------------- | ------------------------------------------------------------------ |
| Just keep going             | "Continue from §5, next unstarted item."                           |
| A specific finding          | "Fix finding **A6**."                                              |
| Several small ones together | "Fix **B6** and **B7** in one PR — they're both one-line changes." |
| Re-prioritise               | "Do the accessibility findings (G1–G6) next."                      |
| Check state                 | "What's the current status of the audit remediation?"              |

**Keep this file current.** Every PR in the series should update §1 and §5 as part of the change, the same way `CLAUDE.md` §2 requires `PROJECT_OVERVIEW.md` to be updated. A stale plan is worse than none.

---

## 3. Working rules

Agreed at the start of the series and unchanged since:

1. **One PR per finding**, except where two findings edit the same lines and can't be reviewed apart. Roughly ~25–30 PRs for 56 findings.
1. **Branch fresh off `main`** by default. Stack only when a conflict is genuinely unavoidable, and say so in the PR body.
1. **Integrate `main` by rebasing**, never by merging `main` into the branch. Push with `--force-with-lease`, and re-run the verification gates _after_ rebasing — integrating `main` is exactly where a newly-added gate breaks.
1. **Risk-scoped verification** (`CLAUDE.md` §3a): the full four-command suite for anything touching `src/app/`, `firestore.rules`, `firebase.json`, or `functions/src/`; unit + functions + build only for docs/CI/config-only changes. Always name which commands ran in the PR body.
1. **A `firestore.rules` change ships with rules tests, and the rules get mutation-tested** — break the rule on purpose, confirm a test fails, restore. A rules suite that passes against broken rules is worse than none.
1. **New CI checks get their own workflow**, even though that means a manual step to add them to the ruleset. One workflow per concern; a bundled check produces a muddier signal permanently to save a one-off settings change.

### Verification commands

```bash
npm run format:check   # Prettier
npm run lint           # ESLint + angular-eslint
npm test               # Vitest unit suite
npm run functions:test # Cloud Functions unit tests
npm run rules:test     # firestore.rules suite against the Firestore emulator
npm run e2e            # Cypress against the full Firebase Emulator Suite
npm run lighthouse     # Lighthouse CI
```

Approximate local cost: e2e ~4m, Lighthouse ~2m15s, rules ~6s, everything else seconds. Verification **cannot be parallelised** — the emulator ports are fixed, so two suites on one machine collide.

---

## 4. Decisions taken

Recorded so they aren't silently revisited.

| Decision                                                                      | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1 (leaderboard forgery): bounded rules, not server-attested game tokens.** | Avoids per-game server code. Worth noting the cost concern was probably not binding — a token approach is ~2 Cloud Function invocations per completed game against a 2M/month free tier, i.e. ~1M games/month before any charge. Deferred on complexity grounds; revisit if cheating appears. Dropping the competitive framing was rejected — it's the product's appeal.                                                                                                         |
| **Legal pages ship as drafts**, revisited after the features they depend on.  | Retention and data-subject-rights sections can't make a truthful promise until account deletion (H3) exists; contributed-content removal can't be promised until attribution (A10) exists. A10 has since landed.                                                                                                                                                                                                                                                                 |
| **H3 and A10 pulled forward** from their natural queue positions.             | Both block the legal pages. A10 also had to precede H3 — deleting a user's questions is impossible while nothing records who wrote them.                                                                                                                                                                                                                                                                                                                                         |
| **A10 attribution shipped without a rate limit.**                             | Firestore rules cannot count a user's documents; a cap needs a counter doc the client can decline to update, or a Cloud Function on the write path. Different mechanism. Unlike attribution, a rate limit can be added at any time without a migration.                                                                                                                                                                                                                          |
| **Basecamp's CC BY 4.0 policies as the legal skeleton**, not Automattic's.    | Automattic's are CC BY-**SA**; the share-alike term would oblige these pages to carry the same licence.                                                                                                                                                                                                                                                                                                                                                                          |
| **A2: the client still sends `price`; the function validates it.**            | Not accepting it at all was the stronger fix and was considered. It would have deleted `SubscriptionService.getProPriceId()` — which `CLAUDE.md` §4.4 names as the reference implementation B3's fix is meant to copy — and silently closed C5 (the N+1 price lookup) inside a security PR. Validating against the mirrored catalog is also exactly what §4.1 prescribes. `mode`, `success_url` and `cancel_url` _were_ removed outright, since nothing needed them client-side. |
| **A3: the volume cap lives in the document ID, not a counter document.**      | Rules cannot count a user's documents, and `request.time` is the only server-controlled monotonic value they get for free — so a `{window}-{slot}` ID plus the fact that `create` only applies to a non-existent document _is_ the counter. The alternative rejected for A10's rate limit (a companion counter doc the client can simply decline to update) has the same hole here and needs no migration to add later either.                                                   |

---

## 5. The findings register

Legend: ✅ merged · 🔵 in review · ⬜ not started

### A — Security

| ID      | Finding                                                                                                                                                                                                                                | Status                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **A1**  | Leaderboard scores are trivially forgeable — rules validate shape only, so `score: 999999` is accepted and can never be displaced                                                                                                      | ✅ [#43](https://github.com/shermam/trivia/pull/43) — _bounded; mitigation not closure, see §4_ |
| **A2**  | `createCheckoutSession` trusts client-written `price`, `mode`, `success_url`, `cancel_url`                                                                                                                                             | ✅ [#47](https://github.com/shermam/trivia/pull/47)                                             |
| **A3**  | Unbounded Cloud Function invocation via `checkout_sessions` — no rate limit, no schema validation                                                                                                                                      | ✅ [#47](https://github.com/shermam/trivia/pull/47)                                             |
| **A4**  | `setCustomUserClaims(uid, null)` wipes _all_ custom claims, not just `stripeRole`                                                                                                                                                      | 🔵 [#48](https://github.com/shermam/trivia/pull/48)                                             |
| **A5**  | No token revocation on subscription downgrade — Pro access persists up to ~1hr                                                                                                                                                         | 🔵 [#48](https://github.com/shermam/trivia/pull/48) — _narrowed, not closed; see A13_           |
| **A6**  | Webhook has no event ordering guard, no idempotency record, no `livemode` assertion                                                                                                                                                    | ⬜                                                                                              |
| **A7**  | `STRIPE_MOCK_CHECKOUT` gated on an env var alone, not a `demo-` project ID                                                                                                                                                             | ✅ [#47](https://github.com/shermam/trivia/pull/47)                                             |
| **A8**  | No CSP and no security headers (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`)                                                                                                                                     | ⬜                                                                                              |
| **A9**  | Embed mode allows framing by anyone — no `frame-ancestors` allowlist                                                                                                                                                                   | ⬜                                                                                              |
| **A10** | `custom_questions` had no author attribution, and `hasOnly()` prevented adding it later                                                                                                                                                | ✅ [#41](https://github.com/shermam/trivia/pull/41) — _rate limit deferred, see §4_             |
| **A11** | Service-account secret interpolated directly into shell `run:` blocks                                                                                                                                                                  | ⬜                                                                                              |
| **A12** | `npm audit`: 7 moderate findings in `functions/` are **production runtime**, distinct from the documented devDependency ones                                                                                                           | ⬜                                                                                              |
| **A13** | **`firestore.rules` doesn't check token revocation**, so a lapsed subscriber's already-issued ID token still satisfies `isProUser()` until it expires (≤1hr). A5's `revokeRefreshTokens` forces re-auth but cannot retract that token. | ⬜ _(found during A4/A5)_                                                                       |

### B — Correctness

| ID      | Finding                                                                                                                                             | Status |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **B1**  | Nothing prevents `correct_answer` also appearing in `incorrect_answers`; the quiz matches answers by string, so a wrong duplicate scores as correct | ⬜     |
| **B2**  | `ANSWER_LABELS` has 4 entries but the rules permit 6 answers                                                                                        | ⬜     |
| **B3**  | A failed `getCategories()` is cached forever — one blip degrades the whole session                                                                  | ⬜     |
| **B4**  | Every `permission-denied` is reported as "your best score is already higher", and blocks retry                                                      | ⬜     |
| **B5**  | `playingOffline` is dead code — the player is never told they're on cached questions                                                                | ⬜     |
| **B6**  | `withTimeout` never clears its timer                                                                                                                | ⬜     |
| **B7**  | Quiz progress bar is off by one — 0% on Q1, never reaches 100%                                                                                      | ⬜     |
| **B8**  | In-flight game state is memory-only; a refresh loses it                                                                                             | ⬜     |
| **B9**  | `decodeHtmlEntities` runs over Firestore questions, silently rewriting user text                                                                    | ⬜     |
| **B10** | The 15s countdown uses `setInterval`, which browsers throttle in hidden tabs                                                                        | ⬜     |

### C — Data model, scalability, cost

| ID     | Finding                                                                               | Status |
| ------ | ------------------------------------------------------------------------------------- | ------ |
| **C1** | `getCustomQuestions()` downloads the entire public collection every custom/mixed game | ⬜     |
| **C2** | No TTL on `checkout_sessions` / `portal_sessions`                                     | ⬜     |
| **C3** | Anonymous accounts grow monotonically; every sign-out mints another                   | ⬜     |
| **C4** | IndexedDB keyed on question _text_, so identical text collides across sources         | ⬜     |
| **C5** | `getProPriceId()` is a sequential N+1                                                 | ⬜     |

### D — Reliability & release

| ID     | Finding                                                                                                                                                                                 | Status                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **D1** | Branch protection not enabled                                                                                                                                                           | ✅ [#36](https://github.com/shermam/trivia/pull/36) — enabled; all 7 checks now required |
| **D2** | Deploy order is hosting → rules → functions, putting the new client live before its backend                                                                                             | ⬜                                                                                       |
| **D3** | No post-deploy smoke test or rollback path                                                                                                                                              | ⬜                                                                                       |
| **D4** | Root `postinstall` ran `npm install` in `functions/`; 3 of 5 workflows had incomplete cache keys                                                                                        | ✅ [#39](https://github.com/shermam/trivia/pull/39)                                      |
| **D5** | Committed `functions/.secret.local` placeholder — decision to re-confirm                                                                                                                | ⬜                                                                                       |
| **D6** | **Lighthouse asserts the best of 3 runs, not the median** — `aggregationMethod` defaults to `optimistic`. Observed 0.84/0.66/0.62 against a 0.75 threshold, passing. Docs claim median. | ⬜ _(found during the work)_                                                             |

### E — Testing

| ID     | Finding                                                                                         | Status                                                                            |
| ------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **E1** | `firestore.rules` had no unit tests at all                                                      | ✅ [#40](https://github.com/shermam/trivia/pull/40) — 94 tests, mutation-verified |
| **E2** | No coverage of `AuthService`, `SubscriptionService`, `FirebaseService`, `GameControllerService` | ⬜                                                                                |
| **E3** | `functions/` tests only `deriveClaimRole`; webhook and claim logic uncovered                    | ⬜                                                                                |
| **E4** | `stripeWebhook` never exercised against a real Stripe delivery                                  | ✅ [#36](https://github.com/shermam/trivia/pull/36) — manually verified           |
| **E5** | No coverage reporting or thresholds                                                             | ⬜                                                                                |

### F — Tooling & code quality

| ID     | Finding                                                                     | Status                                                                      |
| ------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **F1** | `strict` and `strictTemplates` were off for the whole frontend              | ✅ [#35](https://github.com/shermam/trivia/pull/35)                         |
| **F2** | No ESLint at all                                                            | ✅ [#38](https://github.com/shermam/trivia/pull/38) — found 25 real defects |
| **F3** | Prettier installed but never enforced; 12 files had drifted                 | ✅ [#38](https://github.com/shermam/trivia/pull/38)                         |
| **F4** | `/play` and `/game-over` redirect from `ngOnInit` instead of route guards   | ⬜                                                                          |
| **F5** | `PROJECT_OVERVIEW.md` is 67KB doing three jobs; split the history into ADRs | ⬜                                                                          |
| **F6** | Committed Angular CLI analytics UUID                                        | ✅ [#38](https://github.com/shermam/trivia/pull/38)                         |

### G — Accessibility

None of these are detectable by tooling. Lighthouse scores 1.0 and ESLint's `templateAccessibility` set reports zero errors, while every item below is still present — confirmed empirically in #38.

| ID     | Finding                                                                                         | Status |
| ------ | ----------------------------------------------------------------------------------------------- | ------ |
| **G1** | Auth menu trigger has no `aria-expanded` / `aria-haspopup` / `aria-controls`; panel has no role | ⬜     |
| **G2** | No Escape-to-close, no focus move-in on open, no focus restore on close                         | ⬜     |
| **G3** | Quiz result banner has no `aria-live`; the 15s limit can't be extended (WCAG 2.2.1)             | ⬜     |
| **G4** | Segmented radio groups lack `role="radiogroup"` / `aria-labelledby`                             | ⬜     |
| **G5** | No skip link, no route-change announcement                                                      | ⬜     |
| **G6** | Auth form `autocomplete` attributes need confirming                                             | ⬜     |

### H — Product & compliance

| ID     | Finding                                                                                                                                                                                        | Status                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **H1** | No password reset — an email/password user who forgets is locked out of a paid subscription                                                                                                    | ⬜                                                                                                     |
| **H2** | No privacy policy or terms                                                                                                                                                                     | 🔵 [#37](https://github.com/shermam/trivia/pull/37) — drafted, 13 review items                         |
| **H3** | No account deletion or data export                                                                                                                                                             | ✅ [#44](https://github.com/shermam/trivia/pull/44) + [#45](https://github.com/shermam/trivia/pull/45) |
| **H4** | No moderation on public user-generated text                                                                                                                                                    | ⬜                                                                                                     |
| **H5** | **Hot-linked Google Fonts sends every visitor's IP to Google pre-consent** — LG München I held this breaches GDPR. Self-hosting also removes two preconnects and a render-blocking stylesheet. | ⬜ _(found during the work)_                                                                           |

---

## 6. Suggested order from here

1. ~~**A2 + A3 + A7**~~ — checkout input validation. [#47](https://github.com/shermam/trivia/pull/47).
2. ~~**A4 + A5**~~ — claim scoping and revocation. [#48](https://github.com/shermam/trivia/pull/48). **A13 came out of it and is unstarted** — decide it before or after A6, but don't lose it.
3. **A6** — webhook ordering, idempotency, `livemode`.
4. **H5** — self-host Inter. Removes a live GDPR exposure _and_ should improve the performance score.
5. **A8 + A9** — CSP and security headers.
6. **D6** — Lighthouse median aggregation, with a threshold re-baseline.
7. Then B (correctness), C (cost), G (accessibility), and the rest.

### What A2 + A3 + A7 actually shipped

Two things were worth more than the plan anticipated, and one was a trap.

**The strongest fix for three of the four A2 fields was to stop accepting them.** `mode` had exactly one possible value; `success_url`/`cancel_url` had exactly one possible shape. Validating them would have been busywork guarding a field nobody needed — removing them means there is no client-chosen value left on that path to get the validation wrong about. Only `price` survives as client input, and only because keeping it avoids reaching into two unrelated findings (§4).

**The A3 cap needed a mechanism, not a threshold.** The obvious reading of "add a rate limit" is a number, but rules have nothing to count with. The document ID turned out to be the whole answer: `create` is the one verb that already refuses to run twice on the same name, so a name derived from server time _is_ a counter, at zero extra reads. The cost is that the client has to derive the same name from its own clock, which is why the window is 5 minutes wide and ±1 window is tolerated — the same skew `isNearRequestTime()` already accepts.

### What A4 + A5 actually shipped, and the finding it produced

**A4 was bigger than the register said.** The finding named `setCustomUserClaims(uid, null)` as the destructive call. It is — but so is the other branch: the API replaces the entire claims object, so `setCustomUserClaims(uid, { stripeRole: 'pro' })` erases every claim that isn't `stripeRole` just as completely. Both paths now go through a read-merge-write. Worth noting _why_ this was invisible: with exactly one claim in the system, both calls are correct by accident. The bug activates the day someone adds a second claim, in a file they didn't touch, on the next webhook delivery.

**A5 is narrowed, not closed, and the invariant that specified it was overconfident.** `CLAUDE.md` §4.2 said revoking a privilege "revokes the token that carries it". `revokeRefreshTokens` does not do that: it invalidates refresh tokens, so the user cannot mint a new ID token and is forced to re-authenticate — but the ID token already in their browser keeps asserting `stripeRole: 'pro'` until it expires, and **`firestore.rules` does not check revocation**. So a lapsed subscriber can still write a custom question for up to an hour. That is a real improvement over doing nothing, and it is not what the invariant claimed. §4.2 has been rewritten to say what revocation does and does not buy, per §4's own rule about not leaving silent exceptions.

The residual is now **A13**. It is closable: `request.auth.token.iat`, `auth_time` and `exp` were all probed against the emulator and are addressable in rules. Two mechanisms, neither free, which is why it is its own decision rather than scope creep here:

- **Compare `iat` against a server-written "entitlement changed at" timestamp.** Exact, but costs a `get()` — one billed read on every privileged write.
- **Require a freshly-issued token for privileged writes** (`iat` within N minutes). Costs nothing, and `AddQuestionComponent` already force-refreshes immediately before its write, so the client satisfies it today. But it couples the rules to that client behaviour, and a failed refresh becomes a rejected write.

**`math.floor()` in the rules language returns a float.** `string(math.floor(x))` renders `"5954006.0"`, so every legitimate checkout was rejected and every hostile one was too — a rule that looks like it works and fails 100% closed. Plain integer division is correct. Caught only because the suite asserts the _accept_ cases as well as the reject ones; a suite of nothing but `assertFails` would have passed against it happily. Worth remembering next to the `math.round()` check A1 did: the rules language is close enough to JavaScript to be trusted by reflex, and isn't.

### What A1 actually shipped, and what changed from the plan

The planned design held on two points and was dropped on a third.

**Held — `totalQuestions` is a range, not the menu options.** A `custom` or `mixed` game legitimately returns fewer questions than requested when the bank is short, so 1–25 is the correct bound; restricting to 5/10/15/20/25 would have rejected real games. `GameSetupComponent`'s `Validators.max` was also tightened 50 → 25 to match, since 50 was never reachable through the UI.

**Held, and simplified — `percentage` uses exact equality.** The plan hedged toward a ±1 tolerance to dodge a possible rounding-mode mismatch. Probing Firestore's `math.round()` against JavaScript's `Math.round()` across `.5` boundaries (1/8, 3/8, 5/8, 7/8, 1/16 …) showed they agree on every case, so the tolerance was unnecessary.

**Dropped — the minimum-elapsed-time rule between improving updates.** The reasoning that justified it doesn't survive scrutiny: an elapsed-time check can only apply to _updates_, since a create has no prior document to compare against — and the maximum achievable score is reachable in a single create. It would have slowed incremental score-climbing, which no attacker needs to do, while risking rejection of a legitimately fast player. Dropped rather than shipped as security theatre.

---

## 7. Outstanding manual steps

Things that cannot be done from CI or by an assistant.

| Item                                                                 | Status                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable branch protection on `main`                                   | ✅ done — all 7 checks required                                                                                                                                                                                                                                                                             |
| Verify `stripeWebhook` against a real Stripe delivery                | ✅ done                                                                                                                                                                                                                                                                                                     |
| Install JDK 21 for `firebase-tools@15` (A12)                         | ✅ installed via Homebrew — **keg-only**, so `java` still resolves to 14. Either `export PATH="/usr/local/opt/openjdk@21/bin:$PATH"` in your shell profile, or `sudo ln -sfn /usr/local/opt/openjdk@21/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk-21.jdk` to make it the system default. |
| **Legal review of [#37](https://github.com/shermam/trivia/pull/37)** | ⬜ 13 items marked `<app-review-required>`. Three are blocked on H3/A10 rather than on a lawyer.                                                                                                                                                                                                            |
| Decide the outstanding legal questions                               | ⬜ contact address, governing law, refund policy, children/COPPA, Firestore region, warranty & liability (left deliberately blank)                                                                                                                                                                          |
| Confirm Firestore database region                                    | ⬜ needed for #37's international-transfers section                                                                                                                                                                                                                                                         |
