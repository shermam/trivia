# Trivia App — Project Overview

A single-page trivia quiz game built with Angular, styled with Tailwind CSS, and backed by Firebase (Firestore for data, Cloud Functions for backend logic, Hosting for deployment). It pulls questions from the public Open Trivia DB API and/or a custom Firestore-backed question bank, runs a timed multiple-choice quiz, and tracks a global high-score leaderboard. A paid **Pro tier** ($0.99/month, via Stripe) unlocks the ability to contribute questions to the shared bank.

Live project: Firebase project `intellectura-3b26a`, served on the custom domain **trivimind.com** as well as the `.web.app`/`.firebaseapp.com` names Hosting provides · Repo: `shermam/trivia`

> Adding another custom domain is not purely a console change: `CUSTOM_APP_ORIGINS` in `functions/src/checkout-request.ts` is the redirect-origin allowlist Stripe checkout is gated on, and it cannot derive a domain it was never told about. See `docs/data-model.md` §3.

---

## The map

This document is the index. The overview itself lives in `docs/`, split by subject — it had reached 148 KB in a single file, more than anyone reads before starting work, so the parts that answer different questions now live apart (finding F5).

| Document                                   | Covers                                                                                                                                                                             | Read it when                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`docs/app.md`](docs/app.md)               | **§1 Application Functionality** — the game flow screen by screen, question sourcing, state management and persistence, auth and the leaderboard, the Pro tier, theme, PWA/offline | You are changing anything under `src/app/` — a component, a route, a service, a guard             |
| [`docs/stack.md`](docs/stack.md)           | **§2 Frameworks, Tools & Libraries** — every dependency and why, the Firebase client wiring, the Cloud Functions backend                                                           | You are adding or upgrading a dependency, touching build/test tooling, or working in `functions/` |
| [`docs/data-model.md`](docs/data-model.md) | **§3 Data Model (Firestore)** — every collection, its schema, its `firestore.rules`, and the reasoning behind each rule                                                            | You are adding a collection or field, changing `firestore.rules`, or writing a query              |
| [`docs/ci-cd.md`](docs/ci-cd.md)           | **§4 Deployment & CI/CD** — Hosting/Functions config, the deploy and preview pipelines, e2e, Lighthouse, npm scripts, environments                                                 | You are changing a workflow, a Firebase config, the e2e or Lighthouse setup, or an npm script     |
| [`docs/known-gaps.md`](docs/known-gaps.md) | **§5 Project History** and **§6 Known Gaps** — how it got here, and what is missing, deferred or accepted                                                                          | You are planning work, or want to know whether something is a bug or a known, accepted gap        |

### Conventions

- **Section numbers did not change.** `§1.5` is still §1.5; it now lives in `docs/app.md`. A reference that crosses documents names the file (`` `ci-cd.md` §4.2 ``), the same way references to `INFRASTRUCTURE.md` and `AUDIT_REMEDIATION.md` always have. A bare `§x.y` means "in this same document".
- **Rationale stays with the thing it explains.** The split is by subject, not "reference here, history there". These documents are long because a paragraph records why something is the way it is and what broke when it wasn't — which is only useful next to the code it is about. Pulling that out into standalone ADRs was the literal reading of F5, and was rejected for exactly that reason; see `AUDIT_REMEDIATION.md` §4.
- **A stale document is a bug.** `CLAUDE.md` §2 requires the relevant file here to be updated in the same PR as the change it describes.

### The other documents in this repo

| Document                 | What it is                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`              | Standing instructions for every session: branching, the verification suite, and §4's contract of invariants that must not regress |
| `INFRASTRUCTURE.md`      | The stack choices as infrastructure, independent of this app — the reference if scaffolding a new project on the same foundations |
| `AUDIT_REMEDIATION.md`   | The 59-finding audit and the PR series that closed it: status, decisions taken, and a narrative per finding                       |
| `UI_INVENTORY.md`        | Every screen, element, state and piece of user-facing copy as implemented — raw material for design work                          |
| `BRAND_DESIGN_SYSTEM.md` | Colors, typography, shadows, radii — the visual system `UI_INVENTORY.md` refers to                                                |
