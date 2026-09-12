# Trivimind — UI Inventory

This document is a complete, as-implemented inventory of every screen, UI element, and piece of user-facing copy currently in the app, plus every distinct UI _state_ those elements can be in. It exists as raw material for a brand design cookbook and Figma prototypes — it describes **what exists today**, not proposed design.

Source of truth: `src/app/**` (Angular 22, standalone components, Tailwind CSS 4). Cross-check `PROJECT_OVERVIEW.md` for behavioral/backend context.

**Brand name shown in the UI: "Trivimind"** (top bar logo, game-setup title).

The visual design system (colors, typography, shadows, radii) follows `BRAND_DESIGN_SYSTEM.md`. Icons are lucide-derived inline SVG via a shared `IconComponent` (`app-icon`) — see `docs/stack.md` §2.1.

---

## 0. Global shell

Every route renders inside a fixed shell:

```
<app-root>
 ├─ <app-top-bar>          (hidden entirely when ?embed=1 is in the URL)
 └─ <main>
     └─ <router-outlet>    (one of the routed screens below)
```

### 0.1 Top Bar (`TopBarComponent`)

Sticky header, present on every screen except in **embed mode**.

- **Container**: full-width sticky header (64px tall), translucent white, blurred backdrop, bottom hairline border. Inner content max-width constrained and centered.
- **Logo / home link**: gradient (indigo→violet) rounded-square icon mark containing a sparkles glyph, plus text "**Trivimind**" — bold, indigo — links to `/`.
- **Two layouts, one breakpoint at Tailwind `sm` (640px).**
  - **≥ 640px** — the original row: brand on the left; "Review" (reviewers only), "Pricing", the theme toggle and the account trigger on the right.
  - **< 640px** — three zones: a **hamburger button** on the left, the brand **centred**, and the account trigger on the right. "Review", "Pricing" and the theme toggle move into the drawer the hamburger opens; they are the _same_ elements hidden by `sm:` classes, not duplicates.
  - The centring is a `minmax(0,1fr) auto minmax(0,1fr)` grid, so the two side tracks are equal and the brand sits at the true centre of the bar whatever the account chip weighs. `auto 1fr auto` looks right and is not: it centres the brand between its neighbours, which measured 21px off.
- **Nav drawer** (`< 640px` only): left slide-out panel, full viewport height, 18rem wide (max 80%), over a 40%-black backdrop. Holds a "MENU" label and a close (✕) button, then "Review" (reviewers only), "Your stats", "Pricing", and a **"Dark mode" / "Light mode"** button with a sun/moon icon. Following a link closes it; toggling the theme deliberately does not, since the page recolours around you and you may want to change back. "Your stats" is offered to everybody rather than only to signed-in accounts — the page itself explains what a signed-out reader has to do, where a link appearing when auth resolves would shift the rows beneath it.
- **Pricing nav link**: text link "Pricing" → `/pricing`, next to the account trigger at `sm` and above; in the drawer below it. Hovering or focusing it starts fetching what the pricing page needs, so the page it opens has a price on it already — the same is true of every other route into `/pricing` ("Upgrade to Pro to add questions" in the auth menu, "See Pro" on the daily-limit notice, "Upgrade to Pro" on the add-question gate). Nothing visible happens; see `docs/app.md` §1.6.
- **Account trigger, every viewport: the avatar alone.** The display name and PRO badge are `sr-only` rather than removed — taking them out of the DOM would leave the button announced as a single letter, and a screen reader still reads "B Bartholomew Featherstonehaugh PRO". A signed-in chip is 42px on a phone and 70px with the chevron above `sm`, and it is the same width while auth is still settling, so it never moves. This was a phone-only rule until the desktop exception turned out to be the last layout shift: the name arrives when auth resolves and the PRO badge a beat later when the Stripe claim does, which at 1024px moved a 123.4px skeleton to 104.4px (short name), 144px (short name + PRO) or 277.5px (a 29-character name). Reserving space instead was measured and rejected — a slot sized to "Sign in" fits four characters and an ellipsis; a slot sized to the widest name leaves a signed-out user looking at ~150px of nothing. The anonymous state keeps its visible "Sign in" text, which is short and is a call to action rather than a label.
- **Account trigger: the chip widens on a phone when it resolves to "Sign in".** Below `sm` the chip has exactly two widths — avatar-only (42px) and avatar-plus-"Sign in" (95px) — and everything except the signed-out state is the first, so the movement only ever widens and only ever happens when there is something to offer. A returning player's chip resolves without moving; a signed-out one grows a call to action in the corner of the eye. Animated by transitioning the label region's `max-width` from `0` to a 4rem cap (a content-driven `width: auto` has no property to transition), gated on `motion-safe:`, 600ms ease-out — the cap and duration are paired, because the motion stops as soon as the cap passes the label's own width. At `sm` and above nothing moves: the skeleton bar is already the width of the label it becomes.
- **Account trigger** (pill button, top-right, bordered): its content depends on auth state (see §0.1 States below); chevron-down icon on the right that rotates 180° when the dropdown is open.
  - Opens/closes the **Auth Menu** dropdown (`AuthMenuComponent`), anchored top-right below the trigger.

#### Account trigger — states

| State                                        | Visual                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Text/content                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Auth not ready yet** (`authReady()` false) | A **pulsing avatar-sized grey circle**, and nothing else, at every viewport — the exact shape and width of the signed-in chip it usually becomes, so the common case resolves without moving. Not the word "Loading…", which rendered 34px tall against 42px for every resolved state and changed the chip's height the moment auth settled. A width-reserving skeleton **bar** stood here while the resolved chip still showed a name; it would now reserve room for something that never arrives. If the answer turns out to be "signed out", the chip widens into "Sign in" — see the animation note above. | "Loading…", `sr-only`, plus `aria-busy` on the trigger |
| **Anonymous**                                | Grey circular avatar with a person glyph (👤)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | "Sign in"                                              |
| **Signed in** (any real account)             | Emerald circular avatar showing the user's **initials** (first letter of display name or email, uppercased; falls back to "?"). No visible label at any width.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Display name (or email if none set), `sr-only`         |
| **Signed in, PRO**                           | Same as above, plus an **`emerald-400` ring** around the avatar (a `ring`, i.e. a box-shadow, so it costs no layout width). It replaced a PRO pill next to the name, which was worth 20.6px and landed a beat after the name — a second shift of its own.                                                                                                                                                                                                                                                                                                                                                      | "PRO", `sr-only`                                       |
| **Signed in, email unverified**              | Small amber dot badge overlaid on the bottom-right corner of the avatar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                      |

