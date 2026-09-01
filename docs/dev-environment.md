# The development environment

**Read this when:** you are setting up a machine to work on the app, or you are
doing the one-time `trivimind-dev` Firebase setup in §3.

Three environments, and the difference between them is which backend they talk
to. `FEAT-012`.

|                | Backend                                            | Built from                   | How you get it                                                                                        |
| -------------- | -------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Local**      | Firebase emulators, project `demo-trivimind-local` | `environment.development.ts` | `npm start`                                                                                           |
| **Dev**        | The real `trivimind-dev` Firebase project          | `environment.dev.ts`         | `npm run firebase:deploy:dev`, or `npm run start:dev-project` to drive it from a local Angular server |
| **Production** | `intellectura-3b26a`                               | `environment.ts`             | `npm run firebase:deploy`                                                                             |

---

## 1. Why this exists: `npm start` used to run against production

Not a hypothetical, and not a near miss. Until `FEAT-012`:

- `ng serve` defaults to the `development` build configuration, which carried
  **no `fileReplacements`** — so it loaded `environment.ts`: `production: true`,
  `useEmulators: false`.
- `FirebaseAppService` therefore fetched `/__/firebase/init.json`, and
  `src/proxy.conf.json` forwarded that to `https://intellectura-3b26a.web.app`.
- So the local dev server initialised Firebase against **the real project**.
  Every sign-in while poking at a feature, every question submitted to try the
  form, every score saved, went to production.
- `src/environments/environment.development.ts` existed the whole time, never
  substituted, looking exactly like the thing that prevented it.

Nothing was red, and nothing could be: the app worked. That is the problem —
it worked against the users' database. Two more of the same shape:

- `npm run firebase:emulate` passed no `--project`, so Firebase resolved
  `.firebaserc`'s default — the production id. Not a `demo-` prefix, so
  `isDemoProject()` was false and the **mock-checkout gate (audit A7) was off**
  in local emulator runs.
- `firebase-preview.yml` still writes production data on every PR; see §4.

`scripts/verify-environment-isolation.mjs` (`npm run env:verify`, part of the
required `lint` check) is what stops all three coming back.

> **The badge is `sm`-and-up only.** Below that it sat inside the brand link,
> which on a phone is the centre track of a three-column grid already close to
> full: measured at 320px it pushed the brand 32px into the account chip, and
> at 390px it cleared by 2.5px. Nothing would have caught it —
> `mobile-nav.cy.ts` asserts exactly that clearance but runs at 390, and the
> badge never renders in an e2e build at all. On a phone the URL is the signal
> instead: `localhost`, or a `*.web.app` preview channel, neither of which can
> be mistaken for the production domain.

## 2. Working locally

```bash
npm start
```

Starts the Auth, Firestore and Functions emulators under
`demo-trivimind-local` and runs `ng serve` inside them, so the dev server
cannot reach a real backend even if the proxy were misconfigured — with
`useEmulators` set, the runtime-config fetch never happens at all.

Two details that will otherwise cost you an hour:

- **Emulator data is namespaced per project id.** `environment.development.ts`'s
  `emulatorProjectId` and the `--project` in the `start` script have to match.
  A mismatch is not an error; it is an empty database. `npm run env:verify`
  checks they agree.
- **The local project is not the e2e project.** `npm run e2e` runs under
  `demo-trivia-app-e2e` and wipes state between specs. Sharing one id would let
  a test run empty the data you were developing against.

`npm run firebase:emulate` is the other local mode: a full **production** build
served by the Hosting emulator, for exercising the service worker, the CSP
headers and the real `init.json` path. Also pinned to `demo-trivimind-local`.

## 3. Setting up `trivimind-dev` — the manual steps

**These need a human.** Everything above ships without them; nothing below can
be done from the repo.

The guiding principle throughout: **make it a faithful copy.** The whole value
of a dev project is that a change validated there has been validated against
the thing that will run it, so every difference from production is a hole in
that guarantee. The build is already identical — `dev-project` is the
production configuration plus one substitution, and `environment.production` is
read nowhere in `src/` — so the only differences that can creep in are the ones
introduced by hand, below.

### 3.1 The project

1. **Create the project.** Done: `trivimind-dev`.
2. **Blaze plan.** Done. Cloud Functions require it; Spark cannot deploy them
   at all, so a Spark dev project could not validate anything touching
   `functions/`.
3. **Set a budget alert** — Cloud Console → Billing → Budgets & alerts. A dev
   project should cost approximately nothing, and the alert is what tells you
   when "approximately" stops being true. Pay-as-you-go with no ceiling is the
   one part of this setup that can surprise you.

### 3.2 Bring it to parity with production

4. **Enable the same services**: Authentication, Firestore, Hosting, Functions.
5. **Enable the same sign-in providers.** Production offers Google,
   email/password, Facebook, GitHub, Microsoft, Apple, Twitter/X and Yahoo
   (`docs/app.md` §1). Each OAuth provider needs its own client id/secret and
   its own redirect URI on the dev domain — this is the step most likely to be
   half-done, and a provider that works in production and 400s in dev makes dev
   _less_ trustworthy than no dev at all. If you only do some, write down which.
