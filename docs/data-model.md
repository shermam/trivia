# Data Model (Firestore)

Every collection, its exact schema, the `firestore.rules` that guard it, and the reasoning behind each rule.

**Read this when** you are adding a collection or field, changing `firestore.rules`, or writing a query.

Part of the project overview — start at [`PROJECT_OVERVIEW.md`](../PROJECT_OVERVIEW.md) for the map and the conventions. Sibling documents: [Application Functionality](app.md) · [Frameworks, Tools & Libraries](stack.md) · [Deployment & CI/CD](ci-cd.md) · [Project History & Known Gaps](known-gaps.md).

---

## 3. Data Model (Firestore)

### `user_roles` — moderation roles, granted by hand

```
user_roles/{uid}
  reviewer: boolean
```

One document per account, named by uid, holding role flags. **`isReviewer()` in `firestore.rules` reads it** — it is what gates the `/review` queue, the reviewer's `status` write on `custom_questions`, the read of a question that is not yet approved, and the read of `question_reports`. It shipped one release ahead of those rules on purpose, so the register, its lockdown and its tests were deployed and provable before any privilege depended on them, and so a reviewer could be appointed before there was anything to appoint them for.

- **Read**: `get` on your own document only (`request.auth != null && request.auth.uid == uid`). Any uid, anonymous included — see below.
- **List**: never, by anyone.
- **Create / Update / Delete**: never, by any client. Assignment is console-only; the console and the Admin SDK bypass rules entirely.

**A document rather than a custom claim**, decided on two grounds that point the same way.

The first is practical: **the Firebase console cannot set custom claims.** There is no claims editor on the Authentication page and no `gcloud` equivalent, so a claim-based role means writing and running an Admin SDK script for every promotion. The whole requirement here was that the owner can appoint a reviewer by hand, from the console, today.

The second is the one that would matter even if the console could: **a claim revokes slowly.** Unsetting one only changes what the _next_ ID token says, so a removed reviewer keeps the privilege until the token already in their browser expires — up to an hour, and `revokeRefreshTokens` does not close it because rules do not check revocation (`CLAUDE.md` §4.2). That window was accepted for `stripeRole` (A13) on the explicit and recorded grounds that it gates nothing more valuable than adding a question to a shared bank. Approving _other people's_ questions into that bank is more valuable than that, so the acceptance does not transfer. A rule that reads a document is evaluated at request time: delete the document and the very next request is refused, with no token refresh and no sign-out.

**Cost: one billed read, and only on operations a reviewer actually performs.** `||` short-circuits, so a rule shaped `<public condition> || isReviewer()` never evaluates the lookup for callers who satisfy the public condition. That, and the three other rules-language behaviours this design rests on, were probed against the emulator before the design was chosen rather than assumed — the `math.floor()` habit (§ "Rules test suite"):

| Probed                                                                        | Result                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get()` on a **missing** document, unguarded (`get(p).data.reviewer == true`) | Denies. No `exists()` guard needed; bare, exists-guarded and `.data.get('reviewer', false)` forms all behaved identically on every case.                                                     |
| A document that exists with `reviewer: false`, and one missing the field      | Both deny — it is not an existence or truthiness check.                                                                                                                                      |
| `\|\|` short-circuit                                                          | A caller with no role document read a public document successfully, which is only possible if the lookup was never evaluated. This is the cost proof.                                        |
| `get()` inside a `list` rule                                                  | Works. A privileged caller's unfiltered query and their filtered query both succeeded where an unprivileged caller's failed — so a review queue is a plain query, not a separate collection. |

**One document with flags, not a `reviewers/{uid}` collection.** A single read serves any number of role checks, and an `admin` flag is already foreseen; two collections would be two reads.

**No exact-key `hasOnly()` allowlist, and there must not be one.** Nothing here is client-writable, so there is nothing to constrain — and consequently none of the A10 one-way door. Fields can be added later at no cost, which is the exact inverse of `custom_questions`. `grantedAt` or a free-text `note` can be added by hand for provenance; treat them as documentation, not as an audit trail. Console edits leave no automatic record unless Cloud Audit Logs **Data Access** logging is enabled for Firestore, which is off by default and billed.

**There is no `admin` role, deliberately.** With `allow create, update, delete: if false` there is no client write path to the register at all, so there is nothing for an admin role to guard, no bootstrapping problem to solve, and no self-escalation path to close. In-app role management is what creates the need for one, and it is queued as such in `BACKLOG.md` — the first admin will be seeded from the console at that point, exactly as reviewers are now.

**Why the read is `request.auth != null` and not `isRealAuthedUser()`.** An anonymous session is handed a uid it does not choose, so it can never name a document a role was granted on, and the read returns nothing. Narrowing it would add a condition that has to stay in step with nothing. Pinned by a test so that tightening it later is a decision rather than a reflex.

**Why the read is `get` and `list` spelled separately.** `allow read` grants both, and who moderates is not public — a list of moderators is a list of accounts worth attacking. This distinction is unusually easy to test _vacuously_, and the mutation run proved it: with `allow read: if request.auth.uid == uid` and no `allow list`, the **unfiltered** list is still denied, because Firestore cannot prove the wildcard matches every document the query would return. Every test but one keeps passing. The shape that catches it is a query constrained to `documentId() == <own uid>`, which Firestore _can_ prove and therefore serves — `firestore-tests/user-roles.rules.spec.ts` carries that row with a comment saying not to delete it.

**Granting a role, by hand:** Authentication → Users → copy the **User UID**; Firestore Database → collection `user_roles` → document ID = that uid → field `reviewer`, type boolean, value `true`. Revoke by deleting the document. Effective on the next request.

### `users` — lifetime gameplay totals, one document per player

`users/{uid}` holds a player's running totals: `gamesPlayed`, `questionsAnswered`, `correctAnswers`, `bestStreak` (the longest run of consecutive correct answers **within one game**), plus `lastGameId`, `statsSince`, `updatedAt` and a `rateWindowStart`/`gamesInWindow` pair. Created lazily by the `recordGameResult` callable the first time a signed-in account finishes a game, and deleted by `deleteAccount`. The app reads it in exactly one place — `/profile` (`app.md` §1.10), one `get` per visit at the owner's own path, which is the only shape the rule below permits.

**Nothing here is client-writable, and that is the design rather than an omission.** `CLAUDE.md` §4.1 requires every client-writable collection to carry an exact-key `hasOnly()` allowlist; §4.2 records the corollary, that a document has no allowlist to widen later _only while it stays free of any client write path_. Five roadmap specs name this document (`FEAT-005`, `-014`, `-028`, `-038`, `-041`) and their proposed field sets are neither settled nor consistent with each other, so freezing a key set now would put the A10 one-way door on the collection least able to afford it. Keeping every write on the Admin SDK costs one callable invocation per completed game and buys a schema that can grow — the exact inverse of `custom_questions`, and the same bargain `user_roles` above already makes.

**How it grows.** Add a server-written field and nothing else changes: no rules deploy, no migration, no stale-client window, and no existing document rejected — because there is no allowlist to widen and every field is optional-if-absent by construction. `users.rules.spec.ts`'s `schema — deliberately unconstrained` case is what keeps that property enforced rather than merely asserted. Two things that would end it: giving the collection a client write rule, or putting a field here that a `firestore.rules` expression reads (which would make it an entitlement carrier — see §4.2 on claims versus documents, and note that a role belongs in `user_roles`, not here).

**The totals are bounded, not attested.** §4.1 wants an achievement number server-attested or hard-bounded; the callable's payload is still client-supplied, so these are the second kind — 1..25 questions per game, `correct <= answered`, `streak <= correct`, one write per game id, 60 games per rolling hour. That is audit decision **A1** adopted deliberately rather than inherited by accident, and it is why nothing here is shown to anyone but its owner. Reopening it means building the signed game token A1 deferred, not loosening anything in the rules.

**`lastGameId` is the idempotency key and it is not optional.** `/game-over` is deliberately restorable — the completed game stays in the persisted snapshot so a refresh does not lose the score about to be submitted — so `ngOnInit` runs again on every reload, and a callable that times out gets retried. `saveHighScore` tolerates that because a best-score `setDoc` is idempotent; an increment is not. The id is minted in `GameControllerService.startGame()` and carried in `PersistedGame`; a game restored from a save written before that field existed has `null` and is simply never banked, because minting one on the results screen would produce a fresh id per reload and inflate the totals on each one.

**`rateWindowStart`/`gamesInWindow` is not §4.1's volume cap**, and the distinction is worth keeping straight. §4.1's cap exists because a client-writable path that triggers a Cloud Function lets a user spend the Functions quota in a loop; here the trigger is a callable invoked directly, so the invocation is billed before this counter is read. What the counter bounds is **stat inflation** from a loop of fresh game ids. Quota on this path is genuinely unprotected — closing it wants App Check or a `maxInstances` ceiling.

**Nothing is created for anonymous sessions**, enforced in the callable because there is no client write rule for the gate to live in. `deleteAccount` never runs for an anonymous account and Firebase's auto-deletion removes only the Auth record, so a document per guest would accumulate with nothing able to delete it — and the Privacy Policy's claim that nothing is kept for anonymous play would stop being true on the first page load after deploy. `FEAT-014` (daily limits for guests) is stranded by this and knows it: the exclusion was taken deliberately on 27 August 2026, on the grounds that ~99% of accounts are anonymous and a guest can mint a fresh uid by signing out anyway, so a per-uid document buys that feature less than it appears to.

| Field               | Type             | Notes                                                                                                                                                      |
| ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gamesPlayed`       | `int >= 0`       | Completed games.                                                                                                                                           |
| `questionsAnswered` | `int >= 0`       | Lifetime denominator for an accuracy rate.                                                                                                                 |
| `correctAnswers`    | `int >= 0`       | Numerator. Bounded `<= questionsAnswered` on every write.                                                                                                  |
| `bestStreak`        | `int 0..25`      | Longest run **within one game**, kept as `max(stored, thisGame)`. Not a consecutive-days streak — that is a different fact needing its own pair of fields. |
| `lastGameId`        | `string`, ≤128   | Idempotency key.                                                                                                                                           |
| `statsSince`        | `int` (epoch ms) | Written once on create, never again — including when the clock has gone backwards. What makes "lifetime" honest for accounts that predate the feature.     |
| `updatedAt`         | `int` (epoch ms) | Server clock, never client-supplied.                                                                                                                       |
| `rateWindowStart`   | `int` (epoch ms) | Start of the current hour-long window.                                                                                                                     |
| `gamesInWindow`     | `int >= 0`       | Games banked in it; ceiling 60.                                                                                                                            |