### 0.2 Auth Menu (`AuthMenuComponent`) — dropdown panel

A single panel (white card, rounded-2xl, shadowed, ~320px wide, small "x" close button top-right in every state) whose _entire contents_ switch based on auth state. Also reused (opened programmatically) from the "Sign in" buttons on Game Over and Add a Question screens.

#### State A — Signed out / anonymous

- **Heading**: "Sign in" (or "Create an account" when in sign-up mode — see below)
- **Button**: "Continue with Google" (Google "G" logo icon + label) — full width, outlined
- **Divider**: horizontal rule with centered "or" label
- **Email form**:
  - Input — placeholder "Email", type `email`, required
  - Input — placeholder "Password", type `password`, required, min length 6
  - Submit button: label depends on mode —
    - Sign-up mode: "Sign up"
    - Sign-in mode: "Sign in"
    - While submitting: "Please wait…" (disabled)
- **Mode toggle link** (text button, small, indigo):
  - In sign-up mode: "Already have an account? Sign in"
  - In sign-in mode: "Don't have an account? Sign up"
- **"More sign-in options" disclosure** (text button, small, grey, top-bordered):
  - Collapsed label: "More sign-in options"
  - Expanded label: "Hide other sign-in options"
  - When expanded, reveals a 2-column grid of secondary provider buttons, each with a brand icon + label:
    - Facebook, GitHub, Microsoft, Apple, "Twitter / X", Yahoo
- **Inline error banner** (red, appears only on failure) — one of the friendly auth error strings (see §5 Error Copy)
- **Inline success/info banner** (green, appears only after an action):
  - After sign-up: "Account created! We've sent a verification link to your email."

#### State B — Signed in, email/password account, **not yet verified**

- **Heading**: "Verify your email"
- **Body text**: "We sent a verification link to **{{ email }}**. Verify it to finish signing in and save scores to the leaderboard."
- **Button**: "Resend verification email" (outlined, full width)
- **Text link/button**: "Sign out" (small, grey, centered)
- **Inline error banner** (red): "Could not send the verification email. Please try again." (only on resend failure)
- **Inline success banner** (green): "Verification email sent — check your inbox." (only after a successful resend)

#### State C — Fully authenticated (profile management)

- **Heading**: "Your profile"
- **Field label**: "Display name"
- **Input** (text, prefilled with current display name, max 30 chars) + **"Save" button** (indigo) alongside it — on a successful save, the button transiently shows a checkmark + "Saved!" (green) for 2 seconds before reverting
- **Account email line**: shows the account's email; if it's a password account, appends "✓ Verified" (green)
- **Link**: "Your stats" (outlined, full width, trophy icon) — routes to `/profile` (§8)
- **Link/button**: "Add a question" (outlined, full width) — routes to `/add-question`; carries a **PRO badge** next to the label (indigo/filled if the user is Pro, grey/muted if not)
- Below that, one of:
  - Not Pro: text link "Upgrade to Pro to add questions" → `/pricing`
  - Pro: text button "Manage subscription" (label becomes "Opening billing portal…" and disables itself while the Stripe Billing Portal redirect is being prepared)
- **Button**: "Sign out" (outlined, full width)
- **Inline error banner** (red), shown only on failure, e.g.:
  - "Could not update your name. Please try again."
  - "Could not open the billing portal. Please try again." — only when `SubscriptionService` could not explain the failure; when it could, its own message shows instead: "Sign in before managing your subscription.", "Too many attempts just now. Reload the page and try again in a few minutes.", "Timed out waiting for the billing portal to open. Please try again.", or whatever `createPortalSession` wrote back

---

## 1. Route: `/` — Game Setup (`GameSetupComponent`)

Full-screen centered card on an indigo/purple gradient background.

### Hierarchy

- **Title**: "Trivimind" (large, bold, indigo, centered)
- **Subtitle**: "Configure your quiz and test your knowledge" (centered, grey)
- **Inline warning banner** (amber) — only if categories failed to load: "Could not load categories from Open Trivia DB. You can still start with \"Any Category\"."
- **Inline error banner** (red) — only if a previous game-start attempt failed: shows the game controller's load-error message (e.g. no questions found for the filters, network failure)
- **Form**
  - **Field: "Number of Questions"** — `<select>` labeled "Number of Questions"; options: `5`, `10`, `15`, `20`, `25` (default 10)
  - **Field: "Category"** — `<select>` labeled "Category"; first option "Any Category", then every category name fetched live from Open Trivia DB
  - **Field: "Difficulty"** — `<select>` labeled "Difficulty"; options: "Any Difficulty" (default), "Easy", "Medium", "Hard"
  - **Field: "Question Source"** — labeled "Question Source"; a 3-segment button-style radio group:
    - "Open Trivia" (default selected)
    - "Custom"
    - "Mixed"
    - Selected segment is visually distinguished (indigo border + light indigo fill)
  - **Submit button**, full width, indigo:
    - Default label: "Start Game"
    - While loading questions: "Loading Questions…" (disabled)
- **Footer link**: "+ Create custom question" → `/add-question`, with a **PRO badge** next to it (indigo/filled if the current user is Pro, grey/muted otherwise)

### States

| State                                                | Effect                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Initial load                                         | Categories fetch in background; form usable immediately with "Any Category"                                            |
| Categories fetch failed                              | Amber inline warning shown; category dropdown just shows "Any Category"                                                |
| Form submitted while invalid                         | Validation errors marked (all fields touched); no navigation                                                           |
| Submitting (`gameController.isLoading()`)            | Submit button disabled, label → "Loading Questions…"                                                                   |
| Game start failed — no questions matched the filters | Red inline error: "No questions were found for the selected options. Try a different category, difficulty, or source." |
| Game start failed — network/fetch error              | Red inline error: "Failed to load questions. Please check your connection and try again."                              |
| Success                                              | Navigates to `/play`                                                                                                   |

---

## 2. Route: `/play` — Quiz Loop (`QuizLoopComponent`)

Full-screen centered card on a light slate background. **Guard**: if there's no active question in memory, immediately redirects to `/` (renders nothing in that instant).

### Hierarchy (per question)

- **Status row** (3 items, spaced across the top, border-bottom):
  - Left: "Question **{{ currentIndex + 1 }}** / **{{ totalQuestions }}**"
  - Center: "Score: **{{ score }}**" (indigo) — a point total, not a count of right answers: streak multipliers can carry it past the number of questions
  - Right: circular SVG ring timer (progress ring drains as `timeLeft` counts down) with the seconds-remaining number (e.g. "12s") centered inside it
