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
     └─ <router-outlet>    (one of the 5 routed screens below)
```

### 0.1 Top Bar (`TopBarComponent`)

Sticky header, present on every screen except in **embed mode**.

- **Container**: full-width sticky header (64px tall), translucent white, blurred backdrop, bottom hairline border. Inner content max-width constrained and centered.
- **Logo / home link**: gradient (indigo→violet) rounded-square icon mark containing a sparkles glyph, plus text "**Trivimind**" — bold, indigo — links to `/`.
- **Two layouts, one breakpoint at Tailwind `sm` (640px).**
  - **≥ 640px** — the original row: brand on the left; "Review" (reviewers only), "Pricing", the theme toggle and the account trigger on the right.
  - **< 640px** — three zones: a **hamburger button** on the left, the brand **centred**, and the account trigger on the right. "Review", "Pricing" and the theme toggle move into the drawer the hamburger opens; they are the _same_ elements hidden by `sm:` classes, not duplicates.
  - The centring is a `minmax(0,1fr) auto minmax(0,1fr)` grid, so the two side tracks are equal and the brand sits at the true centre of the bar whatever the account chip weighs. `auto 1fr auto` looks right and is not: it centres the brand between its neighbours, which measured 21px off.
  - The display name truncates at ~5.5rem below `sm` (~10rem above), so a long one cannot push the bar into a horizontal scroll.
- **Nav drawer** (`< 640px` only): left slide-out panel, full viewport height, 18rem wide (max 80%), over a 40%-black backdrop. Holds a "MENU" label and a close (✕) button, then "Review" (reviewers only), "Pricing", and a **"Dark mode" / "Light mode"** button with a sun/moon icon. Following a link closes it; toggling the theme deliberately does not, since the page recolours around you and you may want to change back.
- **Pricing nav link**: text link "Pricing" → `/pricing`, next to the account trigger at `sm` and above; in the drawer below it.
- **Account trigger below `sm`: the avatar alone.** The display name and PRO badge are `sr-only` rather than removed — they were the widest thing in the bar and ran into the centred brand, but taking them out of the DOM would leave the button announced as a single letter. A screen reader still reads "B Bartholomew Featherstonehaugh PRO"; the chip measures ~64px instead of ~200px. The anonymous state keeps its visible "Sign in" text, which is short and is a call to action rather than a label.
- **Account trigger** (pill button, top-right, bordered): its content depends on auth state (see §0.1 States below); chevron-down icon on the right that rotates 180° when the dropdown is open.
  - Opens/closes the **Auth Menu** dropdown (`AuthMenuComponent`), anchored top-right below the trigger.

#### Account trigger — states

| State                                        | Visual                                                                                                                                                                                                                                                                                                                                                                                                                               | Text/content                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **Auth not ready yet** (`authReady()` false) | A **skeleton shaped like the resolved chip**: a pulsing avatar-sized grey circle plus an `invisible` "Sign in" reserving its width. Not the word "Loading…", which rendered 34px tall against 42px for every resolved state and made the chip change height the moment auth settled. Sized to the _anonymous_ chip deliberately, since that is what a first load almost always becomes — so the common case changes size not at all. | "Loading…", `sr-only`, plus `aria-busy` on the trigger                            |
| **Anonymous**                                | Grey circular avatar with a person glyph (👤)                                                                                                                                                                                                                                                                                                                                                                                        | "Sign in"                                                                         |
| **Signed in** (any real account)             | Gradient (indigo→violet) circular avatar showing the user's **initials** (first letter of display name or email, uppercased; falls back to "?")                                                                                                                                                                                                                                                                                      | Display name (or email if no display name set), truncated at ~10rem with ellipsis |
| **Signed in, PRO**                           | Same as above, plus a **PRO badge** (indigo-100 pill, indigo-600 bold "PRO" text) next to the name                                                                                                                                                                                                                                                                                                                                   | —                                                                                 |
| **Signed in, email unverified**              | Small amber dot badge overlaid on the bottom-right corner of the avatar                                                                                                                                                                                                                                                                                                                                                              | —                                                                                 |

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
- **Link/button**: "Add a question" (outlined, full width) — routes to `/add-question`; carries a **PRO badge** next to the label (indigo/filled if the user is Pro, grey/muted if not)
- Below that, one of:
  - Not Pro: text link "Upgrade to Pro to add questions" → `/pricing`
  - Pro: text button "Manage subscription" (label becomes "Opening billing portal…" and disables itself while the Stripe Billing Portal redirect is being prepared)
- **Button**: "Sign out" (outlined, full width)
- **Inline error banner** (red), shown only on failure, e.g.:
  - "Could not update your name. Please try again."
  - "Could not open the billing portal. Please try again."

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
  - Center: "Score: **{{ score }}**" (indigo)
  - Right: circular SVG ring timer (progress ring drains as `timeLeft` counts down) with the seconds-remaining number (e.g. "12s") centered inside it
- **Progress bar**: thin full-width bar under the status row — shows **overall quiz completion** (`currentIndex / totalQuestions`), filling left-to-right as questions are answered (distinct from the per-question countdown, which the ring now conveys on its own)
- **Badges row**:
  - Category badge (indigo pill, uppercase, e.g. "GENERAL KNOWLEDGE")
  - Difficulty badge (grey pill, uppercase, e.g. "MEDIUM")
- **Question text** (large, bold heading)
- **Answer grid**: 2-column grid (stacks to 1 column on small screens) of answer buttons, one per `all_answers` entry (2 for true/false, 4 for multiple-choice); each button has a leading letter badge (A/B/C/D by position) plus the answer text
- **Result feedback banner** (appears only once the question is answered/revealed, below the answer grid): a colored strip with an emoji and a message derived from the outcome — see States

### States

| State                               | Timer ring / bar color                    | Answer buttons                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Countdown, >5s left**             | Indigo ring + number, indigo progress bar | All enabled; default styling (white bg, slate border; indigo hover tint)                                                                                                                           |
| **Countdown, ≤5s left**             | Red ring + number                         | Same as above (still answerable)                                                                                                                                                                   |
| **Timer hits 0 (no answer chosen)** | Locks at 0                                | Auto-submits a "no answer" — same as an incorrect answer, no option highlighted green except the correct one                                                                                       |
| **Answer selected — correct**       | frozen                                    | Selected/correct button (and its letter badge) turns **green**; all other buttons disabled                                                                                                         |
| **Answer selected — incorrect**     | frozen                                    | Chosen button (and its letter badge) turns **red**; the actual correct answer turns **green**; all remaining (non-chosen, non-correct) buttons dim to 60% opacity, grey text; all buttons disabled |
| **Post-answer delay (2s)**          | —                                         | Result banner + colors stay visible for 2 seconds before auto-advancing                                                                                                                            |
| **Advance**                         | —                                         | Either the next question loads (ring/buttons reset to the countdown state) or, if it was the last question, navigates to `/game-over`                                                              |

Score only increments on a correct, non-timed-out answer.

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
- **Score summary** (two stat blocks side by side, on their own light-slate sub-cards):
  - "**{{ score }}** / **{{ totalQuestions }}**" — label "Score", caption "correct answers"
  - "**{{ percentage }}%**" — label "Accuracy", plus a derived performance label/color: "Outstanding!" (green, ≥90%) / "Great job!" (indigo, ≥70%) / "Good effort!" (amber, ≥50%) / "Keep practicing!" (red, <50%)
- **Save-score area** — content depends on auth state (see States below)
- **Section heading**: "Top 10 Leaderboard" (with a medal icon)
- **Leaderboard list** — content depends on load state (see States below); each row: rank (🥇/🥈/🥉 for top 3, "#N" otherwise), gradient avatar circle with the player's initials, name, "{{ score }} / {{ totalQuestions }} ({{ percentage }}%)". The current player's own row (matched by `uid`) is highlighted (indigo tint + left border) and tagged with a "YOU" badge, if present in the fetched top 10.
- **Button**: "Play Again" (full width, dark slate, reset icon) — resets all in-memory game state, navigates to `/`

### States — Save-score area

| State                                                                                     | Content                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Already saved this session, no error**                                                  | Green success banner: "Score saved to the leaderboard!", plus "You're ranked #N on the leaderboard." if (and only if) the player's own entry is present in the fetched top 10 — no rank is claimed otherwise              |
| **Already saved this session, but with a non-fatal note** (e.g. existing best was higher) | Amber banner with the specific message, e.g. "Your best score is already higher — nice consistency! We kept your existing best."                                                                                          |
| **Anonymous player**                                                                      | Indigo info box: "Sign in to save this score to the leaderboard." + **"Sign in" button** (hidden entirely in embed mode) that opens the Auth Menu                                                                         |
| **Signed in but not fully authenticated** (unverified email)                              | Indigo info box: "Verify your email to save this score to the leaderboard." + **"Resend verification email" button**                                                                                                      |
| **Fully authenticated, not yet saved**                                                    | Form: text input (placeholder "Enter your name", prefilled from profile display name, max 30 chars, required) + **"Save Score" button** (disabled while saving or while name is blank; label → "Saving…" while in flight) |
| **Save failed** (generic)                                                                 | Red inline error: "Could not save your score. Please try again."                                                                                                                                                          |

### States — Leaderboard list

| State          | Content                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| **Loading**    | Grey text: "Loading leaderboard…"                                           |
| **Load error** | Red inline error: "Could not load the leaderboard. Please try again later." |
| **Empty**      | Grey text: "No scores yet. Be the first!"                                   |
| **Loaded**     | Ranked list (1–10), refreshed automatically after a successful save         |

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
- Body: "Upgrade to Pro ($0.99/month) to create and add your own questions to the shared question bank."
- **"Upgrade to Pro" button** (indigo) → navigates to `/pricing`

**D — Fully authenticated + Pro, just submitted successfully**

- Green success box: "Thanks! Your question was added to the bank."
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
- **Inline error banner** (red), shown only on submit failure: "Could not save your question. Please try again."
- **Buttons**:
  - "Cancel" (outlined) → navigates to `/`
  - "Add Question" (indigo, flex-1) — disabled while submitting; label → "Saving…" while in flight

---

## 5. Route: `/pricing` — Pricing (`PricingComponent`)

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
- Price: "$0.99" + "/month" (static display text — the actual Stripe price _ID_ used at checkout is resolved dynamically, never hardcoded; see `docs/app.md` §1.6)
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

| State                              | Content                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Already subscribed (Pro)**       | Green box: "✓ You're subscribed" (Starter's "Your current plan" label is hidden in this state so only one card claims to be current) |
| **Auth not ready yet**             | Button disabled, label "Loading…"                                                                                                    |
| **Not signed in (anonymous)**      | Button label "Sign in to subscribe" — clicking opens the Auth Menu instead of starting checkout                                      |
| **Signed in, unverified email**    | Clicking shows red error: "Verify your email first, then come back to subscribe."                                                    |
| **Redirecting to Stripe Checkout** | Button disabled, label "Redirecting…"                                                                                                |
| **Ready to subscribe**             | Button label "Subscribe — $0.99/mo"                                                                                                  |
| **Checkout start failed**          | Red inline error: "Could not start checkout. Please try again."                                                                      |

---

## 6. Cross-cutting elements & patterns

### 6.1 PRO badge

A small rounded pill, bold uppercase "PRO" text. Two visual variants used consistently everywhere it appears (game-setup footer link, Auth Menu "Add a question" link, top-bar account trigger):

- **Locked** (non-Pro user): grey background, muted grey text
- **Unlocked** (Pro user): indigo-100 background, indigo-600 text (indigo-600/white on the "Add a question" button itself, which is solid indigo)

### 6.2 Buttons

Consistent visual vocabulary across the whole app:

- **Primary (hero CTAs)**: gradient indigo→violet fill, white text, elevated shadow that intensifies on hover (game setup's "Start Game", add-question's "Add Question", pricing's "Subscribe")
- **Primary (standard)**: solid indigo-600 background, white text, darkens on hover
- Both primary variants grey out (`disabled:bg-slate-300`/gradient-to-slate) and show a "not-allowed" cursor when disabled
- **Secondary / outlined**: white/transparent background, slate border, slate text, light grey hover fill
- **Danger-adjacent text buttons**: none — errors are always shown as banners, not button color changes
- **Destructive-looking dark button**: "Play Again" uses a dark slate fill (distinct from primary indigo), signaling a full reset action

### 6.3 Inline banners (consistent 3-color system across every screen)

- **Red** (`bg-red-50`/`border-red-200`/`text-red-700`): hard errors (failed save, failed load, failed submit)
- **Amber** (`bg-amber-50`/`border-amber-200`/`text-amber-700`): soft warnings / non-fatal notices (categories failed to load but game still playable; checkout cancelled; existing best score was already higher)
- **Green** (`bg-green-50`/`border-green-200`/`text-green-700`): success confirmations (score saved, question added, verification email sent, subscription active)
- **Indigo** (`bg-indigo-50`/`bg-indigo-100`): neutral call-to-action prompts, not errors (sign-in prompts, verify-email prompts, Pro upsell box, save-score prompt)
- Most banners now carry a small leading icon reinforcing their color (triangle-alert/circle-alert for amber/red, circle-check-big for green, mail for the verify-email prompt)

### 6.4 Loading / busy conventions

- Buttons that trigger an async action disable themselves and swap their label to a present-participle phrase ending in an ellipsis: "Loading Questions…", "Saving…", "Please wait…", "Redirecting…", "Opening billing portal…"
- The top bar and Pricing's Subscribe button both guard on `authReady()` specifically (distinct from "anonymous") to avoid a one-frame flash of the wrong state before Firebase's first auth callback resolves — shown as "Loading…" in both places.

### 6.5 Form field conventions

- All labels are `<label>` elements, small, semibold, slate-500/600, positioned directly above their control with a small gap
- All text/select inputs share the same shape: `rounded-xl` corners, thin slate border, indigo focus ring; `<select>`s use a custom chevron-down icon (native arrow hidden via `appearance-none`)
- Segmented "pill" radio groups (Question Source, Question Type, True/False, Multiple/True-False question type) are used instead of native radio buttons or dropdowns wherever the option set is small (2–3 choices) — the underlying `<input type="radio">` is visually hidden (`sr-only`) and its wrapping `<label>` is styled as the visible control, with the selected option getting an indigo-100 fill + indigo-600 bold text; unselected labels use slate-600 (not a lighter grey) to keep body text at a readable contrast ratio against the segmented control's slate-100 track

### 6.6 Elevation & shape tokens

Named Tailwind utilities (`src/styles.css`) codify `BRAND_DESIGN_SYSTEM.md`'s shadow scale so every surface pulls from the same set: `shadow-card` (subtle card shadow), `shadow-card-lg` (quiz/game-over/leaderboard cards), `shadow-hero-card` (game-setup's large gradient-backed card), `shadow-dropdown` (auth menu), `shadow-cta`/`shadow-cta-hover` (primary gradient buttons), `shadow-pro-card` (pricing's Pro card). Corner radii follow Tailwind's default scale: `rounded-3xl` (24px, cards), `rounded-2xl` (16px, dropdowns/sub-cards), `rounded-xl` (12px, buttons/inputs/segmented controls).

### 6.7 Embed mode (`?embed=1`)

- Top bar (and therefore the entire Auth Menu, sign-in affordances) is not rendered at all.
- On Game Over, the "Sign in" button in the anonymous-player prompt is also hidden (there's nowhere for it to open a menu into), leaving just the explanatory text.
- All other screens/logic behave identically; this only affects the top bar's presence and that one button.

---

## 7. Full route table

| Path            | Component              | Guard                                            | Purpose                                         |
| --------------- | ---------------------- | ------------------------------------------------ | ----------------------------------------------- |
| `/`             | `GameSetupComponent`   | none                                             | Configure & start a game                        |
| `/play`         | `QuizLoopComponent`    | redirects to `/` if no active question in memory | Answer questions against a timer                |
| `/game-over`    | `GameOverComponent`    | redirects to `/` if no completed game in memory  | Final score, save to leaderboard, view top 10   |
| `/add-question` | `AddQuestionComponent` | none (in-page gating by auth/Pro state instead)  | Submit a question to the custom bank (Pro only) |
| `/pricing`      | `PricingComponent`     | none                                             | Compare Starter vs. Pro, subscribe via Stripe   |
| `*` (unmatched) | —                      | redirects to `/`                                 | —                                               |

---

## 8. Full copy inventory (verbatim strings)

Grouped by screen, for quick reference when building Figma text styles / content models.

**Global / Top Bar / Auth Menu**: Trivimind · Pricing · Review · Menu · Close menu · Site menu · Dark mode · Light mode · Loading… · Sign in · Sign up · Create an account · Continue with Google · or · Email · Password · Please wait… · Already have an account? Sign in · Don't have an account? Sign up · More sign-in options · Hide other sign-in options · Facebook · GitHub · Microsoft · Apple · Twitter / X · Yahoo · Account created! We've sent a verification link to your email. · Verify your email · We sent a verification link to {{email}}. Verify it to finish signing in and save scores to the leaderboard. · Resend verification email · Verification email sent — check your inbox. · Sign out · Your profile · Display name · Save · Saved! · Verified · Add a question · Upgrade to Pro to add questions · Manage subscription · Opening billing portal… · Could not update your name. Please try again. · Could not open the billing portal. Please try again. · Could not send the verification email. Please try again.

**Game Setup**: Trivimind · Configure your quiz and test your knowledge · Could not load categories from Open Trivia DB. You can still start with "Any Category". · No questions were found for the selected options. Try a different category, difficulty, or source. · Failed to load questions. Please check your connection and try again. · Number of Questions · Category · Any Category · Difficulty · Any Difficulty · Easy · Medium · Hard · Question Source · Open Trivia · Custom · Mixed · Start Game · Loading Questions… · + Create custom question

**Quiz Loop**: Question {{n}} / {{total}} · Score: {{n}} · (category badge) · (difficulty badge) · Correct! Well done. · Time's up! The answer was {{correct_answer}}. · Incorrect. The correct answer is {{correct_answer}}.

**Game Over**: Game Over! · Here's how you did · Score · correct answers · Accuracy · Outstanding! · Great job! · Good effort! · Keep practicing! · Score saved to the leaderboard! · You're ranked #{{n}} on the leaderboard. · Your best score is already higher — nice consistency! We kept your existing best. · Sign in to save this score to the leaderboard. · Verify your email to save this score to the leaderboard. · Enter your name · Save Score · Saving… · Could not save your score. Please try again. · Top 10 Leaderboard · Loading leaderboard… · Could not load the leaderboard. Please try again later. · No scores yet. Be the first! · Play Again · YOU (leaderboard badge for the current player's own row)

**Add a Question**: Add a Question · Contribute a question to the shared custom bank · Sign in to submit a question to the shared bank. · Verify your email to submit a question. · This one's for Pro members · Upgrade to Pro ($0.99/month) to create and add your own questions to the shared question bank. · Upgrade to Pro · Thanks! Your question was added to the bank. · Add another · Back to game · Category · e.g. Science · Difficulty · Question Type · Multiple Choice · True / False · Question · What is the question? · Correct Answer · True · False · Incorrect Answers · Incorrect answer 1/2/3 · Could not save your question. Please try again. · Cancel · Add Question

**Pricing**: Back to game · Pricing · Play free forever, or go Pro to contribute your own questions. · Subscription started! It may take a few seconds to finish activating. · Start playing · Dismiss · Checkout was cancelled — no charge was made. · Starter · Everything you need to play and compete. · Free ($0/month) · Play unlimited games · Submit scores to the global leaderboard · Your current plan · Pro · Contribute questions and shape the game. · $0.99/month · Everything in Starter · Create and add custom questions to the global question bank · More features coming soon · You're subscribed · Loading… · Sign in to subscribe · Redirecting… · Subscribe — $0.99/mo · Verify your email first, then come back to subscribe. · Could not start checkout. Please try again. · Cancel anytime. No hidden fees.

**Auth error messages** (surfaced verbatim in the red banner of the sign-in/sign-up form, mapped from Firebase Auth error codes): "This sign-in method isn't enabled yet." · "An account with this email already exists. Try signing in instead." · "That email address looks invalid." · "Choose a stronger password (at least 6 characters)." · "Incorrect email or password." · "No account found with this email." · "This account is already linked to another user." · "Network error. Please check your connection and try again." · "Something went wrong. Please try again." (default fallback) · "Email aliases (e.g. \"name+tag@domain.com\") aren't allowed. Please use your plain email address." (client-side, sign-up only)