Deliberately absent, each for a reason: `totalScore` (identical to `correctAnswers` under today's scoring, so it would be one value in two differently-labelled places); timing fields (`answerHistory` carries no timing, and an `unlimited` game left open overnight is unbounded); `tier`/`isPro` (entitlement is the `stripeRole` claim with a mirror at `customers/{uid}` — see §4.2); `reviewer`/`admin` (stays in `user_roles`).

### `custom_questions` — first-party question bank

```
category: string
type: 'multiple' | 'boolean'
difficulty: 'easy' | 'medium' | 'hard'
question: string
correct_answer: string
incorrect_answers: string[]   (1–3, all distinct, none equal to correct_answer)
createdBy: string      (Firebase uid of the submitter)
createdAt: int         (epoch ms, must be near server time)
status: string         ('approved' | 'pending' | 'rejected'; create accepts only 'pending')
sourceUrl?: string     (optional; https:// only, 9–500 chars)
sourceTitle?: string   (optional; 1–200 chars)
explanation?: string   (optional; 1–1000 chars — the form's "Justification")
```

- **Read**: an **approved** question is public; anything else is reviewers only (`resource.data.status == 'approved' || isReviewer()`). Because **rules are not filters**, this does not quietly hide unapproved questions from an unfiltered query — it refuses the query outright, so every client read must carry `where('status','==','approved')`. `getCustomQuestions` has sent that since 4b-ii, one release before this rule started requiring it; that ordering means a browser cached from before 4b-ii is the only one refused, and `TriviaService` falls back to the offline pool when the fetch throws, so even that degrades to cached questions rather than to nothing. `||` in this order matters: the language short-circuits, so a player reading an approved question never triggers the `user_roles` lookup.
- **Create**: requires a "real" account — same `isRealAuthedUser()` gate as the leaderboard (non-anonymous, and email-verified if it's a password account) — **plus an active Pro subscription** (`isProUser()`: `request.auth.token.stripeRole == 'pro'`, `app.md` §1.6) — plus schema validation (`isValidCustomQuestion()`: exact key set including a mandatory `status` of `'pending'` — **a submitter cannot approve their own question**, `type` in `['multiple','boolean']`, `difficulty` in `['easy','medium','hard']`, string length bounds, `incorrect_answers` a list of 1–3 entries with **no duplicates and none equal to `correct_answer`** — a question with two identical options has no single right answer, whatever the reader makes of it). Written from the client via the `/add-question` screen (`app.md` §1.1, `app.md` §1.4).
- **Update**: a **reviewer** may change `status` and nothing else (`isReviewer()`, plus `request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status'])` and the status union). Nobody else may update at all. The `affectedKeys()` clause is doing more work than it looks: it stops a moderator editing the question text (that is item 6's job, for the _author_ — a moderator quietly rewriting somebody's submission is a different feature nobody asked for), stops `createdBy` being rewritten to steal or disown authorship, and stops fields being introduced outside the create-time `hasOnly()` allowlist, which an update would otherwise sail straight past because `isValidCustomQuestion()` only guards creates. A no-op write of the status already stored is deliberately accepted: the client cannot always know whether a write that timed out landed, and an idempotent retry must not be refused.
- **Delete**: none from the client (`allow delete: if false`) — still console-only. A reviewer can stop a question being served; erasing it is a different power and nothing yet needs it.

`createdBy` may also hold the literal `[deleted-user]` sentinel, written by `deleteAccount` (`stack.md` §2.4) when the author erases their account. It is deliberately distinct from _absent_: a missing `createdBy` means the question predates attribution and was never recorded, whereas the sentinel means an author existed and was deliberately erased. Those are different facts and the schema keeps them distinguishable.

**Attribution (`createdBy` / `createdAt`) is mandatory and self-asserting.** The rules require `createdBy == request.auth.uid`, so a submitter can name themselves and nobody else, and `createdAt` must sit within roughly `[request.time - 5min, request.time + 1min]` (`isNearRequestTime()`), so a submission can't be backdated to look older than it is. Without the time bound, `createdAt` would be decoration — a client can write any number it likes.

Two consequences worth being explicit about:

- **This was not retrofittable, which is why it landed before the features that need it.** No backfill can invent an author for a document that never recorded one, and the exact-key `hasOnly()` allowlist actively _rejects_ adding the field to an existing document. Attribution is what makes an abuse report actionable and what lets account deletion (Known Gaps) find a user's contributions at all.
- **Documents created before this change have no `createdBy` and never will.** `CustomQuestionDoc` therefore types both fields as optional on the _read_ path while `NewCustomQuestionDoc` requires them on the _write_ path — the asymmetry is deliberate, because typing the read shape as always-attributed would be a lie the compiler then helps spread. Those legacy questions remain permanently unattributable.

**`status` — the moderation field** (`BACKLOG.md` item 4b).

`firestore.rules`' `statusOnSubmission()` accepts `'pending'` and nothing else on create, so **a contribution is stored but not served until a reviewer approves it**, and a submitter cannot approve their own. That is item 4c, and it is what the whole of item 4 was building towards.

**Rejection was already the first in-app moderation action this app had** (4b-ii): before it, acting on an abuse report meant deleting the document by hand in the console. Approval is the other half — the report → attributed author → removal loop and the contribute → review → publish loop now both close inside the product.

**Changing this value has a deploy window, and it is unavoidable.** `create` demands exact agreement between the client and the rule, so for as long as a browser holds a bundle from before the change it sends the old status and is refused — one submission, the form's existing error, fixed by a reload. The read path avoided this by shipping the client filter a release early (see **Read** above); the write path cannot use the same trick, because the transitional rule would have to accept **both** `'approved'` and `'pending'`, and accepting `'approved'` is precisely the self-approval this feature exists to prevent. A brief refusal for stale clients is the cheaper of the two, and it is the same trade `custom_questions` already made when `status` became mandatory at all.

**A question that is not approved is not deleted.** It stays stored, keeps its author, and simply is not served. That is what the published policy says, and it is what makes a rejection reversible: a reviewer can move it back.

The field was added in its own PR (4b-i) because putting it in place is a migration and flipping it is not: widening an exact-key `hasOnly()` allowlist and backfilling every existing document is the risky half, and it was worth landing with nothing else moving.

**The write path sets it, not the caller.** `status` is deliberately absent from `NewCustomQuestionDoc` and added by `FirebaseService.addCustomQuestion` via `STATUS_ON_SUBMISSION`. A submitter has no legitimate say in whether their own submission is approved, so offering the field on the caller's interface would be offering a decision the rules exist to refuse. The constant and `statusOnSubmission()` must agree — if they drift, every submission is refused — and both suites pin the value so they cannot.

**It is required on create, not optional-if-present.** An optional field would let a client cached from before the change keep writing documents with no status, which the backfill has already run past, so the collection would drift back out of the invariant it was just migrated into — silently, and the read filter would stop serving those questions. Requiring it costs exactly one refused submission per stale client, surfaced by the form's existing error path and fixed by a reload. Same trade as the checkout-session schema change and the leaderboard retirement (§3).

**The migration has an ordering hazard, and it is the whole risk of this item.** `scripts/backfill-question-status.mjs` must run **between** two deploys:

1. Deploy the PR that adds `status` to the allowlist and makes the client write it. Nothing reads the field, so nothing can break.
2. **Run the backfill.** Old documents get their status.
3. Only then deploy the PR that makes the client filter on `status == 'approved'`.

Run it at step 3 instead of step 2 and every question predating the change vanishes from the game, because a document with no `status` matches no equality filter on it. There is no partial-credit failure mode: it is the whole bank. The script is idempotent, leaves documents that already carry a status completely alone (so a rejected question can never be silently re-approved by a second run), and reports rather than corrects a status it does not recognise. Verified end to end against the emulator — dry run, real run, second run — before it was ever pointed at anything real.

**Three composite indexes are declared ahead of the query that needs them** (`firestore.indexes.json`): `status+category`, `status+difficulty`, `status+category+difficulty`. `getCustomQuestions` emits four filter shapes, and while `status` alone rides the automatic single-field index — those already carry `__name__` as their final ordering, which is what the sampling cursor orders by — each combination with `category` and/or `difficulty` needs declaring. They are shipped in the migration PR rather than the one that starts querying them because **the emulator cannot verify index configuration** (D3, §3) and index builds are asynchronous: declaring them early means they are built and live well before a query depends on them, and a mistake surfaces on a deploy where nothing is broken by it. The pre-existing `category+difficulty` index stays, because clients cached from before the change still issue that shape.

**The review queue is a bounded, unordered query, on purpose.** `getQuestionsByStatus` sends `where('status','==',x)` and `limit(REVIEW_PAGE_SIZE)` and **no `orderBy`**, so it rides the automatic single-field index on `status` and needs no composite; the page is sorted by `createdAt` in the browser. The consequence is honest and small: with more questions in a status than fit on a page, the page _boundary_ is by document ID rather than by age, so a page is not globally the oldest N. Every question is still reachable and still gets reviewed, because reviewing one removes it from the queue and the next arrives. Trading a composite index — and D3's whole class of deploy risk — for that is the right way round. A `where`-and-`limit` pair is mandatory regardless (`CLAUDE.md` §4.1).

**`setQuestionStatus` is the app's first genuinely partial write.** The note on `FirestoreRestClient.setDocument` said the day one arrived it would have to decide on purpose; it has. The `updateMask` covers `status` alone, so every other field is left exactly as the author wrote it. A full-document replace would be wrong twice over — it would drop whatever the reviewer's client did not happen to know about, and the moderation rule refuses it anyway.

**`ReviewerService` is UX and carries no authority** (`CLAUDE.md` §4.2). It decides whether to render the link and the page; `isReviewer()` in the rules decides whether the buttons do anything. What keeps it out of H6's trap — a client signal drifting _broader_ than the server's gate — is that it is not a mirror of the server predicate at all: it reads **the same document and the same field** the rule reads. There is no second expression to keep in step, which is a stronger guarantee than remembering to. Its spec pins the `reviewer: false` case for the same reason `subscription.service.spec.ts` pins `role: null`, and pins that a read still in flight for an account that has since signed out cannot answer for the account that replaced it — which would hand back the instant revocation the whole document-not-claim design exists for. It also owns the one read whose rule is `isReviewer()` alone — the page of `question_reports` the reports tab shows (§ `question_reports`) — so the only code that ever sees a reporter's uid sits in the one service whose subject is the moderation role, and drops it there.

**Contributor attribution (`sourceUrl`, `sourceTitle`, `explanation`) is optional, and optionality is what makes it safe to add** (`FEAT-022`). Every other field this collection has gained arrived as a migration, because the read rule or the client filter dereferenced it — `status` needed `scripts/backfill-question-status.mjs` run between two deploys precisely because `resource.data.status == 'approved'` cannot match a document that has no `status`. Nothing reads these three. No rule branches on them, no query filters on them, and the readers render nothing when they are absent. So widening the `hasOnly()` allowlist is the entire migration: existing documents stay valid, and there is no ordering hazard because there is no step that could run in the wrong order. **The precondition recorded for attribution — "verify the bank holds nothing worth migrating" — does not generalise to optional fields; it was a property of `status` being dereferenced, not of adding a field.**

All three are validated on create and none can be added afterwards. `sourceUrl` must be a string beginning `https://` and longer than that prefix, at most 500 characters; `sourceTitle` must be a non-empty string of at most 200; `explanation` must be a non-empty string of at most 1000. Any may be present without the others: a book has a title and no URL, a bare link with no publication name is still a link worth following, and a tricky question can need reasoning without needing a citation. `http://` is refused rather than upgraded — the CSP would not load the page, so the rule refuses what the reader could not open anyway — and the form catches the same cases first (`app.md` §1.4) so the contributor gets a named field error instead of a bare `permission-denied`.

**`explanation` is 1000 rather than the 500 a question gets**, because it has to explain the question, the correct answer _and_ the distractors — strictly more text than the question itself. It is refused when empty for the same reason `sourceTitle` is: "no justification" is an absent key, so there is no blank value to tell apart from a deleted one. The cap is not a defence against storage cost (a 1 KB field is nothing next to Firestore's 1 MiB document limit); it is a bound on what a public bank will render to every player, and on how much unreviewed prose one write can put in front of a reviewer.

**The field is `explanation`, and the form labels it "Justification".** `FEAT-006` names this field and owns its later life — a reviewer editing it at review time — so introducing it under a second name would leave two near-identical fields that can disagree about why a question is right. What changes for `FEAT-006` is only the author and the moment: the contributor writes it at submission, and edit-and-approve will let a reviewer revise it. That is the widening of the reviewer `update` rule below, and it is `FEAT-006`'s to make.

**The reviewer's update rule was deliberately left alone**, and that is load-bearing rather than an oversight. It still reads `hasOnly(['status'])`, so a reviewer approving a question cannot attach, alter or remove a citation or a justification while doing it — all three stay the author's word, the same way `createdBy` does. Rules tests assert the refusal for each of them, because widening that allowlist is a one-line change that would look like a convenience.

**Readers re-check the stored values rather than trusting them** (`SourceLinkComponent` and `QuestionJustificationComponent`, `app.md` §1.4). `CLAUDE.md` §4.4 asks the reader to be right regardless of the writer: the rule is one deploy from being widened, Firestore is a public API, a stored value that is not a usable `https:` URL degrades to plain text instead of rendering a dead anchor, and a whitespace-only `explanation` — which `size() > 0` accepts, because it counts characters rather than non-space ones — renders nothing instead of an empty labelled box.

### `custom_question_quota` — the hourly submission cap

`custom_question_quota/{window}-{uid}`, holding a single `count`. One document per account per hour; a new hour is a new document.

**Why a separate collection rather than the document-ID trick used everywhere else.** The session and report caps encode `{window}-{slot}` in the _capped document's own ID_, which costs nothing. That is unavailable here. `getCustomQuestions()` samples the bank by generating a random Firestore auto-ID and reading forward from it (§ "How `custom_questions` is sampled"), so it depends on question IDs being uniformly distributed across that 62-character space. A `{window}-{uid}` ID begins with digits, which sort before every auto-ID — capped questions would cluster at the very start of the keyspace, nearly unreachable by a forward scan and over-represented on the wrap-around. The cap would have silently skewed which questions players see.

**How it is enforced.** Rules cannot count documents, so the client writes the counter itself — and the question's own rule requires it, with `getAfter()` reading the counter's **post-commit** state. The two writes therefore have to be one batched commit (`FirestoreRestClient.commit`); a client that sends the question and declines to send the increment is refused. The quota path is derived in the rule from `request.auth.uid` and `request.time`, never from anything the client sends, so a submission cannot be billed to another account's counter and the question needs no extra field — which matters, because adding one would mean widening `custom_questions`' exact-key `hasOnly()` allowlist.

**Limit: 20 per hour** (`maxQuestionsPerWindow()` in `firestore.rules`, `MAX_QUESTIONS_PER_HOUR` in `firebase.service.ts` — they must agree, and the rules tests fail loudly if they drift). `create` demands exactly `count == 1`, `update` demands exactly `+1` and `<= 20`, and `delete` is refused, so the counter cannot be reset, walked backwards, or started high.

**Cost.** One extra read and one extra write per submission. Refused writes are not billed, so an account hammering the cap costs only the rules read — which is why this is cheaper under abuse than a Cloud Function, where every rejected attempt would be a billed invocation. Firestore has no synchronous before-write trigger, so a function could only have deleted over-quota questions _after_ they were already public in a world-readable collection.

**Documents accumulate.** One per active submitter per hour, never deleted by the app. Small, but unbounded over time — a Firestore TTL policy is the intended cleanup, as with the session documents.

### `question_reports` — player reports about community questions

```
question_reports/{window}-{slot}-{uid}
  questionId: string     (must name an existing custom_questions doc — checked with exists())
  reason: 'incorrect' | 'inappropriate' | 'spam' | 'other'
  detail?: string        (1–500 chars; omitted entirely when blank)
  reportedBy: string     (must equal request.auth.uid)
  createdAt: int         (epoch ms, must be near server time)
```

- **Create**: any signed-in caller **including anonymous sessions** — deliberately (finding H4, decided with the owner): most players never sign in, and an abuse channel most of the audience can't use is half a channel. What makes that safe is that a report does nothing on arrival — nothing triggers on it, and only a reviewer may read it — and that the write is schema-bounded and volume-capped.
- **Read**: `isReviewer()`, and nothing else (`FEAT-026`). Not the reporter, not another player, signed in or not — a report can quote another user's content and names its author, so the grant is exactly the set of people whose job is acting on it. `isReviewer()` is the whole condition rather than the right operand of a `||`, because there is no public branch to short-circuit past: every read here is a reviewer's and pays one `user_roles` lookup, which Firestore caches across the documents of a single query.
- **Update / Delete**: none from the client at all, reviewers included. A report is the record that somebody complained, not a task to tick off — there is deliberately no "handled" flag, because adding one means a client write path into a collection that has none. A reviewer acts on the _question_, through `custom_questions`' moderation rule.
- **A reviewer's token reads the whole document, `reportedBy` and all.** Rules cannot return a subset, so the narrowing is the client's: `ReviewerService.getQuestionReports` drops the uid at the boundary and the type the queue receives has no such field, which is what keeps "a reviewer needs the complaint, not the complainant" out of the hands of whoever next writes the markup (`app.md` §1.4). The Privacy Policy discloses the grant as it actually is — that a reviewer's access reaches the identifier even though the screen does not show it.
- **The app's read is one bounded, ordered page** — `REPORTS_PAGE_SIZE` (25) at a time, `createdAt` descending with the **document ID descending as a tiebreaker**, and the next page fetched from an exclusive cursor carrying both values (`CLAUDE.md` §4.1). Three things are worth knowing, and two of them were measured against the emulator rather than reasoned about:
  - **The tab has to page.** Nothing is ever marked handled, so unlike the status tabs — where reviewing a question removes it and the next arrives — "reload for more" would return the same newest page forever. Growing the `limit` instead re-reads every page already on screen and is billed for each of them, so the next page comes from a cursor.
  - **Ordering by the document ID alone is not available.** It looks ideal — the ID begins with the same `{window}` bucket the volume cap is keyed on, so it encodes arrival order — but `orderBy(__name__, 'desc')` as a query's _only_ order is refused outright: "Firestore does not support descending key scans". As a tiebreaker after another descending field it is accepted, which is what this query does.
  - **A cursor on `createdAt` alone silently skips a report.** Two reports filed in the same millisecond put one of them at a page boundary and its twin immediately after the cursor value, where `startAfter` steps over it. Probed with deliberate ties: exactly one document vanished between pages. The `__name__` tiebreaker — in the order _and_ in the cursor — is what makes each row's position unique.
- **There is no `where` to add, and no index to declare**: the queue wants the newest complaints whatever they are about, and the explicit `__name__ desc` tiebreaker is the same one Firestore appends implicitly to a descending `orderBy`, so the automatic single-field index on `createdAt` serves it — none of D3's deploy risk.
- **The volume cap is the A3 document-ID mechanism in a flat collection**: an ID must be `{window}-{slot}-{uid}` — the current 5-minute window of server time (±1 for clock skew), a single digit, and the caller's own uid, which is what keeps slots per-user when the collection isn't nested under one. Ten reports per five minutes per uid; a `setDoc` on a taken slot is an _update_, which is denied, so a taken slot refuses exactly like an invalid one. A side benefit: IDs sort by window, so the console lists reports chronologically for free.
- **`questionId` is checked against the bank with `exists()`** — one billed read per create, worth it on a path this rare and this capped to keep junk out of the review queue. Note this is the check rules _can_ do; the checkout price lookup is the kind they can't (`stack.md` §2.4).
- **No TTL, on purpose** (contrast `checkout_sessions`, below): this is the reviewers' queue, volume is capped, and auto-expiring unreviewed reports would silently lose the one signal the collection exists to carry.
- Rules live in `firestore.rules` (`isValidQuestionReport`), with their own suite (`firestore-tests/question-reports.rules.spec.ts`, 31 tests, mutation-verified — nine deliberate rule breaks produced 5/3/1/1/1/3 targeted failures on the create clauses and 5/3/4 on the read: denying every read fails the five accept rows, opening it to any signed-in caller fails the three denial rows, and splitting it into `allow get` + `allow list: if false` fails the four list accept rows (the cursor page among them) — the distinction `CLAUDE.md` §4.6 records the worked example of).

### `customers` — Stripe billing state (managed by `functions/`, `stack.md` §2.4)

```
customers/{uid}
  stripeId: string                          (Stripe customer ID)
  supporterSince: timestamp                 (first donation; written by stripeWebhook, never by a client)

customers/{uid}/checkout_sessions/{window}-{slot}
  price: string          (Stripe price ID, written by the client)
  origin: string         (bare scheme://host[:port], written by the client)
  sessionId, url: string                        (written back by createCheckoutSession)
  error?: { message: string }
  expiresAt: timestamp                          (written by createCheckoutSession; TTL, see below)

customers/{uid}/donation_sessions/{window}-{slot}
  price: string          (Stripe price ID of a donation preset, written by the client)
  origin: string         (bare scheme://host[:port], written by the client)
  sessionId, url: string                        (written back by createDonationSession)
  error?: { message: string }
  expiresAt: timestamp                          (written by createDonationSession; TTL, see below)

customers/{uid}/donations/{checkoutSessionId}
  amount: number      (smallest unit of the currency, as Stripe reports it)
  currency: string    (lowercase ISO 4217)
  createdAt: timestamp                          (when Stripe created the session)
  eventCreated: int   (epoch SECONDS; the ordering high-water mark, see `stack.md` §2.4)

customers/{uid}/portal_sessions/{window}-{slot}
  origin: string         (bare scheme://host[:port], written by the client)
  url: string                                   (written back by createPortalSession)
  error?: { message: string }
  expiresAt: timestamp                          (written by createPortalSession; TTL, see below)

customers/{uid}/subscriptions/{id}
  status: string      (Stripe subscription status, e.g. 'active' | 'trialing' | 'canceled' | ...)
  role: string | null (from the price's `firebaseRole` metadata)
  price, product: string | null
  cancel_at_period_end: boolean
  eventCreated: int   (epoch SECONDS; the ordering high-water mark, see `stack.md` §2.4)
```

- **Read**: only the owning uid. `customers/{uid}`, `checkout_sessions`, `portal_sessions` and `subscriptions` require `isRealAuthedUser()`; `donation_sessions` and `donations` require only `request.auth != null`, for the reason below.
- **Create**: `checkout_sessions`, `donation_sessions` and `portal_sessions`, by the owning uid — kicking off `createCheckoutSession` / `createDonationSession` / `createPortalSession` (`stack.md` §2.4) respectively. Never updated/deleted from the client.
- `customers/{uid}`, `subscriptions/{id}` and `donations/{id}` are never written by the client at all — only by `functions/` via the Admin SDK, which bypasses these rules entirely. `supporterSince` and the donation records are the same refusal from two sides: a client able to write either could declare itself a supporter without paying.

**`donation_sessions` is the one path in this tree an anonymous session may write, and that is deliberate.** Donating is not a privilege: the money goes to Stripe either way, friction in front of it costs donations and protects nothing, and an anonymous uid cannot name anybody else's customer document. What the account decides is whether the donation can be **attributed** — `createDonationSession` attaches a Stripe customer and a `firebaseUID` only for a real account, so a guest's payment leaves no `donations` document and nothing that could be linked back to them, which is what the Privacy Policy says and what the dialog says before anybody pays. The `donation_sessions` document itself is still written, under the anonymous uid, and expires on the same 24-hour TTL as every other session document. The schema is validated by its own `isValidDonationSession()` rather than by sharing `isValidCheckoutSession()`: the two payloads are identical today and the paths exist to be separate, so a field added for Pro must not start being accepted for donations without somebody deciding that.

**The two session caps are counted apart, because they are two subcollections.** Ten donation sessions per five minutes and ten checkout sessions per five minutes, per user; spending one has no effect on the other, which is what keeps a burst of donations from refusing the Pro checkout the same person then tries.

**A session document is validated twice, and neither layer is redundant.** These two subcollections are the only client-writable path in the app that spends money, and they used to accept any field of any size: `price`, `mode`, `success_url` and `cancel_url` were all written by the client and handed to Stripe verbatim. `success_url` was the sharp one — anyone who could write a session document could have Stripe return the user to a host they controlled, arriving from a genuine Stripe redirect.

- **`firestore.rules` bounds the shape**: an exact-key `hasOnly()` allowlist (`price` + `origin`, or `origin` alone), a Stripe-price-ID pattern on `price`, and `origin` constrained to a bare `scheme://host[:port]` — no path, query or fragment, so there is nothing to smuggle.
- **The function checks it again against what only the server knows** (`functions/src/checkout-request.ts`). Rules cannot know which hostnames belong to this deployment, so the origin is matched against an allowlist: `{project}.web.app`, `.firebaseapp.com` and `{project}--{channel}.web.app` preview channels are derived from the project ID; localhost is offered to a `demo-` project only; and the **custom domain** (`trivimind.com` / `www.trivimind.com`) is the one entry that cannot be derived and is therefore a hand-maintained constant, `CUSTOM_APP_ORIGINS`. **Attaching another custom domain in the Firebase console means adding it there in the same change** — checkout is refused on any origin not on the list, so the symptom of forgetting is narrow and easy to miss: the new domain quietly sells nothing while every other one keeps working. Each refusal is logged with the offending origin. Rules cannot look a value up in a catalog either, so `price` is checked against the webhook-mirrored `products`/`prices` collections: it has to be an `active` price on an `active` product carrying `role: 'pro'`. A well-formed price ID for anything else in the same Stripe account is rejected.
- **The redirect URLs and the mode are no longer client input at all.** `createCheckoutSession` builds `success_url`/`cancel_url` from the validated origin and hardcodes `mode: 'subscription'`, so there is no client-chosen value left for it to pass through.

**Session documents expire on their own.** They are handshake scratch space — the client creates one, the backend writes a URL onto it, the browser redirects, and nothing reads it again — and nothing deleted them, so they accumulated one per checkout attempt for the life of the project. All three collection groups (`checkout_sessions`, `donation_sessions`, `portal_sessions`) carry a **Firestore TTL policy** on `expiresAt`, declared in `firestore.indexes.json` (`fieldOverrides` with `ttl: true`) so it deploys through the same `firebase deploy --only firestore:indexes` step as any index rather than being a console setting nobody can see from the repo.

**A `checkout_sessions` document no longer implies that anybody clicked Subscribe.** The client creates one in the background for an eligible reader who opens `/pricing`, so the click is a redirect rather than a wait (`app.md` §1.6) — which means some of these documents, and the Stripe Checkout Sessions behind them, are never used. They cost nothing and expire on the same 24-hour clock as any other, but a Dashboard full of open sessions is the expected state rather than a symptom. `portal_sessions` is unchanged: a billing portal is still only ever opened by somebody who asked for it.

- **The window is 24 hours**, matched to Stripe's own Checkout Session expiry rather than picked freely: the handshake finishes in seconds, so what a longer window buys is a readable record while the session it describes is still live on Stripe's side — exactly when someone would be looking at it to debug a failed payment. Firestore sweeps expired documents on a best-effort basis (typically within 24h of expiry), so this is a floor on retention, never a promise about when a document is gone.
- **`expiresAt` is stamped by the Cloud Function before anything that can fail**, not folded into the write-backs. Those only happen on paths the handler completes, so a Stripe call that hangs until the function times out would leave a document with no expiry at all — and a cleanup that skips exactly the cases where things went wrong is the wrong cleanup. It costs one extra write on a path that already makes a Stripe round trip.
- **No rules change was needed.** The allowlist governs the client's `create`; the function writes with the Admin SDK, which bypasses rules entirely, so `expiresAt` never passes through them.
- **A donation _record_ is not scratch space and has no TTL.** `customers/{uid}/donations/{id}` is the answer to "what did I pay you", and it is kept for as long as the account exists — deleted with the account, and returned in full by `exportAccountData`. Only the session document that carried the donor to Stripe expires.
- **The TTL cannot re-open the volume cap below.** Slot IDs derive from a window of server time that only moves forward, so a deleted document's ID belongs to a window no future request can name.

**The document ID carries a volume cap.** Every create on these paths triggers a Cloud Function that calls Stripe, and rules cannot count a user's documents — so the cap lives in the only server-controlled quantity available for free, `request.time`. An ID must be `{window}-{slot}`: the current 5-minute window of server time (±1 window, for client-clock skew — the same tolerance `isNearRequestTime()` already accepts) and a single digit. Since `create` only ever applies to an ID that doesn't exist yet, that is ten sessions per five minutes per user, against an unbounded `addDoc` loop before. `SubscriptionService.createSessionDoc()` picks a slot at random and moves to the next on a `permission-denied`, so a real user never sees the cap; running out of all ten is it actually biting.

Background pre-creation spends from the same ten, which is why the client rations itself: **at most three of them may be pre-created per page load**, and a reload — or a second tab — reuses the session already in `localStorage` rather than creating another (`app.md` §1.6). The ration is deliberately the weaker of the two bounds: it lives on a service that dies with the document, so a reload starts a fresh three, and the ten per window enforced here is what actually holds. What the ration is for is the reader who sits on one page flicking the currency switch while they decide; what stops a reloader is the reuse, not the count.

One consequence worth knowing: **a client cached from before this change cannot start checkout.** It writes an auto-ID document with the old four-field payload, and both the ID and the payload are now rejected. The deploy order is now backend-first (`ci-cd.md` §4.2), so the rules are live before the client that needs them — but an old client is still reachable from a tab left open across a deploy, or from the service worker's precached shell, so the exposure is that session rather than the deploy window; a reload fixes it, and `SubscriptionService` reports a "reload and try again" message rather than a raw `permission-denied`.

Note: `math.floor()` is deliberately **not** used to compute that window. Dividing two ints in the rules language already truncates, whereas `math.floor()` returns a _float_ that `string()` renders as `"5954006.0"` — which no client would ever match, and which fails open in the sense that every legitimate checkout stops working. Verified against the emulator rather than assumed, the same way `math.round()` was checked before the leaderboard relied on it.

> **`firebaseRole: pro` must be set on the Stripe Product _and_ on the Price — they are read by different code for different purposes, and setting only one fails silently.** The **product**'s metadata becomes `products/{id}.role` (`functions/src/products.ts`), which is what `createCheckoutSession` validates a price against and what the pricing page selects on — so with only that set, **checkout works**. The **price**'s metadata becomes `customers/{uid}/subscriptions/{id}.role` (`functions/src/subscription-mirror.ts`), and that is what `deriveClaimRole()` turns into the `stripeRole` claim — so without it, `role` mirrors as `null`, **no claim is ever granted**, and every privileged write is refused while the subscription looks perfectly active in both Stripe and Firestore. This happened on the live project: an active subscription with `role: null` unlocked the add-question form (the client signal has since been tightened to require the role too) and the rules rejected every submission. Fixing the metadata does **not** repair an existing subscription by itself: the mirror is written from the price object embedded in the event payload, so a resent old event carries the old snapshot, and `event-order.ts` drops it as stale anyway. Trigger a _fresh_ `customer.subscription.updated` (any real edit to the subscription), then sign out and back in to pick up the new claim.

### `products` — Stripe product/price catalog (managed by `functions/`, `stack.md` §2.4)

```
products/{id}
  active: boolean
  name: string
  description: string | null
  role: string | null       (from the product's `firebaseRole` metadata)
  kind: string | null       (from the product's `kind` metadata; 'donation' for the tip jar)
  images: string[]
  eventCreated: int         (epoch SECONDS; the ordering high-water mark, see `stack.md` §2.4)

products/{id}/prices/{id}
  active: boolean
  currency: string
  unit_amount: number | null   (smallest currency unit, e.g. cents)
  type: 'one_time' | 'recurring'
  kind: string | null          (from the price's `kind` metadata; 'donation' for the tip jar)
  interval: 'day' | 'week' | 'month' | 'year' | null
  interval_count: number | null
  eventCreated: int            (epoch SECONDS; the ordering high-water mark, see `stack.md` §2.4)
```

Every document `stripeWebhook` mirrors carries `eventCreated` — the `created` timestamp of the Stripe event that last wrote it. Stripe guarantees at-least-once delivery and nothing about **order**, so without it a stale `customer.subscription.updated` (cancelled) could land on top of a fresh one (active) and the `stripeRole` claim would be recomputed from the older truth. The write is a transaction that drops any event older than the mark. Equal timestamps are allowed through: a redelivery carries exactly the mark it wrote, and two genuine updates can share a second.

- **Read**: public on both levels — lets `/pricing` and `SubscriptionService` (`app.md` §1.6) resolve the current Pro prices, and the donation dialog its presets, with no secrets involved. Every query is bounded and every one filters on a single field so the automatic single-field index serves it: `products` on `role == 'pro'` or on `kind == 'donation'`, and each product's `prices` on `active == true`.

**`kind` is what tells the tip jar from the paid tier, and the two are disjoint by construction.** The donation Product carries `kind: donation` metadata and so does each of its one-time Prices; the Pro product carries `firebaseRole: pro` and no `kind` at all. `isSellableProPrice` refuses anything marked as a donation and `isSellableDonationPrice` refuses a `role: 'pro'` product, both pinned by unit tests, because nothing in the Stripe Dashboard stops a product carrying both fields — and the failure modes run opposite ways: a donation price sold as Pro is a one-off payment granting a subscription's claim, a Pro price taken as a donation is a recurring charge dressed as a tip. The Dashboard steps that create this catalog are in `stack.md` §2.4.

- **Write**: client-side none at all; kept in sync from Stripe Dashboard `product.*`/`price.*` events by `stripeWebhook` (`stack.md` §2.4) via the Admin SDK.

**One price per currency, and the currency lives on the price.** The Pro product carries an active monthly price for each currency it is sold in — `price_…` in USD, another in BRL — rather than one price with alternative `currency_options`, because Stripe freezes a price's currency options once that price has been used. `SubscriptionService` reads them all and offers the reader a choice between them (`app.md` §1.6); a second monthly price in a currency already offered is a Dashboard mistake rather than a choice, so the client keeps the first in catalog order and ignores the rest. Nothing about this needs a rules change: the client still sends one `price` ID, and `createCheckoutSession` still checks it against this catalog. Each price needs its own `firebaseRole: pro` metadata — see the note above for what breaks silently when one of them is missing it.

### `leaderboard` — high scores

```
uid: string            (doc ID; must equal request.auth.uid)
name: string          (1–30 chars)
score: int             (0 .. totalQuestions — every entry here predates multipliers)
totalQuestions: int    (1–25; the longest game the app offers)
percentage: int        (round(score * 100 / totalQuestions))
createdAt: int         (epoch ms, near server time)
```

- **Read**: public.
- **Create / Update**: requires a non-anonymous, (if password-based) email-verified caller writing to their own uid's doc — schema is strictly validated in `firestore.rules` (exact key set, types, bounds) and an update is only accepted if `score` improves on the existing value.
- **Delete**: disallowed.
- **Retired** (finding G7). Its contents were migrated into `leaderboards/15/entries`, the client no longer reads or writes it, and `firestore.rules` now allows **read only**. Writes are refused rather than ignored: a client cached from before the switch would otherwise keep writing scores into a collection nothing reads, which looks like success and loses them silently. Reads stay open so the documents remain inspectable — nothing was deleted.
- One document per user (doc ID == uid) — the client `setDoc`s unconditionally and lets the rules reject non-improving writes. **A rejection is not self-explanatory**, though: since the bounds above were added, the rules also refuse a clock outside the accepted window, a name over 30 characters, a score above the multiplier ceiling, an accuracy above what the score allows, and an unverified account. `GameOverComponent` therefore reads the caller's own entry before claiming "your best score is already higher", and only suppresses retry when that reading confirms it — everything else, including a lookup that itself fails, gets a generic message and keeps the form open. Reporting one cause for every rejection told most of those users something false and left them no way to try again.

**The numeric bounds are anti-cheat, not just shape validation.** The rules once checked only that `score >= 0` and `totalQuestions >= score`, which accepted a hand-written `999999` and made rank #1 permanently unassailable (an update requires beating the existing score). Four constraints tie an entry to something a real game could have produced:

- **`totalQuestions` is capped at 25**, the longest game `GameSetupComponent` offers. Deliberately a _range_ (1–25) rather than the exact option set: a `custom` or `mixed` game legitimately returns fewer questions than requested when the bank is short, so asking for 25 when 7 exist produces a genuine 7-question game. **Raising the option list above 25 requires raising this cap too** — the rules tests fail loudly if the two disagree, and `GameSetupComponent`'s own `Validators.max` was tightened from 50 to 25 to match, since 50 was never reachable through the UI.
- **`score` is capped at `totalQuestions * maxScoreMultiplier()`**, which is 3 (`FEAT-004`). A streak multiplier is the reason a score may exceed the question count at all, and the cap is what keeps "may exceed" from meaning "is unbounded": a perfect 25-question run tops out at 75, and so does a forged one. The number is duplicated as `MAX_SCORE_MULTIPLIER` in `src/app/models/scoring.ts` so the client can refuse to submit a score the rules would reject — a refusal arrives as a bare `permission-denied` that `/game-over` cannot honestly narrate — and a test in `firestore-tests/leaderboards.rules.spec.ts` reads the number out of `firestore.rules` and pins the two equal. **The rules copy is the authority**; a client is the attacker's own machine.
- **`percentage` is raw accuracy, bounded in three ways rather than derived**: an integer, `0..100`, and no greater than `round(score * 100 / totalQuestions)`. It used to be exactly that expression, which stopped being true the moment the score carried a multiplier and the accuracy did not. The inequality is the same check relaxed along the one axis the multiplier moves: every correct answer is worth at least a point, so the correct-answer count can never exceed the score, and `math.round()` is monotonic — an unmultiplied run still satisfies it with equality, while 1 correct out of 10 still cannot be published as 100%. The `<= 100` half is what stops a multiplied score licensing a 340% entry. Firestore's `math.round()` was verified empirically against JavaScript's `Math.round()` across `.5` boundaries before any of this relied on it — they agree, so no tolerance is needed.
- **`createdAt` must sit near server time** (`isNearRequestTime()`, shared with `custom_questions`), so an entry can't be backdated.

**The rules deliberately do not re-simulate the game.** The bound is a ceiling, not a reproduction of the tier table: a rule that reproduced it would have to change in lockstep with every balance tweak and would reject honest scores the day it fell behind. The tiers are the client's business; what the server owes is a number no run can exceed.

**This is mitigation, not closure.** Nothing here proves a game was actually played — a determined attacker can still write a plausible 75/25. What it removes is the cheap, unbounded version: the ceiling for a forged entry is now the same as the ceiling for an honest one. Closing it properly needs a server-attested game token, which was considered and deliberately deferred — see `AUDIT_REMEDIATION.md` §4.

**One composite index is defined** (`firestore.indexes.json`): `custom_questions` on `(category ASC, difficulty ASC)`, for the bounded question query described below. The index Firestore actually builds ends with `__name__`, but that **must not be written in the file** — declaring it breaks every deploy after the first (`INFRASTRUCTURE.md` §6.3), and `firestore-tests/indexes.spec.ts` fails if it reappears. The leaderboard's `orderBy('score', 'desc').limit(10)` needs only the automatic single-field index, and so does a question query filtering on category **or** difficulty alone — Firestore's automatic single-field indexes are already `(field, __name__)`, so they serve one equality filter ordered by document ID. Only the two-filter case needs a composite.

> **The emulator cannot verify this.** It answers queries whether or not a matching index is declared, so a missing index passes every local check and `npm run e2e`, then fails in production with `FAILED_PRECONDITION` and a console link. Index requirements have to be reasoned about and declared, not discovered by running the suite. One thing ordering cannot fix: a newly declared index takes time to **build** after it is created, so a brand-new query can briefly fail against production even though indexes now deploy before the client that needs them (`ci-cd.md` §4.2).

### `leaderboards/{limit}/entries` — one board per timing constraint

```
leaderboards/{limit}/entries/{uid}

uid: string            (doc ID; must equal request.auth.uid)
name: string           (1–30 chars)
score: int             (points; 0 .. totalQuestions * 3 — streak multipliers, FEAT-004)
totalQuestions: int    (1–25)
percentage: int        (accuracy; 0..100, and <= round(score * 100 / totalQuestions))
createdAt: int         (epoch ms, must be near server time)
timeLimit: string      (must equal the {limit} path segment)
```

`{limit}` is one of **`15`**, **`30`** or **`unlimited`** — the three timing constraints a game can be played under (finding G7). A score won with no time limit is not comparable to one won in 15 seconds, so each constraint gets its own board rather than one board recording the conditions and ranking across them.

- **Read**: public, but only for a declared board. The board name is a path segment the caller chooses, so an unchecked read rule would serve `leaderboards/anything/entries` — a public collection named by whoever asks.
- **Create / Update**: identical contract to the collection above — a non-anonymous, (if password-based) email-verified caller writing to their own uid, exact-key schema validation, and an update only if `score` improves. A multiplied score improves on an unmultiplied one exactly as any higher score does; nothing about the ranking changed, only the range a score may occupy. The improving-score check reads `resource.data` **at that path**, so it is naturally scoped per board: a player's 15-second best cannot block their first unlimited entry, which is the whole point of separating them.
- **Delete**: disallowed.

**A subcollection rather than a `timeLimit` field on one flat collection.** The flat version needs `where('timeLimit','==',x).orderBy('score','desc')`, which requires a **composite index** — and index configuration is the one thing the emulator cannot verify, the same gap that took the deploy pipeline down for four consecutive merges (D3, above). Per-board `orderBy('score','desc').limit(10)` needs only the automatic single-field index, so that class of risk does not arise at all. `firestore.indexes.json` is untouched by this feature.

**`timeLimit` is redundant with the path and is stored anyway.** An exact-key `hasOnly()` allowlist cannot be widened later without rejecting every existing document — the A10 wall — so a field that might be wanted has to be in the schema from the start, and an admin export across boards should not have to parse document paths to know what it is looking at. The rules require it to equal the path segment, which is what keeps the redundancy from drifting into a second, disagreeing source of truth.

**The board list is schema, not configuration.** Adding an option to the setup screen without adding it to `isValidBoard` produces a game whose score can never be saved. `firestore-tests/leaderboards.rules.spec.ts` enumerates the same three values, and its accept cases fail if the rules list shrinks — verified by mutation, since a suite of nothing but rejections passes against a rule that denies everything.

**Old and new entries share a board indefinitely**, and both have to read correctly on it. An entry saved before `FEAT-004` has `score == correctAnswers` and nothing distinguishes it from a multiplied one; the row renders `N pts · P%` either way, which is true of both, where the old `score / totalQuestions` form would have been a lie about the newer ones (`app.md` §1.1).

#### Migrating off the flat `leaderboard` collection

The pre-G7 collection is being retired. Every entry in it was won under the fixed 15-second limit — it was the only limit the game had — so `scripts/migrate-leaderboard-to-boards.mjs` copies it into `leaderboards/15/entries`, adding the `timeLimit` field the old documents do not have. It runs through the Admin SDK because no client may write another user's entry, and it is tracked as a manual step in `AUDIT_REMEDIATION.md` §7. Its credential handling — the two supported ways to supply a service-account key, and the `--project` cross-check that refuses to run against a project the operator did not name — now lives in `scripts/admin-credential.mjs`, shared with `scripts/backfill-question-status.mjs`. Extracted rather than copied because that cross-check is the entire safety story of a script that bypasses `firestore.rules` by design, and two copies of it is two places for it to rot out of step.

Three properties of that script are deliberate, and were exercised against the emulator rather than assumed:

- **It never deletes.** The old collection is left exactly as it is, so a mistake costs nothing and the script can be re-run.
- **It is idempotent**, and re-running is part of the plan rather than a recovery step: run it once after the rules ship, and again after the client switches over, to sweep up any score saved into the old collection in between. A re-run writes only when the old score actually beats what is already on the board — the same rule the client plays by.
- **It refuses to guess which project it is talking to.** Both `--project` and a service-account key are required, and the script exits if the key's `project_id` disagrees with the flag. The credential is what actually decides the destination, so deriving the check from it rather than from an ambient default is the same reasoning as deriving Stripe's live/test mode from the key (`CLAUDE.md` §4.3).
- **The credential can be a path or the JSON itself.** `GOOGLE_APPLICATION_CREDENTIALS` is Google's convention for a _path_, but a secret store — a Codespaces secret, a CI variable — hands you a value, not a file, so putting the key's JSON straight into the variable whose name you already know is the obvious thing to try. It now works: inline is detected by shape (no filesystem path starts with `{`), and `GOOGLE_APPLICATION_CREDENTIALS_JSON` is accepted as the unambiguous spelling. When JSON is read out of `GOOGLE_APPLICATION_CREDENTIALS` the variable is unset before any Google library sees it, so nothing downstream tries to `open()` several kilobytes of JSON as a filename. That was the original failure mode, and it surfaced as `ENAMETOOLONG` — a message that says nothing whatsoever about credentials. A key mangled the other common way, with the `\n` escapes in `private_key` turned into real newlines, is now named as such too rather than reported as a bare parse error.

The switch happened in two deploys for exactly this reason: rules deploy before the client that matches them (`ci-cd.md` §4.2), so denying writes to the old collection in the same change that added the boards would have broken saving for every player still running the previous build. The first deploy added the boards and left the old collection writable; the migration ran; the second moved the client and closed the old collection.

**Account deletion and export span every board.** `deleteAccount` removes the caller's entry from all three boards _and_ the legacy collection — a deletion that missed one would leave a name and score publicly readable after the user asked to be removed — and `exportAccountData` returns one entry per board, each labelled with the board it came from. Both use the shared list in `functions/src/leaderboards.ts` rather than repeating it, because a list written out twice is a list that eventually gets updated once.

### How `custom_questions` is sampled

The bounded query above has to stay _random_, or every player would be served the same first N questions forever. It does that with the document ID space itself: the query starts at a randomly generated document ID (`orderBy(documentId())` + `startAt(cursor)` + `limit(n)`), and wraps around with a second `endBefore(cursor)` query if the cursor landed too near the end. Firestore auto-IDs are drawn uniformly from a 62-character alphabet, so a random ID is a uniform position in the collection.

Deliberately **no `random` field on the documents**, which is the textbook approach: the exact-key `hasOnly()` allowlist in `firestore.rules` would have to be widened for it, every existing document would lack it, and no client could backfill one because `custom_questions` is create-only — the same wall attribution (A10) hit. Using the ID space needs no schema change, no migration and no rules change at all. The cost is at most two reads of `n` documents, and usually one: the wrap only runs when the first pass came up short.

### Rules test suite

`firestore.rules` is the app's real security boundary, so it has a dedicated unit suite (`npm run rules:test`, `firestore-tests/`, 346 tests across seven spec files) built on `@firebase/rules-unit-testing` and run against the Firestore emulator. Deliberately outside `src/` and driven by its own `vitest.rules.config.ts`, so the Angular build, `ng test` and the ESLint globs never pick it up.

- **Every branch is covered by its reject case, not just its happy path** — signed-out, anonymous, unverified-password, verified-but-not-Pro, a `stripeRole` that is set but isn't `pro`, cross-uid writes, every schema bound, and default-deny on an undeclared collection.
- **Auth contexts always set `firebase.sign_in_provider` explicitly** (`firestore-tests/helpers.ts`). Omitting it yields a provider that satisfies `!= 'anonymous'`, so a test leaning on the default would pass for the wrong reason and would keep passing if the anonymous check were deleted outright.
- **Each spec file uses its own `projectId`**, because `clearFirestore()` wipes a whole project — sharing one would make parallel files race each other's fixtures.
- **The suite is mutation-tested whenever it's extended**: breaking `isProUser()` to always return true, deleting the anonymous check, and dropping the leaderboard's improving-score condition each produced failures (3, 4 and 2 respectively) when it was first written. The session-document rules were checked the same way — dropping the volume cap, dropping either schema check, widening the slot space, and dropping the origin pattern produced 8, 12, 9, 2 and 6 failures respectively. A rules suite that passes against broken rules is worse than none. `user_roles` was checked the same way: opening `list`, dropping the ownership check on `get`, allowing self-writes, and deleting the whole block produced 4, 2, 5 and 6 failures respectively — and the deletion run is the one that matters most, because all six of its failures are _accept_ cases, which is the fails-100%-closed mode a suite of nothing but `assertFails` cannot see. The fifth mutation, `allow read` in place of `get` + `list: if false`, scored **1**, and that single row is described in the section above. The `status` field was checked the same way: dropping its check from the validator, flipping `statusOnSubmission()` to `'pending'`, and removing `status` from the `hasOnly()` allowlist produced 5, 10 and 9 failures. The middle one is the one to remember — it is deliberately large, because 4c has to make exactly that change, and ten failing tests is what stops it being a silent widening. The moderation rule was checked in turn: making `isReviewer()` always true, dropping the `affectedKeys()` clause, dropping the status union, and closing `update` back to `if false` produced 4, 4, 1 and 4 failures — and the last four are all accept cases, again the direction a reject-only suite cannot see. And the design worked when the value actually changed: flipping `statusOnSubmission()` from `'approved'` to `'pending'` for real in 4c broke **twelve** tests across the accept cases, the two status rows and the whole read block — which is what a change to the product's central promise should look like in a diff. The donation rules were checked clause by clause in turn: narrowing `donation_sessions` to `isRealAuthedUser()`, dropping its ownership check, dropping its schema check, dropping its volume cap, making `donations` client-writable, and deleting the `donations` block outright produced 3, 2, 4, 3, 2 and 2 failures. The first and the last are the ones worth keeping in view, because every one of their failures is an _accept_ case: the first says an anonymous session and an unverified account may both donate, which is the whole point of that path and is invisible to a suite of `assertFails`; the last says the donor can still read what they paid.
- **The `CURRENTLY ACCEPTS` pins are gone.** Two findings were deliberately pinned with `assertSucceeds` — the unbounded leaderboard score (A1) and the unvalidated checkout-session payload (A2/A3) — so that the PRs closing them would have to flip the expectation to `assertFails` in the diff rather than quietly deleting a test. Both have now flipped. It's a pattern worth reusing for any finding whose fix lands later than its discovery.