- **Progress bar**: thin full-width bar under the status row — shows **overall quiz completion** (`currentIndex / totalQuestions`), filling left-to-right as questions are answered (distinct from the per-question countdown, which the ring now conveys on its own)
- **Badges row** (wraps; every pill is present on every question, so it wraps the same way throughout a round):
  - Category badge (indigo pill, uppercase, e.g. "GENERAL KNOWLEDGE")
  - Difficulty badge (grey pill, uppercase, e.g. "MEDIUM")
  - **Streak badge** (flame icon + the run + the multiplier, e.g. "🔥 3 ×1.5") — rendered on every question and merely `invisible` until the run reaches two, so it cannot re-wrap the row mid-question. Its colour is the tier: grey at ×1.0, amber at ×1.5, orange at ×2.0, red and `motion-safe:` pulsing at ×3.0. The run sits in a two-character `tabular-nums` slot and the multiplier is always written to one decimal, so the pill is the same width in every state. `aria-hidden`; an `sr-only` `role="status"` region announces a tier change (and only a tier change) in words.
- **Question text** (large, bold heading)
- **Answer grid**: 2-column grid (stacks to 1 column on small screens) of answer buttons, one per `all_answers` entry (2 for true/false, 4 for multiple-choice); each button has a leading letter badge (A/B/C/D by position) plus the answer text
- **Lifelines toolbar**: a labelled button group of two or three buttons, below the answer grid (see below)
- **Result feedback banner** (last in the card, below the lifelines toolbar): a coloured strip with an emoji and one of three fixed messages — 🎉 "Correct! Well done.", ⏰ "Time's up!", ❌ "Incorrect." Its space is **reserved from the first render**, empty until there is a result, because the card is vertically centred and a banner that appeared on answering lifted the whole card by half its height (measured at 43px on a 390×1000 phone, 37px at 1024×900). All three messages are stacked in one grid cell so the reserved height is the tallest of them rather than a hard-coded guess.
  - The messages deliberately **do not name the correct answer**, which is what used to make the banner's height depend on the question — a long answer wrapped to a second line. On screen it is redundant: the correct option keeps an emerald border and badge while every other option drops to 60% opacity. They also carry no pointer to that highlight ("the answer is highlighted", "see the green answer"), because every such phrasing wraps at 320px and the reserved space would then cost a permanent second line on every phone.
  - `aria-hidden`, because the permanent `role="status"` region is the accessible channel and **does** speak the answer in full.

### States

