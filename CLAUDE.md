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

- **Read `PROJECT_OVERVIEW.md` in full first.** It is the source of truth for what this app does, how it's built, its Firestore data model, its Firebase/Stripe integration, and its CI/CD setup. Don't assume — confirm against it before touching code.
- **Read `INFRASTRUCTURE.md`** whenever the task touches build tooling, hosting, CI/CD, or any other infra-layer decision rather than app/game functionality. It documents this project's stack choices (Angular, Firebase, Stripe, Cypress, GitHub Actions, Lighthouse CI, etc.) independently of the trivia app itself, and is the reference to follow if scaffolding a new project on the same infra.

## 2. After making any change

- **Update `PROJECT_OVERVIEW.md`** so it stays accurate: new/changed routes, services, Firestore collections/rules, CI steps, config, or closed items in "Known Gaps." A stale overview is a bug — treat it as part of the change, not an afterthought.
- If the change is to tooling/CI/hosting rather than app functionality, update `INFRASTRUCTURE.md` instead (or in addition).

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
