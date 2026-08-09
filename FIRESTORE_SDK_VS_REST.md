# Firestore: client SDK vs REST API

A decision document, not a plan. It exists because the timeout work in [#60](https://github.com/shermam/trivia/pull/60) exposed something uncomfortable: seven of this app's Firestore calls cannot be cancelled at all, because the SDK offers no mechanism. `fetch` does. That prompted the wider question of whether the SDK is earning its place here.

Every number below was measured against this repo on 2026-08-09, not taken from a blog post. Where something is a judgement rather than a measurement, it says so.

---

## 1. What this app actually uses

This matters more than any general comparison, because the SDK's expensive features are mostly ones this app doesn't touch.

**The entire Firestore API surface in use is thirteen symbols:**

```
addDoc  collection  doc  getDoc  getDocs  getFirestore  limit
onSnapshot  orderBy  query  setDoc  where  connectFirestoreEmulator
```

**Five collections**, all with flat, simple document shapes — strings, ints, booleans, and one array of strings. No subcollection queries beyond one level, no collection-group queries, no transactions, no batched writes, no `FieldValue` sentinels, no composite indexes (`firestore.indexes.json` is empty).

**Two `onSnapshot` listeners**, both in `SubscriptionService`:

1. the `customers/{uid}/subscriptions` query that drives the real-time `isProUser` signal
2. the checkout/portal handshake, waiting for a Cloud Function to write a `url` back onto a session document

Everything else is one-shot reads and writes.

**Local persistence is not enabled.** `FirebaseService` calls `getFirestore(app)`, whose default cache in the modular SDK is **memory only** — nothing is written to IndexedDB, and nothing survives a reload. The offline capability this app actually ships is its own `OfflineQuestionsService`, a hand-written IndexedDB pool.

That last point reframes the whole discussion. The strongest argument for keeping the SDK is usually "offline persistence for free". **This app is not taking it**, and already paid to build the alternative.

---

## 2. Bundle size and client performance

Measured from `npm run build:prod`:

| Chunk                                |      Raw |      Gzipped |
| ------------------------------------ | -------: | -----------: |
| **Firestore SDK**                    | 545.8 kB | **161.0 kB** |
| Angular framework                    | 245.7 kB |      75.9 kB |
| Firebase Auth SDK                    | 125.9 kB |      35.6 kB |
| This app's own `main`                | 112.0 kB |      30.3 kB |
| Initial bundle total (main + styles) | 164.0 kB |      33.7 kB |

**The Firestore SDK is the largest single thing this app ships — about 5× the app's own code, and more than twice the Angular framework chunk.**

It is lazily imported, which sounds like it limits the damage. It doesn't: I confirmed in a real browser that `chunk-BdOPYsvB.js` loads on the **landing page** of a cold session, alongside two `Listen/channel` requests. The lazy import defers it by milliseconds, not meaningfully.

Two costs, not one:

- **Transfer.** 161 kB gzipped (Firebase Hosting serves brotli, so somewhat less in practice) on a connection that may be a phone on mobile data.
- **Parse and execute.** 546 kB of JavaScript has to be parsed and run on the main thread. On a low-end device this is the larger of the two costs, and it competes directly with the app becoming interactive.

A REST adapter for the surface in §1 is a few hundred lines and adds effectively nothing — `fetch` is already there.

**This is the strongest argument for REST**, and it is not close.

---

## 3. Timeouts and cancellation

The question that started this.

|                           | SDK                                                                                        | REST                        |
| ------------------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| Per-call timeout          | none — `getDocs`/`getDoc`/`setDoc`/`addDoc` take no options argument                       | `AbortSignal.timeout(ms)`   |
| Cancellation              | none — `AbortSignal` appears nowhere in `@firebase/firestore`'s type definitions           | the connection is torn down |
| What a timeout does today | `giveUpAfter()` stops _waiting_; the request runs to completion for a caller that has gone | the request stops           |

**REST wins outright.** It also deletes `giveUpAfter` entirely, since it exists only for these call sites (plus `signInAnonymously`, which is Auth and would stay).

Worth stating plainly: the deadline itself is load-bearing and must survive either way. `TriviaService.getQuestions()` falls back to the offline pool only when the fetch _throws_, and the SDK queues rather than failing when the backend is unreachable — so without a deadline a custom game on a dead network waits forever instead of serving cached questions.

---

## 4. Real-time listeners

**REST has no equivalent of `onSnapshot`.** There is a `Listen` RPC in the gRPC API, but not something reachable from a browser with `fetch`. This is the only genuine capability loss, so it deserves a straight look rather than a hand-wave.

**Listener 1 — subscription status.** Gives instant Pro status across tabs. Replaceable with a read on load plus a read after returning from checkout. The UX difference is that a second tab wouldn't update until it was reloaded — for a $0.99/month tier whose only entitlement is an "Add a question" link, that is close to unnoticeable. Note this would also be _cheaper_: a listener bills the initial read plus every change delivered for as long as the tab lives, whereas two reads is two reads.

**Listener 2 — checkout handshake.** Waits up to 20 seconds for a Cloud Function to write back a URL. Replaceable with polling every second for the same 20 seconds. Costs up to ~20 reads per checkout instead of ~2 — irrelevant in absolute terms at this volume, and checkout is rare by definition.

So both are replaceable, and neither replacement is exotic. But note the consequence for sequencing in §9: **a hybrid keeps the SDK in the bundle, so the bundle win only arrives when the last listener goes.**

---

## 5. Offline behaviour and caching

The dimension where the SDK is usually assumed to win, and where this app has already opted out.

|                         | SDK (as configured here)            | SDK (if persistence were enabled) | REST             |
| ----------------------- | ----------------------------------- | --------------------------------- | ---------------- |
| Reads served from cache | within a session, memory only       | across reloads, from IndexedDB    | none built in    |
| Writes while offline    | queued in memory, sent on reconnect | queued durably                    | fail immediately |
| Cost of a repeat read   | free if cached in memory            | free if cached                    | billed           |

Two honest observations:

- **Enabling `persistentLocalCache` is a one-line change** available _without_ any migration. If offline caching is genuinely wanted, that is the cheap experiment, and it should be tried before concluding the SDK is worth 161 kB for it.
- **Queued offline writes are not obviously desirable here.** A leaderboard save that silently succeeds twenty minutes later, after the player has closed the tab, is worse than an error they can act on. The app already surfaces save failures properly (B4, [#57](https://github.com/shermam/trivia/pull/57)).

There is one real regression to weigh: with REST, a repeated read within a session is a billed round trip where the SDK might have served it from memory. For this app's patterns — a leaderboard fetched on the game-over screen, a question bank fetched once per game — that is a handful of reads, and a small `Map` cache in `FirebaseService` would recover most of it.

---

## 6. Cost and quota control

Reads and writes are billed identically by the two APIs. The difference is **visibility and control**, which is where the SDK is genuinely opaque:

- The SDK **retries internally with backoff**, and re-issues listener queries on reconnect. Those reads are real, billed, and invisible from application code.
- A listener that reattaches after a network blip re-reads its result set.
- There is no hook to rate-limit, batch, or refuse a query the SDK decides to make.

With REST, every request is one `fetch` you wrote. You can log it, cache it, coalesce it, back it off on your own terms, or decline to make it. Given that `CLAUDE.md` §4.1 already treats unbounded reads as a billing hazard — and that C1 (`getCustomQuestions` downloading the whole public collection) is still open — that control is worth more here than it would be in a typical app.

**REST wins**, though the practical difference at current traffic is small.

---

## 7. Security, auth, and correctness

- **Security rules apply to both.** REST requests authenticated with a Firebase ID token are subject to `firestore.rules` exactly as SDK calls are. This is worth stating because it is commonly assumed otherwise. The rules suite (144 tests) remains the security boundary either way, unchanged.
- **Token handling becomes manual.** Every REST call needs `Authorization: Bearer <id token>`, from `auth.currentUser.getIdToken()`. That means handling expiry, and the force-refresh dance `AddQuestionComponent` already does for the `stripeRole` claim. The SDK does this invisibly. **A point for the SDK**, and the most likely source of a subtle bug.
- **Wire format is typed and fiddly.** REST represents values as `{"stringValue": "..."}`, `{"integerValue": "7"}`, `{"arrayValue": {"values": [...]}}`, and integers arrive as **strings**. Every read needs decoding and every write encoding. For this app's shapes it is perhaps 80 lines and a table of tests — but it is exactly the kind of code where a silent `"7"` vs `7` mistake reaches `firestore.rules` and fails a write for reasons nobody can see. **The main correctness risk of migrating.**
- **Queries become `structuredQuery` JSON.** `where`/`orderBy`/`limit` map cleanly; nothing this app does is hard to express.
- **App Check**, if ever adopted, integrates with the SDK and would need a manual header with REST.

---

## 8. Testing and tooling

- The Firestore **emulator serves the REST API too**, so `npm run e2e` and the rules suite keep working. The rules tests use `@firebase/rules-unit-testing`, which is SDK-based — that is fine and unaffected, since it tests the rules, not the app's transport.
- REST is **far easier to unit test**: `HttpTestingController` or a `fetch` stub, versus the current pattern of hand-faking the SDK namespace (see `subscription.service.spec.ts`).
- The REST API is **versioned and stable** (`v1`). The SDK has had breaking majors, and each one is a migration.

---

## 9. Recommendation

**Worth doing, but as a complete migration, not a partial one — and not while the audit series is mid-flight.**

The case rests almost entirely on §2: 161 kB gzipped and 546 kB of parse work, for thirteen API symbols and five simple collections, in an app whose own code is 30 kB gzipped. The timeout and quota-control wins are real but secondary; they would not on their own justify the work.

Three things make it more attractive here than it would be in most apps: the API surface is tiny, the document shapes are trivial, and **the SDK's headline feature is already switched off**.

Two things argue for caution: manual token handling and the typed wire format are both places to introduce a quiet bug, and some of this code sits on the payment path.

**The staging matters, because a half-migration is worth nothing.** The SDK ships if any call site still imports it, so the bundle win — the entire point — arrives only with the last one:

1. Build a `FirestoreRestClient` behind the existing `FirebaseService` interface, with the value encoder/decoder covered by a table-driven unit test. No call sites change.
2. Move the one-shot reads and writes: leaderboard, custom questions, product catalogue.
3. Replace the two listeners (§4): status becomes a read on load and after checkout; the handshake becomes a 1s poll bounded at 20s.
4. Delete the SDK import and `giveUpAfter`. **Acceptance criterion: `chunk-BdOPYsvB.js` no longer appears in the network panel on a cold load.**

Rough size: a day or two, most of it on the encoder and its tests.

**Before any of that, do the cheap experiment first.** Turn on `persistentLocalCache` — one line — and see whether the SDK's offline behaviour is worth having. If it is, the calculus in §5 changes and this document should be revisited. If it isn't, the last argument for the SDK is gone and the migration is straightforwardly worth it.

---

## 10. Summary

| Dimension                 | Winner                                     | Weight                 |
| ------------------------- | ------------------------------------------ | ---------------------- |
| Bundle size / parse cost  | **REST** (−161 kB gz, −546 kB parse)       | decisive               |
| Timeouts and cancellation | **REST**                                   | high                   |
| Cost and quota visibility | **REST**                                   | medium                 |
| Testability               | **REST**                                   | medium                 |
| API stability             | **REST**                                   | low                    |
| Real-time listeners       | **SDK** (both uses replaceable)            | medium                 |
| Offline caching           | **SDK** in principle; **not in use today** | low as configured      |
| Token handling            | **SDK**                                    | medium — main bug risk |
| Wire-format safety        | **SDK**                                    | medium — main bug risk |
| Implementation cost       | **SDK** (zero)                             | one-off                |