6. **Add the dev domain to Auth → Settings → Authorised domains.**
7. **Deploy rules, indexes and functions:**

   ```bash
   npm run firebase:deploy:dev
   ```

   This builds the `dev-project` configuration and deploys `hosting`,
   `firestore` and `functions` from the same files production uses — so the
   rules, the indexes and the `firebase.json` headers are the same by
   construction rather than by discipline.

   **The CSP is the exception to that, and it is the one worth reading twice.**
   Three of its origins are _named after the Firebase project_: the Auth
   `authDomain` in `frame-src` and `connect-src`, and the Cloud Functions host
   in `connect-src`. Deploying the same header to a second project therefore
   ships a policy that does not describe that project — which is exactly what
   happened, and Google sign-in on `trivimind-dev` was refused for it. Both
   projects are now listed in `scripts/csp-rules.mjs`'s `DEPLOY_TARGETS`, and
   `npm run csp:verify` fails if a target's own origins are missing. **Adding a
   third Firebase project means adding it there**, or its sign-in breaks the
   same way (`ci-cd.md` §4.1).

8. **Stripe test mode.** Create the Pro product and price in Stripe's _test_
   mode, and set the price's `firebaseRole` metadata to `pro` — the claim the
   app gates on comes from that metadata, and an active subscription without it
   grants nothing (audit H6). Then set the dev project's secrets:
   ```bash
   firebase functions:secrets:set STRIPE_SECRET_KEY --project trivimind-dev
   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project trivimind-dev
   ```
   Use the **test-mode** key. The livemode assertion derives which Stripe it is
   talking to from the key itself, not from the project name (audit §4.3), so a
   test key here is not merely safe — it is what makes the check correct.
9. **Point a Stripe test webhook** at the dev project's `stripeWebhook`
   function URL.

### 3.2a What is enabled in `trivimind-dev`, and what is not

**Auth providers: Anonymous, Email/Password and Google.** Production offers
eight; the other five — Facebook, GitHub, Microsoft, Apple, Twitter/X, Yahoo —
are not enabled here.

**That is sufficient for CI and insufficient for one kind of manual check**, so
it is worth being precise about which:

- The preview e2e suite needs **Anonymous** (every visitor gets an anonymous
  uid on load) and **Email/Password** (`sign-in-save-score.cy.ts`,
  `profile.cy.ts`). Both enabled. `service-worker-oauth-origins.cy.ts` looks
  like a third requirement and is not: it checks that the CSP and the service
  worker leave `apis.google.com` reachable, and never performs a sign-in.
- **Validating a change to the "more sign-in options" disclosure cannot be done
  on dev.** Those five providers will fail with `auth/operation-not-allowed`.
  A green dev run says nothing about them — which is the failure mode a dev
  environment is supposed to remove, so it is written here rather than
  discovered.

**Preview channels and OAuth.** Firebase Auth authorises
`trivimind-dev.web.app` and `trivimind-dev.firebaseapp.com` automatically, but
a preview channel is `trivimind-dev--pr-<n>-<hash>.web.app`, which is not
covered and cannot be pre-authorised — the authorised-domains list takes no
wildcards. So **Google sign-in does not work on a preview channel** without
adding that specific domain by hand. This is pre-existing (it was equally true
of production previews) and does not affect CI, which signs in with
email/password.

**Stripe on dev is real, in test mode.** `functions/.env.trivimind-dev` is
deliberately absent: without it `STRIPE_MOCK_CHECKOUT` is unset, so dev calls
the real Stripe API with the test-mode key rather than the deterministic fake
the emulator and e2e use. That is the fidelity choice — dev is where a
checkout change gets validated against Stripe itself. Add the file only if you
want dev to stop talking to Stripe.

**Checkout redirects need no maintenance.** `isAllowedRedirectOrigin` derives
the allowed origins from the project id, so `trivimind-dev.web.app`,
`trivimind-dev.firebaseapp.com` and every `trivimind-dev--*.web.app` preview
channel are allowed automatically. `CUSTOM_APP_ORIGINS` is only the custom
domain, which dev does not have.

### 3.3 Repoint CI (the part with the real exposure)

10. ✅ **Issue a service-account key** for `trivimind-dev` (Project settings →
    Service accounts → Generate new private key) and add it to the repository's
    GitHub Actions secrets as `FIREBASE_SERVICE_ACCOUNT_TRIVIMIND_DEV`.
11. ✅ **Repoint the preview workflow** — done in code, not by hand. All three
    jobs (deploy, e2e, cleanup) now use `trivimind-dev` and the secret from
    step 10, and `cypress/tasks/firebase-preview-tasks.ts` takes the project
    from `FIREBASE_PREVIEW_PROJECT_ID` with **no default** — it throws if the
    variable is missing, and throws again if it is set to production, because
    those tasks hold Admin-SDK credentials and bypass `firestore.rules`.
    `npm run env:verify` fails if the workflow ever names production again.
12. **Leave `e2e.yml` and `lighthouse.yml` alone.** They already run under
    `demo-trivia-app-e2e` on emulators and hold no credential. The spec's claim
    that "CI runs against production credentials" was wrong about these two and
    understated the preview job.
13. **Decide what the smoke test may touch.** `scripts/smoke-test.mjs` currently
    only GETs routes and POSTs an unauthenticated `deleteAccount` expecting a
    401 — read-only and safe against production. Keep it that way, or point it
    at dev; do not let it grow a write while still aimed at production.

### 3.4 What stays production-only

Deliberately, so the list is short and known: `firebase:deploy`, `.firebaserc`'s
default project, and the smoke test's target. Everything else has a dev
counterpart.

## 4. Still open after this

- **Five auth providers are not enabled on dev** (§3.2a). Nothing is broken by
  it; a change to those sign-in paths simply cannot be validated here.
- **Google sign-in does not work on a preview channel** (§3.2a), because the
  channel domain cannot be pre-authorised. Pre-existing, and unrelated to which
  project the channel lives in.
- **Nothing else.** `npm run env:verify` covers the parts that can regress
  silently: a non-production build inheriting the production environment, a
  dev-facing file or a writing workflow naming the production project, an
  emulator id losing its `demo-` prefix, an emulator script losing its
  `--project`.