| State                               | Timer ring / bar color                    | Answer buttons                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Countdown, >5s left**             | Indigo ring + number, indigo progress bar | All enabled; default styling (white bg, slate border; indigo hover tint)                                                                                                                           |
| **Countdown, ≤5s left**             | Red ring + number                         | Same as above (still answerable)                                                                                                                                                                   |
| **Timer hits 0 (no answer chosen)** | Locks at 0                                | Auto-submits a "no answer" — same as an incorrect answer, no option highlighted green except the correct one                                                                                       |
| **Answer selected — correct**       | frozen                                    | Selected/correct button (and its letter badge) turns **green**; all other buttons disabled                                                                                                         |
| **Answer selected — incorrect**     | frozen                                    | Chosen button (and its letter badge) turns **red**; the actual correct answer turns **green**; all remaining (non-chosen, non-correct) buttons dim to 60% opacity, grey text; all buttons disabled |
| **Post-answer delay (2s)**          | —                                         | Result banner + colors stay visible for 2 seconds before auto-advancing (the banner's box was already occupying its space before the answer, so nothing moves)                                     |
| **Advance**                         | —                                         | Either the next question loads (ring/buttons reset to the countdown state) or, if it was the last question, navigates to `/game-over`                                                              |

Score only increases on a correct answer, by one base point **times the active streak multiplier**: 1–2 in a row score ×1.0, 3–4 score ×1.5, 5–7 score ×2.0, 8 or more score ×3.0. A wrong answer or a timeout resets the run; a skip neither breaks nor extends it. A timeout and a skip both score zero and both still count toward the total.

### Lifelines toolbar

A labelled button group (`role="group"`, "Lifelines") **below the answer grid**, present on every question, so the card reads question → answers → help and the lifelines are within reach without standing between a question and its options. It is placed there in the markup rather than by CSS, so Tab and a screen reader meet the answers first too. Each lifeline is single-use per round; a spent one greys out and stays in place, so the row cannot change size mid-game. An `sr-only` `role="status"` region announces each use — the visible change is options greying out or a number jumping, which is silent to a screen reader.

| Button                  | Does                                                          | Unavailable when                                                                                        |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **50/50** (percent)     | Removes two wrong options (one, on a three-option question)   | **Disabled** on true/false, where removing anything hands over the answer; **disabled** once spent      |
| **+15s** (clock-plus)   | Adds 15 seconds to this question's countdown                  | **Not rendered at all** on an unlimited game — there is no countdown to extend; **disabled** once spent |
| **Skip** (skip-forward) | Straight to the next question — no result banner, no 2s pause | **Disabled** once spent                                                                                 |

- **Removed options stay in the grid**, muted and unclickable, rather than being taken out — collapsing four cells to two moves the surviving answers under the reader's cursor as they are reading them.
- **Hidden vs disabled follows one rule**: a reason that can change from question to question disables the button, because hiding it would resize the toolbar mid-round. Only Extra Time is hidden, and only because its reason (an unlimited game) is fixed before question 1.

#### Result feedback banner (per outcome)

| Outcome                         | Banner     | Message                                                  |
| ------------------------------- | ---------- | -------------------------------------------------------- |
| Correct                         | Green (🎉) | "Correct! Well done."                                    |
| Timed out (no answer)           | Red (⏰)   | "Time's up! The answer was {{ correct_answer }}."        |
| Incorrect (wrong answer picked) | Red (❌)   | "Incorrect. The correct answer is {{ correct_answer }}." |

---

## 3. Route: `/game-over` — Game Over (`GameOverComponent`)

Full-screen centered card on a light slate background. **Guard**: if there's no completed game in memory (`totalQuestions() === 0`), immediately redirects to `/`.

### Hierarchy

- **Header card**: amber-gradient trophy icon badge, "Game Over!" (large, bold, dark, centered), subtitle "Here's how you did" (centered, grey)
- **Score summary** (four stat blocks in a 2×2 grid, on their own light-slate sub-cards; all four render in every state):
  - "**{{ score }}**" — label "Score", caption "points". The multiplied total, so it can exceed the question count
  - "**{{ percentage }}%**" — label "Accuracy", plus a derived performance label/color: "Outstanding!" (green, ≥90%) / "Great job!" (indigo, ≥70%) / "Good effort!" (amber, ≥50%) / "Keep practicing!" (red, <50%). Never multiplied, so never above 100%
  - "**{{ correctAnswers }}** / **{{ totalQuestions }}**" — label "Correct", caption "correct answers"
  - flame icon + "**{{ maxStreak }}**" — label "Best streak", caption "in a row"
- **Save-score area** — content depends on auth state (see States below)
- **Section heading**: "Top 10 Leaderboard" (with a medal icon)
- **Leaderboard list** — content depends on load state (see States below); each row: rank (🥇/🥈/🥉 for top 3, "#N" otherwise), gradient avatar circle with the player's initials, name, "{{ score }} pts · {{ percentage }}%" (`tabular-nums`, `shrink-0`, so a three-digit score narrows the name rather than reshaping the row — old unmultiplied entries and new multiplied ones share the board indefinitely). The current player's own row (matched by `uid`) is highlighted (indigo tint + left border) and tagged with a "YOU" badge, if present in the fetched top 10.
- **"Review answers" card** (collapsible, collapsed by default) — header button reading "Review answers (X/N correct)" with a rotate icon and a chevron that flips on open. Expanded, it lists one row per question of the round: a numbered pill (emerald if the answer was right, red if not), the question text, category and difficulty badges, the player's pick with a check/cross/clock icon, and — only when the pick was wrong or the clock ran out — the correct answer on a second line with a check icon. A timed-out question also carries an amber "Time expired" badge, and a skipped one (`FEAT-002`) a grey "Skipped" badge with "You skipped this" in place of a pick. Where a contributed question carries them (`FEAT-022`), the row ends with its **source** — an external-link glyph and a link opening in a new tab — and its **Justification**, a tinted block headed "Justification" holding the contributor's prose; neither renders on a question with none, which is every Open Trivia DB question and most contributed ones. The whole card is absent unless the recorded answers cover the whole round.
- **Button**: "Play Again" (full width, dark slate, reset icon) — resets all in-memory game state, navigates to `/`

### States — Save-score area

| State                                                                                     | Content                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Already saved this session, no error**                                                  | Green success banner: "Score saved to the leaderboard!", plus "You're ranked #N on the leaderboard." if (and only if) the player's own entry is present in the fetched top 10 — no rank is claimed otherwise              |
| **Already saved this session, but with a non-fatal note** (e.g. existing best was higher) | Amber banner with the specific message, e.g. "Your best score is already higher (12 points) — nice consistency! We kept your existing best."                                                                              |
| **Anonymous player**                                                                      | Indigo info box: "Sign in to save this score to the leaderboard." + **"Sign in" button** (hidden entirely in embed mode) that opens the Auth Menu                                                                         |
| **Signed in but not fully authenticated** (unverified email)                              | Indigo info box: "Verify your email to save this score to the leaderboard." + **"Resend verification email" button**                                                                                                      |
| **Fully authenticated, not yet saved**                                                    | Form: text input (placeholder "Enter your name", prefilled from profile display name, max 30 chars, required) + **"Save Score" button** (disabled while saving or while name is blank; label → "Saving…" while in flight) |
| **Save failed** (generic)                                                                 | Red inline error: "Could not save your score. Please try again."                                                                                                                                                          |

### States — Review answers card

| State            | Content                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **No recap**     | The card does not render at all — no answers recorded for this round (e.g. a game restored from a save written before the feature existed)      |
| **Collapsed**    | Header button only; `aria-expanded="false"`, panel not in the DOM                                                                               |
| **Expanded**     | Header button (`aria-expanded="true"`) plus the `<ol>` of question rows                                                                         |
| **Row: right**   | Emerald number pill, emerald pick line with a check icon, no second line                                                                        |
| **Row: wrong**   | Red number pill, red pick line with a cross icon, emerald "correct answer" line below it                                                        |
| **Row: expired** | Red number pill, amber "Time expired" badge among the meta badges, grey "No answer" line with a clock icon, emerald correct-answer line         |
| **Row: skipped** | Red number pill, grey "Skipped" badge with a skip-forward icon among the meta badges, grey "You skipped this" line, emerald correct-answer line |

### States — Leaderboard list

**The board is ten rows tall in every state**, because ten is known before the data is — it is the `limit` passed to `getTopScores`. It used to be one line while loading that became up to ten rows, a **508px** jump (68px → 576px) landing exactly as a player reads their final score. Three kinds of row, all built from the same box so their heights cannot drift apart: real entries, pulsing skeletons, and invisible fillers for slots the board has not reached. Only the entries are in the accessibility tree; the other two are `aria-hidden` decoration, with an `sr-only` `role="status"` region carrying their meaning in words.

| State          | Content                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Loading**    | **Ten pulsing skeleton rows** (rank pill, avatar circle, name bar, score bar); `sr-only` status reads "Loading leaderboard…" |
| **Load error** | Red message "Could not load the leaderboard. Please try again later.", centred **over** ten reserved rows                    |
| **Empty**      | Grey message "No scores yet. Be the first!", centred **over** ten reserved rows                                              |
| **Loaded**     | Ranked list (1–10), refreshed automatically after a successful save; any unfilled slots become invisible filler rows         |

---

## 4. Route: `/add-question` — Add a Question (`AddQuestionComponent`)

Full-screen centered card on a light slate background. Reachable via the game-setup footer link and the Auth Menu profile section (both show a PRO badge).

### Hierarchy

- **Title**: "Add a Question" (large, bold, indigo, centered)
- **Subtitle**: "Contribute a question to the shared custom bank" (centered, grey)
- Below the header, exactly **one** of five mutually exclusive states renders (see below).

### States (in the order the template checks them)

**A — Anonymous**

- Indigo info box: "Sign in to submit a question to the shared bank." + **"Sign in" button** → opens Auth Menu

**B — Signed in, not fully authenticated (unverified email)**

- Indigo info box: "Verify your email to submit a question." + **"Resend verification email" button**

**C — Fully authenticated, not a Pro subscriber** (empty-state upsell)

- Gradient (indigo→violet) icon badge (sparkles glyph)
- Heading: "This one's for Pro members"
- Body: "Upgrade to Pro to create and add your own questions to the shared question bank." (no amount — Pro is priced per currency and only `/pricing` reads the catalog)
- **"Upgrade to Pro" button** (indigo) → navigates to `/pricing`

**D — Fully authenticated + Pro, just submitted successfully**

- Green success box: "Thanks! Your question has been submitted for review."
- Two buttons side by side:
  - "Add another" (indigo) — resets the form back to state E
  - "Back to game" (outlined) — navigates to `/`

**E — Fully authenticated + Pro, form**

- **Field: "Category"** — free-text input, placeholder "e.g. Science", with a `<datalist>` of suggestions sourced from the cached Open Trivia category list
- **Field: "Difficulty"** — `<select>`; options "Easy", "Medium", "Hard" (default "Medium")
- **Field: "Question Type"** — 2-segment button-style radio group: "Multiple Choice" (default) / "True / False"
- **Field: "Question"** — `<textarea>` (3 rows), placeholder "What is the question?"
- **Conditional answer fields**, depending on Question Type:
  - **True / False**: "Correct Answer" 2-segment button radio group: "True" / "False" (incorrect answer auto-derived as the opposite)
  - **Multiple Choice**:
    - "Correct Answer" — single text input
    - "Incorrect Answers" — three text inputs, placeholders "Incorrect answer 1", "Incorrect answer 2", "Incorrect answer 3"
- **Field: "Source link" (optional)** — `type="url"` input, placeholder "https://en.wikipedia.org/wiki/...", with helper text "Where the answer comes from. Reviewers see it, and so do players after they answer."
- **Field: "Source name" (optional)** — text input, placeholder "MDN Web Docs, CRC Handbook 95th ed., …"
- **Field: "Justification" (optional)** — `<textarea>` (3 rows), placeholder "Why is the right answer right, and why are the others wrong?", with helper text "Only needed for a tricky question — where knowing the subject still isn't enough to see why the right answer is right. Reviewers see it, and so do players after they answer."
  - Each of the three is labelled with an "(optional)" suffix in normal weight, and shows its own red error line beneath on submit ("Source link has to be a full address starting with https://.", "… must be N characters or fewer.")
- **Inline error banner** (red), shown only on submit failure: "Could not save your question. Please try again."
- **Buttons**:
  - "Cancel" (outlined) → navigates to `/`
  - "Add Question" (indigo, flex-1) — disabled while submitting; label → "Saving…" while in flight

---

## 5. Route: `/review` — Review Queue (`ReviewQueueComponent`)

Full-screen centered card. **No route guard** — access is decided in-page from `ReviewerService`, so a non-reviewer reaching the URL gets an explanation rather than a silent redirect. The top bar's "Review" link only appears for reviewers.

### Hierarchy

- **Back link**: "← Back to game" → `/`
- **Title**: "Review Queue"
- **Status filter**: a labelled tab group (`sr-only` heading "Filter by status") with **Pending / Approved / Rejected**; the active tab is filled, the others outlined
- **Question list**: one card per question in the active status — question text, its answers with the correct one marked, then `Category:` / `Difficulty:` / `Submitted:` / `Author:` metadata, and below that the contributor's optional **source** (an external-link glyph and a link opening in a new tab, labelled with the source name, followed in muted grey by the URL's hostname — the reviewer is shown where the link goes, not only what the contributor called it; the hostname alone is the label when no source name was given) and **Justification** (a tinted block headed "Justification" holding the contributor's prose). Neither renders when the question carries none, which is the usual case
- **Action buttons** per card: **Approve** (hidden on the Approved tab) and **Reject** (hidden on the Rejected tab), so the button that would be a no-op is never offered
- **Truncation note** when the queue is full — the query is capped, and the list says so rather than implying it is the whole queue

### States

| State                           | Content                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Access still resolving**      | "Checking your access…" — the neutral state, shown before the role is known rather than guessing either way |
| **Not a reviewer**              | An explanation that the queue is for reviewers, with a way back to the game                                 |
| **Loading the queue**           | "Loading…"                                                                                                  |
| **Load failed**                 | An inline error with a retry affordance                                                                     |
| **Empty for the active status** | An empty-state message for that tab                                                                         |
| **Loaded**                      | The question list                                                                                           |
| **Action failed**               | An inline error above the list; the card stays put so the action can be retried                             |

---

## 6. Routes: `/privacy` and `/terms` — Legal pages (`PrivacyPolicyComponent`, `TermsOfServiceComponent`)

Two documents sharing one shell (`LegalPageComponent`), which supplies the chrome and takes the body as content. No guard, no auth, no data — they render the same for everyone.

### Hierarchy

- **Back link**: "← Back to Trivimind" → `/`
- **Title** and, under it, "Last updated: {{ LEGAL_LAST_UPDATED }}"
- **Amber `role="note"` banner**: "In force, but not yet reviewed by a lawyer" — states that the document applies today and was written by reading the source, that what it lacks is professional review, and invites corrections by email. Rendered from a single flag, so it disappears from both pages at once when that stops being true.
- **Body**, in a `prose-legal` block
- **Footer line** crediting the structure and tone the documents were adapted from

**`/privacy` sections**: Who is responsible for your information · Information you give us · Information created by using the app · Why we handle it, and on what basis · Payments · What is stored on your device · Who else your browser contacts · What we do not do · Where your information is stored · How long we keep it · Your rights over your information · Children · How your information is protected · Changes to this policy · Contact

**`/terms` sections**: The service · Who can use it · Your account · Questions you contribute · Acceptable use · Pro subscription · Availability and liability · Ending your use · Governing law · Changes to these terms · Contact

> These two are the only documents in the repo whose correctness decays without anyone touching them — a change to what the app stores, or to which hosts it contacts, falsifies them silently. `CLAUDE.md` §4.0 is the contract; the operating company's name and CNPJ live in `legal.ts` and are pinned by `legal-pages.spec.ts`.

---

## 7. Route: `/pricing` — Pricing (`PricingComponent`)

Full-width page (not a single centered card — a two-column comparison layout) on a light slate background.

### Hierarchy

- **Title**: "Pricing" (large, bold, indigo, centered)
- **Subtitle**: "Play free forever, or go Pro to contribute your own questions." (centered, grey)
- **Checkout status banner** — only present right after returning from Stripe Checkout (see States)
- **Two plan cards, side by side** (stack on small screens):

A "← Back to game" link (→ `/`) sits above the header.

#### Starter card

- Icon badge (slate, zap glyph)
- Heading: "Starter", subtitle "Everything you need to play and compete."
- Price: "$0" + "/month"
- Feature list (green check-circle icons):
  - "Play unlimited games"
  - "Submit scores to the global leaderboard"
- Footer badge (only shown while the viewer is **not** Pro): "Your current plan" (outlined, muted, check icon)

#### Pro card

- Gradient top accent bar; corner badge "PRO" (indigo pill, top-right)
- Icon badge (indigo→violet gradient, sparkles glyph)
- Heading: "Pro", subtitle "Contribute questions and shape the game."
- Price: the amount in the selected currency (e.g. "$0.99" or "R$ 5,90") + "/month". Read from the mirrored Stripe catalog and formatted with `Intl.NumberFormat` in that currency's own locale — never a literal, since Pro carries one Stripe Price per currency. An em-dash ("—") holds the line until the catalog answers, so the row keeps its height. **A returning visitor never sees the em-dash**: the catalog and the country are kept in `localStorage` for a day, so the amount, the currency and the switch are all on the first frame and are corrected in place if the background re-read disagrees. See `docs/app.md` §1.6
- **Currency row**: caption "Currency" on the left, and on the right either a two-option segmented control (`role="radiogroup"` labelled by that caption; one `<label>`-wrapped `sr-only` radio per currency, showing the uppercase ISO code — "USD", "BRL") when more than one currency is on sale, or the single currency's code when there is only one. Rendered in every state, including while the catalog is still loading (where the cell is empty), and always on the same muted rounded pill with the same padding — so the card neither grows nor grows a control when the catalog lands, it only fills one that was already there
- **Which currency starts checked** is not a preference the reader set — it is where the app believes they are: the app's own server (`/api/geo`), else the browser's time zone, else the catalog's default. A Brazilian visitor therefore lands on BRL without touching anything, which is the point, because a Brazilian card presented dollars is declined rather than merely surprising. The server's answer can arrive up to two seconds after the control does, and when it does it moves the checked radio and re-renders the amount, nothing else — unless the reader has already clicked, in which case their choice stands. See `docs/app.md` §1.6
- Feature list (green check-circle icons, last item styled as "coming soon" with a muted icon instead of a check):
  - "Everything in Starter"
  - "Create and add custom questions to the global question bank"
  - "More features coming soon"
- Footer area — content depends on subscription state (see States below)
- Inline error banner (red), only on subscribe/checkout failure
- Footer note below both cards: "Cancel anytime. No hidden fees."

### States — checkout status banner (from `?checkout=success|cancelled` query param)

| State                | Content                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout=success`   | Green banner: "Subscription started! It may take a few seconds to finish activating." + "Start playing" link (→ `/`) + "Dismiss" button |
| `checkout=cancelled` | Amber banner: "Checkout was cancelled — no charge was made." + "Dismiss" button                                                         |
| No query param       | No banner                                                                                                                               |

### States — Pro card footer / Subscribe button

| State                              | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Already subscribed (Pro)**       | Green box: "✓ You're subscribed" (Starter's "Your current plan" label is hidden in this state so only one card claims to be current)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Auth not ready yet**             | Button disabled, label "Loading…"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Not signed in (anonymous)**      | Button label "Sign in to subscribe" — clicking opens the Auth Menu instead of starting checkout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Signed in, unverified email**    | Clicking shows red error: "Verify your email first, then come back to subscribe."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Redirecting to Stripe Checkout** | Button disabled, label "Redirecting…". For an eligible reader (signed in, verified, not Pro) the Checkout Session was created in the background a second after the currency settled, so this state lasts a frame rather than several seconds; it is only a real wait when the session had to be created on the click. See `docs/app.md` §1.6                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Ready to subscribe**             | Button label "Subscribe — {amount}/mo" (e.g. "Subscribe — $0.99/mo", "Subscribe — R$ 5,90/mo"); plain "Subscribe" while the catalog has not answered, rather than quoting a placeholder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Checkout start failed**          | Red inline error naming the cause when `SubscriptionService` verified one — "Sign in before subscribing.", "Pro isn't available to buy right now — no active monthly Pro price is set up. Please try again later.", "Too many attempts just now. Reload the page and try again in a few minutes.", "Timed out waiting for Stripe checkout to start. Please try again.", or the message `createCheckoutSession` wrote back (e.g. "Could not start checkout. Please reload the page and try again.", or "Your account is already set up to pay in {currency}, so Pro can only be bought in {currency} from this account." when Stripe has this customer committed to one currency) — and "Could not start checkout. Please try again." otherwise |

---

## 8. Route: `/profile` — Your stats (`ProfileStatsComponent`)

A single card on a light slate background. **No route guard** — access is decided in-page, so an anonymous visitor gets an explanation rather than a silent redirect, the same choice `/review` and `/add-question` make.

### Hierarchy

- **Back link**: "← Back to game" → `/`
- **Title**: "Your stats", with a subtitle — "Your lifetime totals across every game you have finished while signed in. Only you can see them."
- **Status line**: one line inside the card, above the numbers, saying which state the card is in (below)
- **Stat grid**: five tiles — **Games played**, **Questions answered**, **Correct answers**, **Accuracy**, **Best streak** — each an icon, a small grey label and a large number. Two columns on a phone, three at `sm` and above.
- **Action**: exactly one button per state, below the grid

### States

| State                      | Status line                                                                                        | Numbers    | Action       |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ---------- | ------------ |
| **Auth still resolving**   | "Loading your lifetime totals…"                                                                    | all "—"    | Start a game |
| **Signed out / anonymous** | "Sign in and your totals start counting from the next game you finish."                            | all "—"    | Sign in      |
| **Read in flight**         | "Loading your lifetime totals…"                                                                    | all "—"    | Start a game |
| **No games banked yet**    | "Nothing banked yet — finish a game and your totals will show up here."                            | all "—"    | Start a game |
| **Loaded**                 | "Tracking since {{date}}." (or "Tracking your lifetime totals." when the document carries no date) | the totals | Start a game |
| **Read failed**            | "Could not load your stats just now." (red)                                                        | all "—"    | Try again    |

**Every state is the same height**, and the construction is what makes that true rather than a measurement: each number is rendered from first paint as an em-dash, the five distinct status sentences are stacked in one grid cell so the space reserved is the tallest of them, and the three actions are one grid cell holding the same button box three times. Accuracy shows "—" rather than "0%" when no questions have been answered — `0 / 0` is `NaN`.

Two details a test has to know about. **"Sign in" is not rendered under `?embed=1`** (§9.7) — it opens the top bar's auth menu, and an embed has no top bar; the signed-out state is then the sentence alone, at the same height. And **"Try again" hands focus to the status line before it re-reads**, because the retry puts the card back into its loading state and hides the button that was focused; the status line is where the answer to the retry appears, and "Try again" is one Tab away from it if the second read fails too.

---

## 9. Cross-cutting elements & patterns

### 9.1 PRO badge

A small rounded pill, bold uppercase "PRO" text. Two visual variants used consistently everywhere it appears (game-setup footer link, Auth Menu "Add a question" link, top-bar account trigger):

- **Locked** (non-Pro user): grey background, muted grey text
- **Unlocked** (Pro user): indigo-100 background, indigo-600 text (indigo-600/white on the "Add a question" button itself, which is solid indigo)

### 9.2 Buttons

Consistent visual vocabulary across the whole app:

- **Primary (hero CTAs)**: gradient indigo→violet fill, white text, elevated shadow that intensifies on hover (game setup's "Start Game", add-question's "Add Question", pricing's "Subscribe")
- **Primary (standard)**: solid indigo-600 background, white text, darkens on hover
- Both primary variants grey out (`disabled:bg-slate-300`/gradient-to-slate) and show a "not-allowed" cursor when disabled
- **Secondary / outlined**: white/transparent background, slate border, slate text, light grey hover fill
- **Danger-adjacent text buttons**: none — errors are always shown as banners, not button color changes
- **Destructive-looking dark button**: "Play Again" uses a dark slate fill (distinct from primary indigo), signaling a full reset action

### 9.3 Inline banners (consistent 3-color system across every screen)

- **Red** (`bg-red-50`/`border-red-200`/`text-red-700`): hard errors (failed save, failed load, failed submit)
- **Amber** (`bg-amber-50`/`border-amber-200`/`text-amber-700`): soft warnings / non-fatal notices (categories failed to load but game still playable; checkout cancelled; existing best score was already higher)
- **Green** (`bg-green-50`/`border-green-200`/`text-green-700`): success confirmations (score saved, question added, verification email sent, subscription active)
- **Indigo** (`bg-indigo-50`/`bg-indigo-100`): neutral call-to-action prompts, not errors (sign-in prompts, verify-email prompts, Pro upsell box, save-score prompt)
- Most banners now carry a small leading icon reinforcing their color (triangle-alert/circle-alert for amber/red, circle-check-big for green, mail for the verify-email prompt)

### 9.4 Loading / busy conventions

- Buttons that trigger an async action disable themselves and swap their label to a present-participle phrase ending in an ellipsis: "Loading Questions…", "Saving…", "Please wait…", "Redirecting…", "Opening billing portal…"
- The top bar and Pricing's Subscribe button both guard on `authReady()` specifically (distinct from "anonymous") to avoid a one-frame flash of the wrong state before Firebase's first auth callback resolves — shown as "Loading…" in both places.

### 9.5 Form field conventions

- All labels are `<label>` elements, small, semibold, slate-500/600, positioned directly above their control with a small gap
- All text/select inputs share the same shape: `rounded-xl` corners, thin slate border, indigo focus ring; `<select>`s use a custom chevron-down icon (native arrow hidden via `appearance-none`)
- Segmented "pill" radio groups (Question Source, Question Type, True/False, Multiple/True-False question type) are used instead of native radio buttons or dropdowns wherever the option set is small (2–3 choices) — the underlying `<input type="radio">` is visually hidden (`sr-only`) and its wrapping `<label>` is styled as the visible control, with the selected option getting an indigo-100 fill + indigo-600 bold text; unselected labels use slate-600 (not a lighter grey) to keep body text at a readable contrast ratio against the segmented control's slate-100 track

### 9.6 Elevation & shape tokens

Named Tailwind utilities (`src/styles.css`) codify `BRAND_DESIGN_SYSTEM.md`'s shadow scale so every surface pulls from the same set: `shadow-card` (subtle card shadow), `shadow-card-lg` (quiz/game-over/leaderboard cards), `shadow-hero-card` (game-setup's large gradient-backed card), `shadow-dropdown` (auth menu), `shadow-cta`/`shadow-cta-hover` (primary gradient buttons), `shadow-pro-card` (pricing's Pro card). Corner radii follow Tailwind's default scale: `rounded-3xl` (24px, cards), `rounded-2xl` (16px, dropdowns/sub-cards), `rounded-xl` (12px, buttons/inputs/segmented controls).

### 9.7 Embed mode (`?embed=1`)

- Top bar (and therefore the entire Auth Menu, sign-in affordances) is not rendered at all.
- Every other button that opens the auth menu is hidden with it, since there is nowhere for it to open a menu into: Game Over's "Sign in" in the anonymous-player prompt (§3), and `/profile`'s "Sign in" in the signed-out state (§8). Both leave the explanatory text, at the same height.
- All other screens/logic behave identically; this only affects the top bar's presence and those auth-menu openers.

---

## 10. Full route table

| Path            | Component                 | Guard                                             | Purpose                                         |
| --------------- | ------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `/`             | `GameSetupComponent`      | none                                              | Configure & start a game                        |
| `/play`         | `QuizLoopComponent`       | redirects to `/` if no active question in memory  | Answer questions against a timer                |
| `/game-over`    | `GameOverComponent`       | redirects to `/` if no completed game in memory   | Final score, save to leaderboard, view top 10   |
| `/add-question` | `AddQuestionComponent`    | none (in-page gating by auth/Pro state instead)   | Submit a question to the custom bank (Pro only) |
| `/profile`      | `ProfileStatsComponent`   | none (in-page gating on a signed-in real account) | A player's own lifetime gameplay totals         |
| `/pricing`      | `PricingComponent`        | none                                              | Compare Starter vs. Pro, subscribe via Stripe   |
| `/review`       | `ReviewQueueComponent`    | none (in-page gating on the reviewer role)        | Approve or reject submitted questions           |
| `/privacy`      | `PrivacyPolicyComponent`  | none                                              | Published Privacy Policy                        |
| `/terms`        | `TermsOfServiceComponent` | none                                              | Published Terms of Service                      |
| `*` (unmatched) | —                         | redirects to `/`                                  | —                                               |

---

## 11. Full copy inventory (verbatim strings)

Grouped by screen, for quick reference when building Figma text styles / content models.

**Global / Top Bar / Auth Menu**: Trivimind · Pricing · Review · Your stats · Menu · Close menu · Site menu · Dark mode · Light mode · Loading… · Sign in · Sign up · Create an account · Continue with Google · or · Email · Password · Please wait… · Already have an account? Sign in · Don't have an account? Sign up · More sign-in options · Hide other sign-in options · Facebook · GitHub · Microsoft · Apple · Twitter / X · Yahoo · Account created! We've sent a verification link to your email. · Verify your email · We sent a verification link to {{email}}. Verify it to finish signing in and save scores to the leaderboard. · Resend verification email · Verification email sent — check your inbox. · Sign out · Your profile · Display name · Save · Saved! · Verified · Add a question · Upgrade to Pro to add questions · Manage subscription · Opening billing portal… · Could not update your name. Please try again. · Could not open the billing portal. Please try again. · Sign in before managing your subscription. · Timed out waiting for the billing portal to open. Please try again. · Too many attempts just now. Reload the page and try again in a few minutes. · Could not send the verification email. Please try again.

**Game Setup**: Trivimind · Configure your quiz and test your knowledge · Could not load categories from Open Trivia DB. You can still start with "Any Category". · No questions were found for the selected options. Try a different category, difficulty, or source. · Failed to load questions. Please check your connection and try again. · Number of Questions · Category · Any Category · Difficulty · Any Difficulty · Easy · Medium · Hard · Question Source · Open Trivia · Custom · Mixed · Start Game · Loading Questions… · + Create custom question

**Quiz Loop**: Question {{n}} / {{total}} · Score: {{n}} · (category badge) · (difficulty badge) · (streak badge: {{streak}} ×{{multiplier}}) · Question {{n}}: streak of {{n}}. Answers are now worth {{multiplier}} times their points. · Question {{n}}: streak lost. Answers are back to 1.0 times their points. · Correct! Well done. · Time's up! The answer was {{correct_answer}}. · Incorrect. The correct answer is {{correct_answer}}. · Lifelines · 50/50 · +15s · Skip · Fifty-fifty: remove two wrong answers. One use per game. · Fifty-fifty is unavailable on a true or false question. · Fifty-fifty already used. · Extra time: add 15 seconds to this question. One use per game. · Extra time already used. · Skip: move to the next question. It still counts toward your total. One use per game. · Skip already used.

**Game Over**: Game Over! · Here's how you did · Score · points · Accuracy · Correct · correct answers · Best streak · in a row · Outstanding! · Great job! · Good effort! · Keep practicing! · Score saved to the leaderboard! · You're ranked #{{n}} on the leaderboard. · Your best score is already higher ({{n}} points) — nice consistency! We kept your existing best. · Sign in to save this score to the leaderboard. · Verify your email to save this score to the leaderboard. · Enter your name · Save Score · Saving… · Could not save your score. Please try again. · Top 10 Leaderboard · Loading leaderboard… · Could not load the leaderboard. Please try again later. · No scores yet. Be the first! · Play Again · YOU (leaderboard badge for the current player's own row) · Review answers ({{n}}/{{total}} correct) · Your answers · Correct answer: · Source: · (opens in a new tab) · Justification · No answer · Time expired · You skipped this · Questions you flagged · Found something wrong in this game? Report it here.

**Add a Question**: Add a Question · Contribute a question to the shared custom bank · Sign in to submit a question to the shared bank. · Verify your email to submit a question. · This one's for Pro members · Upgrade to Pro to create and add your own questions to the shared question bank. · Upgrade to Pro · Thanks! Your question has been submitted for review. · Add another · Back to game · Category · e.g. Science · Difficulty · Question Type · Multiple Choice · True / False · Question · What is the question? · Correct Answer · True · False · Incorrect Answers · Incorrect answer 1/2/3 · Source link · (optional) · Where the answer comes from. Reviewers see it, and so do players after they answer. · Source name · Justification · Why is the right answer right, and why are the others wrong? · Only needed for a tricky question — where knowing the subject still isn't enough to see why the right answer is right. Reviewers see it, and so do players after they answer. · Could not save your question. Please try again. · Cancel · Add Question

**Pricing**: Back to game · Pricing · Play free forever, or go Pro to contribute your own questions. · Subscription started! It may take a few seconds to finish activating. · Start playing · Dismiss · Checkout was cancelled — no charge was made. · Starter · Everything you need to play and compete. · Free ($0/month) · Play unlimited games · Submit scores to the global leaderboard · Your current plan · Pro · Contribute questions and shape the game. · {amount}/month · Currency · USD · BRL · Everything in Starter · Create and add custom questions to the global question bank · More features coming soon · You're subscribed · Loading… · Sign in to subscribe · Redirecting… · Subscribe · Subscribe — {amount}/mo · Verify your email first, then come back to subscribe. · Could not start checkout. Please try again. · Sign in before subscribing. · Pro isn't available to buy right now — no active monthly Pro price is set up. Please try again later. · Timed out waiting for Stripe checkout to start. Please try again. · Too many attempts just now. Reload the page and try again in a few minutes. · Could not start checkout. Please reload the page and try again. · Your account is already set up to pay in {currency}, so Pro can only be bought in {currency} from this account. · Cancel anytime. No hidden fees.

**Review Queue**: Review Queue · Back to game · Filter by status · Pending · Approved · Rejected · Checking your access… · Loading… · Correct answer: · Category: · Difficulty: · Submitted: · Author: · Approve · Reject

**Your stats**: Back to game · Your stats · Your lifetime totals across every game you have finished while signed in. Only you can see them. · Loading your lifetime totals… · Sign in and your totals start counting from the next game you finish. · Nothing banked yet — finish a game and your totals will show up here. · Could not load your stats just now. · Tracking since {{date}}. · Tracking your lifetime totals. · Games played · Questions answered · Correct answers · Accuracy · Best streak · Start a game · Sign in · Try again · Your stats are ready. · No finished games yet. · Signed out. Stats are only kept for a signed-in account. · Could not load your stats.

**Legal pages (`/privacy`, `/terms`)**: Back to Trivimind · Last updated: {{date}} · In force, but not yet reviewed by a lawyer · This document applies to your use of the service today, and everything it says about what the app does with your information was written by reading the application's own source code — so it describes real behaviour rather than what a template assumes. What it has not had is a professional legal review. If you spot something wrong, unclear, or missing, please write to {{contactEmail}} — that is genuinely useful and it will be fixed.

**Auth error messages** (surfaced verbatim in the red banner of the sign-in/sign-up form, mapped from Firebase Auth error codes): "This sign-in method isn't enabled yet." · "An account with this email already exists. Try signing in instead." · "That email address looks invalid." · "Choose a stronger password (at least 6 characters)." · "Incorrect email or password." · "No account found with this email." · "This account is already linked to another user." · "Network error. Please check your connection and try again." · "Something went wrong. Please try again." (default fallback) · "Email aliases (e.g. \"name+tag@domain.com\") aren't allowed. Please use your plain email address." (client-side, sign-up only)
