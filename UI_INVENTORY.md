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
 ├─ <app-top-bar>              (hidden entirely when ?embed=1 is in the URL)
 ├─ <main>
 │   └─ <router-outlet>        (one of the routed screens below)
 └─ <app-footer>               (hidden with the top bar in embed mode)
     └─ <app-donation-dialog>  (renders nothing until it is opened)
```

### 0.1 Top Bar (`TopBarComponent`)

Sticky header, present on every screen except in **embed mode**.

- **Container**: full-width sticky header (64px tall), translucent white, blurred backdrop, bottom hairline border. Inner content max-width constrained and centered.
- **Logo / home link**: an emerald rounded-square mark containing a white "?" glyph, plus the text "**Trivimind**" — extra-bold, dark emerald (`emerald-800`, `emerald-400` in dark mode), darker than the mark because it is body-size text on a translucent bar (`BRAND_DESIGN_SYSTEM.md` §1) — links to `/`.
- **Two layouts, one breakpoint at Tailwind `sm` (640px).**
  - **≥ 640px** — the original row: brand on the left; "Review" (reviewers only), "Pricing", the theme toggle, the sound toggle and the account trigger on the right.
  - **< 640px** — three zones: a **hamburger button** on the left, the brand **centred**, and the account trigger on the right. "Review", "Pricing" and the theme and sound toggles move into the drawer the hamburger opens; the links are the _same_ elements hidden by `sm:` classes, while the two toggles are rendered twice — an icon button in the bar (`hidden sm:flex`) and a labelled row in the drawer (`sm:hidden`) — because neither surface exists at both widths.
  - The centring is a `minmax(0,1fr) auto minmax(0,1fr)` grid, so the two side tracks are equal and the brand sits at the true centre of the bar whatever the account chip weighs. `auto 1fr auto` looks right and is not: it centres the brand between its neighbours, which measured 21px off.
- **Nav drawer** (`< 640px` only): left slide-out panel, full viewport height, 18rem wide (max 80%), over a 40%-black backdrop. Holds a "MENU" label and a close (✕) button, then "Review" (reviewers only), "Your stats", "Pricing", a **"Dark mode" / "Light mode"** button with a sun/moon icon, and a **"Mute sounds" / "Unmute sounds"** button with a speaker / crossed-speaker icon. Following a link closes it; toggling the theme or the sound deliberately does not, since the control you would use to change your mind is inside the panel. The sound button is the drawer's copy of the mute — the bar carries an icon-only twin above `sm` — and it is the one that matters on a phone, where the drawer is the only surface reachable mid-question. It carries `aria-pressed` (true when muted) as well as the action label, and both states render from one class list, so the row cannot resize. "Your stats" is offered to everybody rather than only to signed-in accounts — the page itself explains what a signed-out reader has to do, where a link appearing when auth resolves would shift the rows beneath it.
- **Sound toggle (≥ 640px)**: a 36×36 circular bordered icon button beside the theme toggle, showing a speaker glyph or a crossed-out one. Icon-only, so the accessible name is an `aria-label` — "Mute sounds" / "Unmute sounds" — alongside `aria-pressed` (true when muted), which is the only state channel it has besides the glyph. Fixed size in both states, so pressing it cannot reflow the bar. Below `sm` it is `hidden` and the drawer's labelled row takes over.
- **Pricing nav link**: text link "Pricing" → `/pricing`, next to the account trigger at `sm` and above; in the drawer below it. Hovering or focusing it starts fetching what the pricing page needs, so the page it opens has a price on it already — the same is true of every other route into `/pricing` ("Upgrade to Pro to add questions" in the auth menu, "See Pro" on the daily-limit notice, "Upgrade to Pro" on the add-question gate). Nothing visible happens; see `docs/app.md` §1.6.
- **Account trigger, every viewport: the avatar alone.** The display name and PRO badge are `sr-only` rather than removed — taking them out of the DOM would leave the button announced as a single letter, and a screen reader still reads "B Bartholomew Featherstonehaugh PRO". A signed-in chip is 42px on a phone and 70px with the chevron above `sm`, and it is the same width while auth is still settling, so it never moves. This was a phone-only rule until the desktop exception turned out to be the last layout shift: the name arrives when auth resolves and the PRO badge a beat later when the Stripe claim does, which at 1024px moved a 123.4px skeleton to 104.4px (short name), 144px (short name + PRO) or 277.5px (a 29-character name). Reserving space instead was measured and rejected — a slot sized to "Sign in" fits four characters and an ellipsis; a slot sized to the widest name leaves a signed-out user looking at ~150px of nothing. The anonymous state keeps its visible "Sign in" text, which is short and is a call to action rather than a label.
- **Account trigger: the chip widens on a phone when it resolves to "Sign in".** Below `sm` the chip has exactly two widths — avatar-only (42px) and avatar-plus-"Sign in" (95px) — and everything except the signed-out state is the first, so the movement only ever widens and only ever happens when there is something to offer. A returning player's chip resolves without moving; a signed-out one grows a call to action in the corner of the eye. Animated by transitioning the label region's `max-width` from `0` to a 4rem cap (a content-driven `width: auto` has no property to transition), gated on `motion-safe:`, 600ms ease-out — the cap and duration are paired, because the motion stops as soon as the cap passes the label's own width. At `sm` and above nothing moves: the skeleton bar is already the width of the label it becomes.
- **Account trigger** (pill button, top-right, bordered): its content depends on auth state (see §0.1 States below); chevron-down icon on the right that rotates 180° when the dropdown is open.
  - Opens/closes the **Auth Menu** dropdown (`AuthMenuComponent`), anchored top-right below the trigger.

#### Account trigger — states

| State                                        | Visual                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Text/content                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Auth not ready yet** (`authReady()` false) | A **pulsing avatar-sized grey circle**, and nothing else, at every viewport — the exact shape and width of the signed-in chip it usually becomes, so the common case resolves without moving. Not the word "Loading…", which rendered 34px tall against 42px for every resolved state and changed the chip's height the moment auth settled. A width-reserving skeleton **bar** stood here while the resolved chip still showed a name; it would now reserve room for something that never arrives. If the answer turns out to be "signed out", the chip widens into "Sign in" — see the animation note above. | "Loading…", `sr-only`, plus `aria-busy` on the trigger                             |
| **Anonymous**                                | Grey circular avatar with a person glyph (👤)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | "Sign in"                                                                          |
| **Signed in** (any real account)             | The player's **avatar** (§8): an emerald circle with their **initials** (first letter of display name or email, uppercased; falls back to "?") on first paint, then — once the stored choice has been read — the avatar they built or their Google photo if they chose one. A photo stays hidden behind the initials until it has loaded, and one that fails leaves the initials, with no broken image. The same 28px circle in every case. No visible label at any width.                                                                                                                                     | Display name (or email if none set), `sr-only`; the avatar itself is `aria-hidden` |
| **Signed in, PRO**                           | Same as above, plus an **`emerald-400` ring** around the avatar (a `ring`, i.e. a box-shadow, so it costs no layout width). It replaced a PRO pill next to the name, which was worth 20.6px and landed a beat after the name — a second shift of its own.                                                                                                                                                                                                                                                                                                                                                      | "PRO", `sr-only`                                                                   |
| **Signed in, email unverified**              | Small amber dot badge overlaid on the bottom-right corner of the avatar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                  |

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
- **Link**: "Your questions" (outlined, full width, pencil icon) — routes to `/my-questions` (§9). No PRO badge: editing and withdrawing a contribution need no current subscription
- **Link/button**: "Add a question" (outlined, full width) — routes to `/add-question`; carries a **PRO badge** next to the label (indigo/filled if the user is Pro, grey/muted if not)
- Below that, one of:
  - Not Pro: text link "Upgrade to Pro to add questions" → `/pricing`
  - Pro: text button "Manage subscription" (label becomes "Opening billing portal…" and disables itself while the Stripe Billing Portal redirect is being prepared)
- **Button**: "Sign out" (outlined, full width)
- **Button**: "Buy me a coffee" (coffee glyph + label, outlined amber, full width) — sits **outside** the auth-state branches, so it is offered in every state including signed out; hidden on `/play`. Opens the donation dialog (§0.3) and closes this panel on the way.
- **Inline error banner** (red), shown only on failure, e.g.:
  - "Could not update your name. Please try again."
  - "Could not open the billing portal. Please try again." — only when `SubscriptionService` could not explain the failure; when it could, its own message shows instead: "Sign in before managing your subscription.", "Too many attempts just now. Reload the page and try again in a few minutes.", "Timed out waiting for the billing portal to open. Please try again.", or whatever `createPortalSession` wrote back

### 0.3 Footer (`FooterComponent`) and the donation dialog (`DonationDialogComponent`)

A hairline-bordered bar below `<main>`, hidden with the top bar in embed mode.

- **Left**: "© {{year}} Trivimind" — the brand word carries the build identity as a hover `title` and again in an `sr-only` span.
- **Right**, a `Legal` nav: **"Buy me a coffee"** (coffee glyph, amber on hover), then "Privacy Policy" → `/privacy`, then "Terms of Service" → `/terms`.
- **The donation CTA is absent on `/play`** — removed rather than hidden, so it is out of the tab order too. It is the disclosure trigger for the dialog (`aria-haspopup="dialog"`, `aria-expanded`, `aria-controls`), and focus returns to it when the dialog closes, whichever control opened it.

**The dialog** (`role="dialog"`, `aria-modal`, focus trapped in both directions, Escape closes) is mounted once here and opened from either the CTA or the auth menu:

- **Header**: coffee glyph + "Buy me a coffee", and a close "x".
- **Blurb**: "Trivimind is free to play and always will be. A one-off tip helps pay for the servers."
- **Currency row**: label "Currency" and, on the right, the same segmented `role="radiogroup"` control the Pro card uses (§7) when more than one currency is priced, or a plain pill naming the only one.
- **Amount row**: three preset pills as a labelled `role="radiogroup"`, priced from the Stripe catalog and rendered in the currency's own locale ($2.00 / $5.00 / $10.00, R$ 10,00 / R$ 25,00 / R$ 50,00). The middle one is checked by default. While the catalog is still loading the same three cells render an em-dash each, so nothing below them moves when the real amounts arrive.
- **Guest notice**, only for a visitor who is not signed in to a real account: "You're not signed in, so this donation won't be recorded against an account. Sign in first if you'd like it linked to yours." It promises no badge, because there is none.
- **Button**: "Donate {amount}" → Stripe Checkout ("Redirecting…" while the session is created), and under it "A one-off payment through Stripe. It buys nothing and is not refundable by default — see the Terms."
- **Empty catalog**: an amber notice, "Donations aren't available right now — no donation amounts are set up. Please try again later.", and no Donate button. This is what every environment shows before the donation product exists in Stripe.
- **Failure**: a red banner under the button carrying whatever the service could verify, announced through a permanent `role="status"` region.

---

## 1. Route: `/` — Game Setup (`GameSetupComponent`)

Full-screen centered card on an emerald-to-amber gradient background.

### Hierarchy

- **Title**: "Trivimind" (large, bold, emerald, centered)
- **Subtitle**: "Configure your quiz and test your knowledge" (centered, grey)
- **Resume banner** (emerald tint: `emerald-50` fill, `emerald-200` border, `emerald-800` text; `emerald-500/10` and `emerald-300` in the dark theme) — only while a game is in progress and unfinished: "You have a game in progress — question {n} of {total}.", a **Resume** button in the CTA fill (`emerald-700`, white text, `emerald-800` on hover — 5.4:1 in both themes) and an outlined **Discard**. While a start is in flight it holds exactly what it said when Start was pressed, so it neither appears for the game being started nor changes under a player starting another
- **Inline error banner** (red) — only if a previous game-start attempt failed: shows the game controller's load-error message (e.g. no questions found for the filters, network failure)
- **Form**
  - **Field: "Number of Questions"** — `<select>` labeled "Number of Questions"; options: `5`, `10`, `15`, `20`, `25` (default 10)
  - **Field: "Difficulty"** — `<select>` labeled "Difficulty"; options: "Any Difficulty" (default), "Easy", "Medium", "Hard"
  - **Field: "Question Source"** — labeled "Question Source"; a 3-segment button-style radio group:
    - "Open Trivia" (default selected)
    - "Custom"
    - "Mixed"
    - Selected segment is visually distinguished (`emerald-100` fill, `emerald-700` text)
  - **Field: "Topics" (optional)** — the shared tag picker (`FEAT-021`), the game's only topic choice (`FEAT-052`), below the source picker and above the time limit. Nothing chosen plays every topic, for every source.
    - A helper line saying what the selection does for the source in play, reserved at the height of the tallest of them all — one Mixed variant per suggested topic — so changing the source or the selection swaps the words without rewrapping the line and moving everything below it:
      - Open Trivia: "Pick one of the suggested topics, or none to play every topic."
      - Custom: "Pick topics to play questions about exactly those subjects."
      - Mixed, nothing chosen: "Pick topics to narrow the community half; a suggested one narrows Open Trivia too."
      - Mixed, no suggested topic among them: "Community questions match any of these; Open Trivia ones cover every topic until you add a suggested one."
      - Mixed, with one: "Community questions match any of these; Open Trivia ones follow #{seed tag}." — naming the first suggested topic in the selection
    - A fixed-height box of chosen chips, reading "No tags yet." until one is added; each chip is `#tag` with an × button named "Remove tag {tag}". It scrolls rather than grows
    - A text input, placeholder "Type a topic and press Enter" ("Maximum reached" at ten), and an "Add" button
    - One reserved feedback line under it, carrying whichever is true: "Too long — a tag is at most 32 characters." / "A tag needs at least 2 letters or digits." on a malformed draft, "Open Trivia plays only the suggested topics — Custom and Mixed take any." on a well-formed one an Open Trivia game cannot play, "Will be saved as #{normalised}" while typing, a notice about a source switch (below), or "{n} of {max} chosen." Reserved at the height of the longest of those
    - A fixed-height "Suggestions" group of toggle chips: the twenty-four **seed tags**, Open Trivia DB's categories as tags (`#general-knowledge`, `#film`, `#science-nature`, …). A chosen one stays in place, pressed. The strip is there, empty, on the first frame, and its chips land on the first idle moment or the first focus or press inside the picker — into the space already reserved, so nothing moves
    - **For an Open Trivia game it is a single choice of the suggested topics**: picking another replaces the one chosen ("Replaced {old} with {new}." from the live region), and a typed topic outside them is refused with the reason above and left in the box. **Switching into Open Trivia** keeps the first suggested topic and removes the rest, and says so in the feedback line — "Open Trivia plays one suggested topic, so the others were removed." or, with none to keep, "Open Trivia plays only the suggested topics, so yours were removed." — while the live region names them ("Open Trivia plays one suggested topic. Kept #history; removed #my-topic and #sports.")
    - Usable offline, where the selection is a preference over the saved pool

  - **Daily allowance row** (small grey line, one line in every wording): "Unlimited games with Pro." / "{n} of 5 free games left today." / "No free games left today."
  - **Short-draw notice** (amber, `role="status"`) — shown after Start when a topic-filtered draw came back short: "Only {found} of the {asked} questions you asked for match those topics. Start again to play the {found} we found."
  - **Submit button**, full width, `emerald-700` with white text — or, once the day's free games are spent and no start is in flight, the amber Pro offer in its place (`role="status"`: "That's your 5 free games for today." · "They reset at midnight. Pro removes the limit entirely." · **See Pro** → `/pricing`):
    - Default label: "Start Game"
    - After a short filtered draw: "Play {found} Questions"
    - While loading questions: "Loading Questions…" (disabled)
- **Footer link**: "+ Create custom question" → `/add-question`, with a **PRO badge** next to it (indigo/filled if the current user is Pro, grey/muted otherwise)
- **Curated quizzes** (`QuizListComponent`, `FEAT-024`) — a section **below the card, one screen down**, on the page's light background rather than the gradient: heading "Curated quizzes", the line "Questions somebody chose, played in the order they chose them.", then a fixed-height strip of up to ten fixed-size cards, newest first, that scrolls sideways rather than wrapping. Each card links to `/quiz/:quizId` and shows the quiz's title (clamped to two lines), its description (clamped to three) and "{n} questions" ("1 question") at the foot. Offline, each card is a disabled link instead — flat slate-100 with no shadow, a not-allowed cursor, and an amber wifi-off icon with "Needs a connection" in the count's place; a tap does nothing, and the cards come back when the connection does. Nothing is read until the section is scrolled into view

### States — donation return banner (from `?donation=success|cancelled` query param)

Read from the route snapshot at construction, so the banner is part of the first paint and the card below it never moves. Both carry a "Dismiss" button that clears the query parameter.

| Param       | Banner                                                       |
| ----------- | ------------------------------------------------------------ |
| `success`   | Emerald: "Thank you — your coffee is very much appreciated." |
| `cancelled` | Slate: "Donation cancelled — nothing was charged."           |

### States

| State                                                | Effect                                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial load                                         | Form usable immediately; no request is made before Start or before the curated quizzes below are scrolled to, and the suggestion chips land on the first idle moment |
| Form submitted while invalid                         | Validation errors marked (all fields touched); no navigation                                                                                                         |
| Submitting (`gameController.isLoading()`)            | Submit button disabled, label → "Loading Questions…"; the resume banner and the Pro offer stay exactly as they were when Start was pressed, until the route changes  |
| Game start failed — no questions matched the filters | Red inline error: "No questions were found for the selected options. Try a different topic, difficulty, or source."                                                  |
| Game start failed — network/fetch error              | Red inline error: "Failed to load questions. Please check your connection and try again."                                                                            |
| Success                                              | Navigates to `/play`                                                                                                                                                 |

### States — curated quiz list

One strip height in every state: the messages are laid **over** invisible placeholder cards rather than replacing them.

| State                                | Content                                                                                                                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Not scrolled to yet, and loading** | Three pulsing placeholder cards (`aria-hidden`); the two look the same, so nothing changes when the read starts                                                                                                  |
| **Loaded**                           | Up to ten quiz cards; the `sr-only` status reads "{n} quizzes." or "1 quiz."                                                                                                                                     |
| **Loaded, offline**                  | The same cards, each a disabled link (`aria-disabled`, no `href`): flat and shadowless, "Needs a connection" with a wifi-off icon in place of the count, in the same cell; a tap does nothing                    |
| **Empty**                            | Grey "No quizzes have been published yet." centred over the reserved strip                                                                                                                                       |
| **Load error**                       | "The quizzes could not be loaded." — or "You're offline, and the quizzes need a connection." — and an outlined "Try again", which moves focus to the heading before it re-reads; centred over the reserved strip |

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
  - Topic badge (emerald pill, e.g. "#general-knowledge") — the question's first topic tag, or the one its category derives for a question written before topics replaced categories; not upper-cased, because a tag's case is part of its spelling. Absent on a question with neither
  - Difficulty badge (grey pill, uppercase, e.g. "MEDIUM")
  - **Streak badge** (flame icon + the run + the multiplier, e.g. "🔥 3 ×1.5") — rendered on every question and merely `invisible` until the run reaches two, so it cannot re-wrap the row mid-question. Its colour is the tier: grey at ×1.0, amber at ×1.5, orange at ×2.0, red and `motion-safe:` pulsing at ×3.0. The run sits in a two-character `tabular-nums` slot and the multiplier is always written to one decimal, so the pill is the same width in every state. `aria-hidden`; an `sr-only` `role="status"` region announces a tier change (and only a tier change) in words.
- **Question text** (large, bold heading) — up to 2,000 characters (`FEAT-051`). A long statement grows the card and the page scrolls; there is no scroll region inside the card, and the answers sit under the statement however long it is
- **Answer grid**: one answer button per `all_answers` entry — two to six (2 for true/false, usually 4 for multiple-choice, up to 6) — each with a leading letter badge (A–F by position) plus the answer text. Two columns from `sm` up for four options or fewer; **one column at every width for five or six**, so a fifth option never sits alone in a half-empty row; one column on phones throughout
- **Lifelines toolbar**: a labelled button group of two or three buttons, below the answer grid (see below)
- **Result feedback banner** (last in the card, below the lifelines toolbar): a coloured strip with an emoji and one of three fixed messages — 🎉 "Correct! Well done.", ⏰ "Time's up!", ❌ "Incorrect." Its space is **reserved from the first render**, empty until there is a result, because the card is vertically centred and a banner that appeared on answering lifted the whole card by half its height (measured at 43px on a 390×1000 phone, 37px at 1024×900). All three messages are stacked in one grid cell so the reserved height is the tallest of them rather than a hard-coded guess.
  - The messages deliberately **do not name the correct answer**, which is what used to make the banner's height depend on the question — a long answer wrapped to a second line. On screen it is redundant: the correct option keeps an emerald border and badge while every other option drops to 60% opacity. They also carry no pointer to that highlight ("the answer is highlighted", "see the green answer"), because every such phrasing wraps at 320px and the reserved space would then cost a permanent second line on every phone.
  - `aria-hidden`, because the permanent `role="status"` region is the accessible channel and **does** speak the answer in full.
- **Vote row** (community questions only — never on an Open Trivia DB question, and never in embed mode): "Rate this question" on the left, and two square icon buttons on the right — a thumbs-up ("Like this question") and a thumbs-down ("Dislike this question"), each a toggle with `aria-pressed`. In the card from the moment a community question appears, `invisible` until the answer is revealed, so the reveal moves nothing; shown for the two seconds the result is on screen. A pressed button has a filled glyph — emerald for a like, slate for a dislike — so the state is a change of shape as well as of colour. Under the result banner and away from the report flag beside the question text: different glyph, different place, different words. A permanent `sr-only` `role="status"` region announces each outcome ("Question {{n}}: you liked this question.").

### States

| State                               | Timer ring / bar color                    | Answer buttons                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Countdown, >5s left**             | Indigo ring + number, indigo progress bar | All enabled; default styling (white bg, slate border; indigo hover tint)                                                                                                                                                                                                                                                                                                                                       |
| **Countdown, ≤5s left**             | Red ring + number                         | Same as above (still answerable)                                                                                                                                                                                                                                                                                                                                                                               |
| **Timer hits 0 (no answer chosen)** | Locks at 0                                | Auto-submits a "no answer" — same as an incorrect answer, no option highlighted green except the correct one                                                                                                                                                                                                                                                                                                   |
| **Answer selected — correct**       | frozen                                    | Selected/correct button (and its letter badge) turns **green**; all other buttons disabled                                                                                                                                                                                                                                                                                                                     |
| **Answer selected — incorrect**     | frozen                                    | Chosen button (and its letter badge) turns **red**; the actual correct answer turns **green**; all remaining (non-chosen, non-correct) buttons dim to 60% opacity, grey text; all buttons disabled                                                                                                                                                                                                             |
| **Post-answer delay (2s)**          | —                                         | Result banner + colors stay visible for 2 seconds before auto-advancing (the banner's box was already occupying its space before the answer, so nothing moves); a community question's vote row becomes visible in its already-reserved box. If the account menu is open when the 2 seconds run out — a guest's tap on a vote opens it — the advance waits for the menu to close, then pauses 2 seconds afresh |
| **Advance**                         | —                                         | Either the next question loads (ring/buttons reset to the countdown state) or, if it was the last question, navigates to `/game-over`                                                                                                                                                                                                                                                                          |

Score only increases on a correct answer, by one base point **times the active streak multiplier**: 1–2 in a row score ×1.0, 3–4 score ×1.5, 5–7 score ×2.0, 8 or more score ×3.0. A wrong answer or a timeout resets the run; a skip neither breaks nor extends it. A timeout and a skip both score zero and both still count toward the total.

**Audio cues** (unless muted (from the top bar above `sm`, from the nav drawer below it), or in embed mode, where nothing plays): a rising two-note chime on a correct answer, a short low buzz on a wrong one **or** a timeout, a soft tick on each of the last five seconds of a timed question — none on the "No limit" setting, which has no countdown — and a short upward sweep whenever a lifeline is spent, Skip included, which gets that cue and no answer cue. A press on a lifeline that is unavailable or already spent makes no sound. All synthesised in the browser; there is no volume control, only the mute.

### Lifelines toolbar

A labelled button group (`role="group"`, "Lifelines") **below the answer grid**, present on every question, so the card reads question → answers → help and the lifelines are within reach without standing between a question and its options. It is placed there in the markup rather than by CSS, so Tab and a screen reader meet the answers first too. Each lifeline is single-use per round; a spent one greys out and stays in place, so the row cannot change size mid-game. An `sr-only` `role="status"` region announces each use — the visible change is options greying out or a number jumping, which is silent to a screen reader — and a short upward sweep plays alongside it, on each of the three, and only when the lifeline is actually spent.

| Button                  | Does                                                                                                                        | Unavailable when                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **50/50** (percent)     | Removes every wrong option but one, leaving two whatever the count (one removed on three options, two on four, four on six) | **Disabled** on a question with two options — true/false or a two-option multiple choice — where removing anything hands over the answer; **disabled** once spent |
| **+15s** (clock-plus)   | Adds 15 seconds to this question's countdown                                                                                | **Not rendered at all** on an unlimited game — there is no countdown to extend; **disabled** once spent                                                           |
| **Skip** (skip-forward) | Straight to the next question — no result banner, no 2s pause                                                               | **Disabled** once spent                                                                                                                                           |

- **Removed options stay in the grid**, muted, struck through and unclickable, rather than being taken out — collapsing the cells would move the surviving answers under the reader's cursor as they are reading them.
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

**Arriving plays a cue** (unless muted, or in embed mode): a four-note rising fanfare when every question was answered correctly, a shorter falling pair otherwise. A **reload** of this screen plays it again — a reloaded document is still activated as far as the browser's autoplay policy is concerned.

### Hierarchy

- **Header card**: amber-gradient trophy icon badge, "Game Over!" (large, bold, dark, centered), subtitle "Here's how you did" (centered, grey)
- **Score summary** (four stat blocks in a 2×2 grid, on their own light-slate sub-cards; all four render in every state):
  - "**{{ score }}**" — label "Score", caption "points". The multiplied total, so it can exceed the question count
  - "**{{ percentage }}%**" — label "Accuracy", plus a derived performance label/color: "Outstanding!" (≥90%) and "Great job!" (≥70%) in `emerald-700` / "Good effort!" (≥50%) in `amber-700` / "Keep practicing!" (<50%) in `red-700` — the `-400` of each in the dark theme. The figure and its 12px label share the colour, so every tier clears 4.5:1 on the tile. Never multiplied, so never above 100%
  - "**{{ correctAnswers }}** / **{{ totalQuestions }}**" — label "Correct", caption "correct answers"; the "/ {{ totalQuestions }}" is smaller and muted, in the caption's `slate-500` (`slate-400` dark): 4.55:1 and 6.1:1 on the tile
  - flame icon + "**{{ maxStreak }}**" — label "Best streak", caption "in a row"
- **Save-score area** — content depends on auth state, or on the game being a curated quiz (see States below)
- **Section heading**: "Top 10 — {{ boardLabel }} games" (with a medal icon), and under it a second, always-present line naming the population being ranked: "Worldwide", "In {{ country }}", or "Your country" when the Regional tab is selected with none set. Two lines by construction, so the header keeps one height across the toggle — the combined form wraps at 390px and not at 1024px
- **Global / Regional toggle** — a segmented pair in its own row above the board, built the same way as the pricing page's currency switch: real `<input type="radio">` elements hidden with `sr-only` inside `<label>`s, wrapped in a `role="radiogroup"` whose `sr-only` label reads "Which leaderboard to show". Labels are fixed ("Global", "Regional") in every state, and both are selectable whether or not a country is set
- **Leaderboard list** — content depends on load state (see States below); each row: rank (🥇/🥈/🥉 for top 3, "#N" otherwise), gradient avatar circle with the player's initials, name, "{{ score }} pts · {{ percentage }}%" (`tabular-nums`, `shrink-0`, so a three-digit score narrows the name rather than reshaping the row — old unmultiplied entries and new multiplied ones share the board indefinitely). The current player's own row (matched by `uid`) is highlighted (indigo tint + left border) and tagged with a "YOU" badge, if present in the fetched top 10.
- **For a curated quiz** (`FEAT-024`) the heading, the toggle and the list are not rendered at all, and nothing is read for them: a quiz is not ranked.
- **"Review answers" card** (collapsible, collapsed by default) — header button reading "Review answers (X/N correct)" with a rotate icon and a chevron that flips on open. Expanded, it lists one row per question of the round: a numbered pill (emerald if the answer was right, red if not), the question text, topic (`#tag`, the question's first) and difficulty badges — on a community question the difficulty badge shows the band its players have **measured** (`FEAT-023`): the word alone, "easy", "medium" or "hard", in the same pill and casing as a label, and an unplayed one shows its label; an Open Trivia DB row keeps the label it arrived with — the player's pick with a check/cross/clock icon, and — only when the pick was wrong or the clock ran out — the correct answer on a second line with a check icon. A timed-out question also carries an amber "Time expired" badge, and a skipped one (`FEAT-002`) a grey "Skipped" badge with "You skipped this" in place of a pick. Where a question carries more than one topic, the row ends with all of them as **Topics** (a row of `#tag` chips, `FEAT-021`) — one is already the badge; where a contributed question carries them, its **source** — an external-link glyph and a link opening in a new tab, glyph and words in the line's one muted grey (`slate-500`, `slate-400` in the dark theme) (`FEAT-022`), preceded by "Machine-generated from" on a question the generation pipeline wrote (`FEAT-020`), whose line reads "Machine-generated" alone if it names no source — and its **Justification**, a tinted block headed "Justification" (`slate-600`, `slate-400` in the dark theme) holding the contributor's prose; neither renders on a question with none, which is every Open Trivia DB question and most contributed ones. A community question's row then ends with the same **vote row** the quiz shows after a reveal ("Rate this question", thumbs-up, thumbs-down — `FEAT-027`), here with no clock; none on an Open Trivia DB row or in embed mode. A guest's tap opens the account menu, and outcomes are announced through a permanent `sr-only` `role="status"` region outside the card. The whole card is absent unless the recorded answers cover the whole round.
- **Button**: "Play Again" (full width, dark slate, reset icon) — resets all in-memory game state, navigates to `/`

### States — Save-score area

| State                                                                                     | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Already saved this session, no error**                                                  | Green success banner: "Score saved to the leaderboard!", plus "You're ranked #N on the {{ boardLabel }} leaderboard[ in {{ country }}]." if (and only if) the player's own entry is present in the fetched top 10 — no rank is claimed otherwise, and the sentence names whichever board is on screen                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Already saved this session, but with a non-fatal note** (e.g. existing best was higher) | Amber banner with the specific message, e.g. "Your best score is already higher (12 points) — nice consistency! We kept your existing best."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Anonymous player**                                                                      | Indigo info box: "Sign in to save this score to the leaderboard." + **"Sign in" button** (hidden entirely in embed mode) that opens the Auth Menu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Signed in but not fully authenticated** (unverified email)                              | Indigo info box: "Verify your email to save this score to the leaderboard." + **"Resend verification email" button**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Fully authenticated, not yet saved**                                                    | A labelled **"Country to rank in"** dropdown listing every country by name in the reader's own locale, with "Prefer not to say" first, and a hint reading "Published beside your name and score on that country's public board, as well as the global one. Leave it unset and only the global board gets your score." It opens on the country the app inferred, or on the one the reader last chose. Then the form: text input (placeholder "Enter your name", prefilled from profile display name, max 30 chars, required) + **"Save Score" button** (disabled while saving or while name is blank; label → "Saving…" while in flight). The dropdown comes first in the DOM, and therefore in the tab order: it is part of what Save publishes |
| **Save failed** (generic)                                                                 | Red inline error: "Could not save your score. Please try again."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Curated quiz** (any auth state)                                                         | Slate box: "Quizzes aren't ranked on a leaderboard." and "Everyone plays a quiz's questions in the same order, so its score stays off the board." It wins over every state above, in the same reserved cell, so the card is the size a drawn game's is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### States — Review answers card

| State                               | Content                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **No recap**                        | The card does not render at all — no answers recorded for this round (e.g. a game restored from a save written before the feature existed)                                                                                                                               |
| **Collapsed**                       | Header button only; `aria-expanded="false"`, panel not in the DOM                                                                                                                                                                                                        |
| **Expanded**                        | Header button (`aria-expanded="true"`) plus the `<ol>` of question rows                                                                                                                                                                                                  |
| **Row: right**                      | Emerald number pill, emerald pick line with a check icon, no second line                                                                                                                                                                                                 |
| **Row: wrong**                      | Red number pill, red pick line with a cross icon, emerald "correct answer" line below it                                                                                                                                                                                 |
| **Row: expired**                    | Red number pill, amber "Time expired" badge among the meta badges, grey "No answer" line with a clock icon, emerald correct-answer line                                                                                                                                  |
| **Row: skipped**                    | Red number pill, grey "Skipped" badge with a skip-forward icon among the meta badges, grey "You skipped this" line, emerald correct-answer line                                                                                                                          |
| **Row: community question**         | Any of the above, with the difficulty badge showing the measured band (easy / medium / hard) in the label's place, played or not (`FEAT-023`), and ending with the vote row ("Rate this question", thumbs-up, thumbs-down), each button pressed as the player last voted |
| **Row: machine-generated question** | A community question the generation pipeline wrote (`FEAT-020`): as above, with its source line reading "Machine-generated from" before the link — the same after a reload of the screen                                                                                 |

### States — Leaderboard list

**The board is ten rows tall in every state**, because ten is known before the data is — it is the `limit` passed to `getTopScores`. It used to be one line while loading that became up to ten rows, a **508px** jump (68px → 576px) landing exactly as a player reads their final score. Three kinds of row, all built from the same box so their heights cannot drift apart: real entries, pulsing skeletons, and invisible fillers for slots the board has not reached. Only the entries are in the accessibility tree; the other two are `aria-hidden` decoration, with an `sr-only` `role="status"` region carrying their meaning in words.

| State                        | Content                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Loading**                  | **Ten pulsing skeleton rows** (rank pill, avatar circle, name bar, score bar); `sr-only` status reads "Loading leaderboard…"                                                                                                                                        |
| **Load error**               | Red message "Could not load the leaderboard. Please try again later.", centred **over** ten reserved rows                                                                                                                                                           |
| **Empty**                    | Grey message "No scores yet. Be the first!" — or "No scores in {{ country }} yet. Be the first!" on a country board — centred **over** ten reserved rows                                                                                                            |
| **Regional, no country set** | Grey message "Choose your country in the save form above to see how you rank there." (or "Sign in and choose your country to see how you rank there." when there is no real account), centred over ten reserved rows. Nothing is fetched: there is no board to read |
| **Loaded**                   | Ranked list (1–10), refreshed automatically after a successful save and on every switch of the toggle; any unfilled slots become invisible filler rows                                                                                                              |

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

- **Field: "Topics"** — first on the form and required (`FEAT-052`): the same tag picker the setup screen uses (`FEAT-021`), with helper text "A few words for what this question is about, so players can ask for exactly this subject. Reviewers see them too." No "(optional)" on its label; submitting without one shows "Add at least one topic." under the input and moves focus to it. Up to eight here rather than ten, matching what `firestore.rules` stores, and its suggestions are the twenty-four seed tags followed by the starter list. The edit dialog on `/my-questions` renders it identically, pre-filled with the question's own tags — or the one its category derives
- **Field: "Difficulty"** — `<select>`; options "Easy", "Medium", "Hard" (default "Medium")
- **Field: "Question Type"** — 2-segment button-style radio group: "Multiple Choice" (default) / "True / False"
- **Field: "Question"** — `<textarea>` (3 rows), placeholder "What is the question?", up to 2,000 characters (`FEAT-051`). Under it, right-aligned, a counter — "{{n}} of 2000 characters" — present from first paint, part of the field's description rather than a live region, and red past the limit; past it the field's own error reads "Question must be 2000 characters or fewer."
- **Field: "Formatting"** — 2-segment button-style radio group: "Plain text" (default) / "Markdown & math" (`FEAT-019`). Choosing Markdown reveals a helper line ("Paragraphs and line breaks, bold, italics, strikethrough, lists, quotes, links, inline code and code blocks, plus LaTeX between `$…$` and `$$…$$`. Anything else is removed rather than shown.") and a bordered **Preview** panel — a named `role="region"`, not a live region — rendering the Question field through the same component the quiz loop uses, empty but reserved until something is typed
- **Conditional answer fields**, depending on Question Type:
  - **True / False**: "Correct Answer" 2-segment button radio group: "True" / "False" (incorrect answer auto-derived as the opposite)
  - **Multiple Choice**:
    - "Correct Answer" — single text input
    - "Incorrect Answers" — a labelled group of rows (`FEAT-051`), three to start with — four options, the usual shape — and one to five as the contributor adds and removes them, so a question has two to six options in all. Each row is a text input labelled "Incorrect answer N" (`sr-only` label, same words as its placeholder), with a square **×** remove button ("Remove incorrect answer N") beside it while there is a row to spare; at two options the remove buttons are gone. Under the rows: an outlined **"Add an answer"** button (plus-circle icon), disabled once there are six options, and the hint "Two to six answers in all, counting the correct one." Adding a row puts the cursor in it; removing one moves focus to the row that took its place, or to "Add an answer" when the last row went. An `sr-only` `role="status"` region announces each change: "Incorrect answer 4 added. The question now has 5 answers.", "Incorrect answer 2 removed. The question now has 3 answers.", with "That is the most a question can have." / "That is the fewest a question can have." at six and at two. The labels renumber when a row goes, and an empty row is named and focused by its number on submit
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
- **View picker**: a labelled tab group (`sr-only` heading "Choose what to review") with **Pending / Approved / Rejected / Reports** in a bordered strip — one row from `sm` up, two rows of two below it, where four in a row would be wider than a phone; the active tab is filled in the CTA fill (`emerald-700`, white text — 5.4:1 in both themes), the others plain slate text
- **Question list** (the three status tabs): one card per question in the active status — question text, its answers with the correct one marked, then `Difficulty:` / `Submitted:` / `Status:` / `Author:` metadata — the author being the uid, "Unattributed (predates attribution)", or "Question pipeline" for a question the generation pipeline wrote (`FEAT-020`), which also carries a `Run:` line naming the run that produced it (the run id cut to 32 characters; no line where none is recorded), every value readable whole at a phone's width, the run wrapping rather than clipped where its line is too narrow — then, where the question has an account behind it, so not on one written before attribution, one whose author erased their account or one the pipeline wrote, a small emerald text button **"Everything this account contributed"** that opens the per-author view below, then the question's **Topics** (a row of `#tag` chips — the tag its category derives for a question written before topics replaced categories — absent only when it has neither), and below that the contributor's optional **source** (an external-link glyph and a link opening in a new tab, labelled with the source name, followed by the URL's hostname — glyph, words and hostname all in the line's one muted grey (`slate-500`, `slate-400` in the dark theme), the hostname set apart by its lighter weight and a dash — the reviewer is shown where the link goes, not only what the contributor called it; the hostname alone is the label when no source name was given — and preceded by "Machine-generated from" on a question the pipeline wrote, as in the player's recap) and **Justification** (a tinted block headed "Justification" in `slate-600`, `slate-400` in the dark theme, holding the contributor's prose). Neither renders when the question carries none, which is the usual case
- **Rejection reason box** per card: a labelled two-row textarea — "Reason for rejecting (optional)", or once the question is rejected "Reason shown to the author (optional)", and "Reason kept on the record (optional)" on a question the pipeline wrote, which has no author to show it to — placeholder "What would have to change for this to be approved?". Rendered on every card rather than revealed by clicking Reject, so the row does not resize under the cursor and the reason is typed before the decision. Pre-filled with whatever reason the question already carries; over 500 characters it shows a field error and the button refuses to send
- **Action buttons** per card: **Approve** in the CTA fill (`emerald-700`, white text — 5.4:1 in both themes; `emerald-800` on hover in the light theme, 7.6:1, while the dark theme keeps `emerald-700` on hover, because `emerald-800` is 2.3:1 against the dark card), hidden when the question is already approved because there the button would be a no-op; and the reject button, which is always offered because on a rejected card it is not one — it reads **"Update reason"** there and writes the edited note without deciding the question again
- **Truncation note** when the queue is full — the query is capped, and the list says so rather than implying it is the whole queue
- **Reports list** (the Reports tab): a one-line status block above the list, then one card per filed report — the reason in words ("The answer is wrong", "Inappropriate or offensive", "Spam or nonsense", "Something else") with "Reported {date}" opposite it, the reporter's optional detail in their own words below — wrapped inside the card, an unbroken word included — and under a divider the **whole question card** described above, action buttons included. **Nothing identifies who filed the report.** A report whose question has since been deleted shows its question id and "…is no longer in the bank, so there is nothing left to act on" in place of the card
- **"Show more reports"** below the list, present only while there is a next page to fetch — it appends that page rather than replacing what is on screen, and disappears at the end of the collection

### Per-author view (`AuthorContributionsComponent`)

Opened from a card's "Everything this account contributed" — in a status tab or under a report — and shown in place of the view picker and the lists, which are hidden rather than destroyed. In-page, like the tabs: nothing changes in the address bar. **No uid appears anywhere in it.**

- **Back button**: "← Back to {tab}" — Pending, Approved, Rejected or Reports, whichever it was opened from; disabled while a bulk action is in flight. Focus returns to the button that opened the view, or to that tab when the button's row has gone
- **Heading**: "Everything this account contributed" — focused when the view opens
- **The account, named by a question**: "The account that wrote:" over the question it was opened from, in a quote-style block with a left rule, clamped to three lines
- **Explanation**: "Every status, newest first, 50 to a page. Rejecting stops a question being served and shows your reason to its author; nothing is deleted, and any of them can be approved again from the Rejected tab. Suspending or deleting the account itself is not done here — the site owner does that in the Firebase console."
- **Status block**: one grid cell holding every message the read can end in, switched with `invisible` so nothing below moves when the read lands
- **Bulk bar** (a white card, present once a page has rows): a **"Select all on this page"** checkbox (mixed while only some are selected, disabled when nothing on the page can be rejected), then a one-line **selection line** reserved at the height of its longest message — "{n} of {m} selected", "Rejecting… {n} of {m}" while the writes are out, then the outcome — then a two-row **"Reason for rejecting (required)"** textarea with the hint "Shown to the author on every question this rejects." and, under it, a line held empty for the box's error so that showing one moves nothing, and a red-outlined **"Reject selected"** button ("Rejecting…" while in flight, the same width either way)
- **Rows**: one white card per contribution, newest first — a checkbox (a 40px target, named "Select question {n}", disabled on a question already rejected), the question text, a coloured **status pill** opposite it whose labels are stacked so it is one width whatever it says (amber "Pending review", emerald "Approved", red "Rejected", or slate "Unknown" on a question carrying no status), `Submitted:` / `Difficulty:` metadata and the **Topics** chips. No answers, no reason box and no per-row buttons: the decisions are made on the set
- **Paging** below the list, only once there is more than one page: **"Newer contributions"** and **"Older contributions"**, each disabled at its end. A page replaces the list and clears the selection, so one action never spans two pages

| State                      | Content                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Loading**                | "Loading this account’s contributions…"                                                                                                                                                                                               |
| **Nothing there**          | "Nothing this account contributed is in the bank any more." — or, on a later page, "There is nothing older from this account."                                                                                                        |
| **Load failed**            | "Could not load this account’s contributions." and a **Try again** button — never the empty state. A page that fails leaves the page that loaded on screen                                                                            |
| **Loaded**                 | "{n} contributions, newest first." — "Page {n}: …" once there is more than one page                                                                                                                                                   |
| **No selection on Reject** | "Select at least one question to reject." in red on the selection line, and focus moves to "Select all on this page"                                                                                                                  |
| **No reason on Reject**    | "Give a reason — it is shown to the author on every question this rejects." under the box, which is marked invalid and focused; over 500 characters: "A reason must be 500 characters or fewer."                                      |
| **Rejected**               | Each row's pill turns red "Rejected" where it stands and its checkbox disables; the selection line says "Rejected {n} questions." ("Rejected 1 question." for one) and the same sentence is announced                                 |
| **Partly rejected**        | "Rejected {k} of {n}. {n − k} could not be confirmed and are still selected — try again." ("… and is still selected …" when it is one). The unconfirmed rows keep their status and stay ticked, so pressing Reject again is the retry |
| **None confirmed**         | "None of the {n} could be confirmed. They are still selected — try again." — for a selection of one, "That question could not be confirmed and is still selected — try again."                                                        |
| **Nothing left to reject** | "Everything on this page is already rejected." on the selection line, with select-all disabled                                                                                                                                        |

### States

| State                           | Content                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access still resolving**      | "Checking your access…" — the neutral state, shown before the role is known rather than guessing either way                                                                                        |
| **Not a reviewer**              | An explanation that the queue is for reviewers, with a way back to the game. No tabs, no lists                                                                                                     |
| **Loading the queue**           | "Loading…"                                                                                                                                                                                         |
| **Load failed**                 | An inline error with a retry affordance                                                                                                                                                            |
| **Empty for the active status** | An empty-state message for that tab                                                                                                                                                                |
| **Loaded**                      | The question list                                                                                                                                                                                  |
| **Action failed**               | An inline error above the list; the card stays put so the action can be retried                                                                                                                    |
| **Reports: loading**            | "Loading reports…"                                                                                                                                                                                 |
| **Reports: none filed**         | "No reports have been filed." — in the same box the loading message occupied, so the tab does not resize when the read lands                                                                       |
| **Reports: loaded**             | "Newest first. Nothing is marked handled — a report stays as the record that somebody complained.", above the list                                                                                 |
| **Reports: load failed**        | "Could not load the reports. Please try again." and a **Try again** button, in that same box — never the empty state, because a read that failed says nothing about whether anybody has complained |

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

Three cards on a light slate background — the lifetime totals, the player's level, then the avatar picker. **No route guard** — access is decided in-page, so an anonymous visitor gets an explanation rather than a silent redirect, the same choice `/review` and `/add-question` make.

### Hierarchy

- **Back link**: "← Back to game" → `/`
- **Title**: the player's avatar (a 48px circle — their initials, built avatar or Google photo; the neutral 👤 face for anybody not signed in) beside "Your stats", with a subtitle — "Your lifetime totals across every game you have finished while signed in. Only you can see them."
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
| **Last game not banked**   | "Your last game could not be added to your totals." (red)                                          | as loaded  | Start a game |

**"Last game not banked"** replaces the "no games banked yet" or "loaded" sentence when the server refused to bank the signed-in account's last game in this tab — both of those promise totals that are not coming. The numbers stay as loaded: em-dashes for an account with nothing banked, the earlier totals for one with some. It lasts as long as the tab, for that account only, and the live region says "Your last game could not be added to your stats."

**Every state is the same height**, and the construction is what makes that true rather than a measurement: each number is rendered from first paint as an em-dash, the six distinct status sentences are stacked in one grid cell so the space reserved is the tallest of them, and the three actions are one grid cell holding the same button box three times. Accuracy shows "—" rather than "0%" when no questions have been answered — `0 / 0` is `NaN`.

Two details a test has to know about. **"Sign in" is not rendered under `?embed=1`** (§11.7) — it opens the top bar's auth menu, and an embed has no top bar; the signed-out state is then the sentence alone, at the same height. And **"Try again" hands focus to the status line before it re-reads**, because the retry puts the card back into its loading state and hides the button that was focused; the status line is where the answer to the retry appears, and "Try again" is one Tab away from it if the second read fails too.

### The progress card (`ProgressCardComponent`, `FEAT-041`)

A second white card below the totals, headed **"Your level"**, with no action of its own — it shares the totals' read, so the totals card's "Try again" is its retry too.

- **Status line**: one sentence under the heading saying which state the card is in (below)
- **Level row**: a small grey "LEVEL" label beside the level in large type (3xl, extra-bold) on the left; the XP total ("340 XP") on the right
- **Progress bar**: a 10px rounded track, emerald fill showing the share of the current level earned, no animation; under it one grey line — "260 XP to level 3"
- **Unlock row**: a tinted rounded panel — a 40px avatar previewing the next set's first avatar (the neutral 👤 face for anybody not signed in), "**Bold avatars**", and under it one of three lines: "Unlock at level 3" with a lock icon at the right edge, for an account whose XP is short of it and for anybody not signed in; "Unlocked — choose one below" (emerald) once the level is reached; or, while the XP is being read or after the read failed, "Opens at level 3" with no lock — the reader may be well past it. The lock's space is kept

| State                         | Status line                                                                                                                     | Level / XP / bar                                       | Unlock row                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| **Auth still resolving**      | "Loading your level…"                                                                                                           | "—", "— XP", empty track, "—"                          | 👤, "Opens at level 3", no lock                                    |
| **Signed out / anonymous**    | "Sign in to earn experience points (XP) from the games you finish. Guest games earn none."                                      | "—", "— XP", empty track, "—"                          | 👤, "Unlock at level 3", lock                                      |
| **Read in flight**            | "Loading your level…"                                                                                                           | "—", "— XP", empty track, "—"                          | the bold preview over the initial, "Opens at level 3", no lock     |
| **Loaded**                    | "Right answers earn experience points (XP) — more for harder questions, and for a run of them in a row. Only you can see them." | the level, the XP, the bar filled, "N XP to level L+1" | "Unlock at level 3" and the lock, or "Unlocked — choose one below" |
| **Last game crossed a level** | "Your last game took you to level 3." (emerald)                                                                                 | as loaded                                              | as loaded                                                          |
| **Read failed**               | "Could not load your level just now." (red)                                                                                     | "—", "— XP", empty track, "—"                          | the bold preview over the initial, "Opens at level 3", no lock     |

**Loaded** includes an account with nothing banked: level 0, "0 XP", "100 XP to level 1". **"Last game crossed a level"** shows over loaded totals only, for the tab's lifetime, and the page's live region says it too: "Your stats are ready. Your last game took you to level 3."

**Every state is the same height**: every box is rendered from first paint and only filled, the sentences share one grid cell, and the unlock preview is the avatar component's fixed box. The bar is a `progressbar` named "Progress to the next level" only once it has a value — `aria-valuetext` reads "40 of 300 XP towards level 3" — and an empty track hidden from assistive tech otherwise.

### The avatar card (`AvatarPickerComponent`, `FEAT-038`)

A third white card, headed **"Your avatar"**, with a one-line status under the heading and one action at the foot.

- **"Show as"** — three tiles in a fixed three-column grid at every width, each a 40px avatar drawing itself above its label: **Initials**, **Google photo** (only for an account whose photo is on Google's image server — for any other account its cell is kept, empty and invisible, so the row is the same either way), **Build your own**. The chosen tile has an emerald border and tint. The photo tile is a preview, so opening the picker loads the photo from Google for an account that has one.
- **One block per set**, each a small bold heading over a **"Shape"** row and a **"Colour"** row of round 40px swatches. **Core** — dot, ring, diamond, square, triangle, plus; emerald, forest, gold, night, cocoa, mint — is open to every account. **Bold** — star, bolt, heart, crown, moon, shield; ruby, amber, blush, honey, slate, jade — unlocks at level 3, and its heading carries a line at the right: "Unlocks at level 3" with a lock icon, "Unlocked at level 3" (emerald), "Checking your level…" while the totals are being read, or "Could not check your level" when that read failed — no lock on either of the last two. Shapes are drawn in the current colour and colours with the current shape when the current avatar is from that set, and on the set's first otherwise — except in a set that cannot be chosen from right now, which is drawn around the stored avatar when that is from the set. The chosen one has an emerald ring. Picking either selects "Build your own"; while another kind is chosen, no group shows a choice.
- **A locked set is shown, not hidden**: all twelve of its swatches stay on the card at half opacity with a not-allowed cursor, `aria-disabled` and described by "Unlocks at level 3". A click, Space or an arrow key on one does nothing; Tab still stops on each group. While the level is being checked, or could not be checked, the swatches are held the same way but described by that line instead, and no lock is drawn. The block is identical in every state, so the card keeps its height. **The stored avatar is never held**: its own shape and colour swatches stay at full opacity and choosable in every state, and either one picks exactly it — so a bold avatar stored before a threshold moved, or worn while the level is unknown, stays checked and can be chosen again and saved.
- **A checkbox, "Show my avatar to other players"**, unchecked by default, with the line "Nothing in the app shows avatars to other players yet; this decides what happens when something does."
- **Action**: "Save avatar" (emerald). While a save is in flight it and every control above it are `aria-disabled` — dimmed, focus left where it was — and the status reads "Saving…".

| State                      | Status line                                                                                                                                    | Picker                   | Action      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------- |
| **Auth still resolving**   | "Loading your avatar…"                                                                                                                         | hidden, space kept       | —           |
| **Signed out / anonymous** | "Sign in to choose an avatar. A guest session has no account to keep one on."                                                                  | hidden, space kept       | Sign in     |
| **Email not verified**     | "Verify your email address to choose an avatar."                                                                                               | hidden, space kept       | —           |
| **Choice read in flight**  | "Loading your avatar…"                                                                                                                         | hidden, space kept       | —           |
| **Choice read failed**     | "Could not load your avatar just now." (red)                                                                                                   | hidden, space kept       | Try again   |
| **Ready**                  | "How you appear on your account button and on this page."                                                                                      | shown, the stored choice | Save avatar |
| **Saving**                 | "Saving…"                                                                                                                                      | shown, `aria-disabled`   | Save avatar |
| **Saved**                  | "Saved." (emerald)                                                                                                                             | shown                    | Save avatar |
| **Save failed**            | "Could not save your avatar. Please try again." (red)                                                                                          | shown                    | Save avatar |
| **Callable not deployed**  | "Avatars cannot be saved on this deployment yet." (red) — a preview channel                                                                    | shown                    | Save avatar |
| **Save timed out**         | "Your avatar could not be confirmed as saved. Reload in a moment to check." (amber) — the stored choice was read back and does not show it yet | shown                    | Save avatar |

**Every state is the same height**, by the stats card's construction: the status sentences share one grid cell, the picker is laid out in every state and hidden in all but one, and the three actions are one cell holding the same box three times. "Sign in" is not rendered under `?embed=1`. A save's outcome is announced through the page's one `sr-only` live region — "Avatar saved.", "Could not save your avatar.", "Avatars cannot be saved on this deployment yet.", "Your avatar could not be confirmed as saved." — replacing the stats announcement until the stats have something new to say.

---

## 9. Route: `/my-questions` — Your questions (`MyQuestionsComponent`)

Full-width list on the standard page ground. **No route guard** — a signed-out or anonymous visitor gets an explanation rather than a redirect, because an anonymous session can never have contributed a question and there is nowhere to redirect them to.

### Hierarchy

- **Back link**: "← Back to game" → `/`
- **Title**: "Your questions", with a subtitle — "Everything you have contributed to the shared bank, and what became of it. Editing a question sends it back for review; removing one takes it out of play."
- **Status block**: one grid cell holding all five messages, switched with `invisible` so the page does not resize when the read lands
- **Question list**: one card per contribution — the question text with a coloured **status pill** opposite it (amber "Pending review", emerald "Approved", red "Rejected"), then `Difficulty:` / `Submitted:` metadata, then a row of `#tag` **Topics** chips (`FEAT-021`) — the tag its category derives for a question written before topics replaced categories; on a rejected one, a red block headed "Why it was rejected" holding the reviewer's words or "No reason was given."
- **Action buttons** per card: **Edit** (pencil icon, outlined) and **Remove** (trash icon, red outline)
- **"Show more"** below the list, present only while there is a next page to fetch — it appends that page rather than replacing what is on screen

### States

| State                    | Content                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth still resolving** | "Loading your questions…" — the neutral state, never a claim about the account or its contributions                                                                          |
| **Signed out**           | "Sign in to see the questions you have contributed. Guest sessions cannot add questions, so there is nothing here for one." with a **Sign in** button (hidden in embed mode) |
| **Loading**              | "Loading your questions…"                                                                                                                                                    |
| **Nothing contributed**  | "You have not contributed a question yet." with an **Add a question** link to `/add-question`                                                                                |
| **Load failed**          | "Could not load your questions. Please try again." and a **Try again** button — never the empty state, because a read that failed says nothing about what has been written   |
| **Loaded**               | "Newest first." above the list                                                                                                                                               |

### Edit dialog

Modal over a dimmed backdrop, headed "Edit your question" with the note "Saving sends it back for review, so it will not be served until a reviewer approves it again." Body is the same field set as `/add-question` (§4) — topics, difficulty, question type, question, answers, source link, source name, justification — opening on the tag its category derives for a question written before topics replaced categories, and on as many wrong-answer rows as the question has (a five-option question opens on four; a true/false one on a new question's three empty rows, its one wrong answer being derived), with the same add and remove controls — followed by **Cancel** and **Save and resubmit** ("Saving…" while in flight). Escape or the backdrop closes it; a validation failure names the field in the shared summary and moves focus to it.

### Remove dialog

Modal headed "Remove this question from the app?", showing the question text, then: "It stops being served in games straight away. It does not withdraw the licence you granted when you contributed it, and it cannot reach copies already played or saved offline. See the Terms." Buttons **Cancel** and **Remove from the app** ("Removing…" while in flight). The copy deliberately never says "delete permanently" — the contributed-content licence is irrevocable, so that would be a promise the app cannot keep.

---

## 10. Route: `/quiz/:quizId` — Curated quiz (`QuizDetailComponent`)

One curated quiz (`FEAT-024`), reached from a card in the list on `/` or by its address. A single card on the standard page ground, top-aligned rather than centred, so it grows downwards and nothing above it moves. **No route guard** — an address naming no published quiz renders a not-found state inside the app rather than redirecting.

### Hierarchy

- **Back link**: "← Back to game" → `/`
- **Card**
  - A small emerald eyebrow: "Curated quiz"
  - **Title** (`h1`, focusable for the retry): the quiz's title — or "Loading quiz…", "Quiz not found", "This quiz could not be loaded" while there is none
  - **Description**, when the quiz has one
  - **Question count**: "{n} questions, in the order they were chosen" (or "1 question, …")
  - **Shortfall line** (amber), only when some of the quiz's questions cannot be played: "{n} of its {total} questions cannot be played right now, so it plays the other {m}."
  - **In-progress warning**, only when a game was already in progress when the quiz was read: "Starting this quiz replaces the game you have in progress."
  - **Field: "Time per Question"** — the setup screen's segmented control: "15 seconds", "30 seconds", "No limit", real radios hidden with `sr-only` in a `role="radiogroup"` labelled by the caption. When the quiz suggests a limit, a line under the caption says "Suggested for this quiz: {limit}." and that option starts selected; every option stays selectable
  - **Pace note** under the picker, one line reserved at the tallest of its three variants: "15 seconds a question. Quizzes are not ranked, so pick the pace that suits you." / "30 seconds a question. …" / "No countdown. Quizzes are not ranked, so take all the time you need."
  - **Daily allowance row** — the setup screen's: "Unlimited games with Pro." / "{n} of 5 free games left today." / "No free games left today."
  - **Start quiz** button (full width, emerald, sparkles icon) — "Starting…" and disabled while the game starts; or, when the day's free games are spent, the setup screen's amber Pro offer ("That's your 5 free games for today." · "They reset at midnight. Pro removes the limit entirely." · **See Pro**)
  - A red status line under Start, empty unless Start failed: "The quiz could not start. Please try again."
- An `sr-only` `role="status"` region announcing the outcome of the read: "Quiz ready: {n} questions." / "None of this quiz's questions can be played right now." / "Quiz not found." / "The quiz could not be loaded."

### States

| State                | Content                                                                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Loading**          | Eyebrow and "Loading quiz…" only — nothing pressable exists until the quiz does                                                                                                                                                                      |
| **Ready**            | Everything above                                                                                                                                                                                                                                     |
| **Nothing playable** | Title and description, then an amber notice: "None of this quiz's questions can be played right now, so it cannot start. Try another quiz, or a random game." and a **Play a random game** button → `/`                                              |
| **Not found**        | "Quiz not found", "There is no published quiz at this address. It may have been taken down, or the link may be incomplete." and **Play a random game** → `/` — a draft and a missing quiz look the same                                              |
| **Load failed**      | "This quiz could not be loaded", "Something went wrong while reading it. Please try again." — offline: "You're offline, and a quiz needs a connection to load its questions." — and **Try again**, which moves focus to the title before it re-reads |

---

## 11. Cross-cutting elements & patterns

### 11.1 PRO badge

A small rounded pill, bold uppercase "PRO" text. Two visual variants used consistently everywhere it appears (game-setup footer link, Auth Menu "Add a question" link, top-bar account trigger):

- **Locked** (non-Pro user): grey background, muted grey text
- **Unlocked** (Pro user): indigo-100 background, indigo-600 text (indigo-600/white on the "Add a question" button itself, which is solid indigo)

### 11.2 Buttons

Consistent visual vocabulary across the whole app:

- **Primary (hero CTAs)**: gradient indigo→violet fill, white text, elevated shadow that intensifies on hover (game setup's "Start Game", add-question's "Add Question", pricing's "Subscribe")
- **Primary (standard)**: solid indigo-600 background, white text, darkens on hover
- Both primary variants grey out (`disabled:bg-slate-300`/gradient-to-slate) and show a "not-allowed" cursor when disabled
- **Secondary / outlined**: white/transparent background, slate border, slate text, light grey hover fill
- **Danger-adjacent text buttons**: none — errors are always shown as banners, not button color changes
- **Destructive-looking dark button**: "Play Again" uses a dark slate fill (distinct from primary indigo), signaling a full reset action

### 11.3 Inline banners (consistent 3-color system across every screen)

- **Red** (`bg-red-50`/`border-red-200`/`text-red-700`): hard errors (failed save, failed load, failed submit)
- **Amber** (`bg-amber-50`/`border-amber-200`/`text-amber-700`): soft warnings / non-fatal notices (a topic-filtered draw that came back short; checkout cancelled; existing best score was already higher)
- **Green** (`bg-green-50`/`border-green-200`/`text-green-700`): success confirmations (score saved, question added, verification email sent, subscription active)
- **Indigo** (`bg-indigo-50`/`bg-indigo-100`): neutral call-to-action prompts, not errors (sign-in prompts, verify-email prompts, Pro upsell box, save-score prompt)
- Most banners now carry a small leading icon reinforcing their color (triangle-alert/circle-alert for amber/red, circle-check-big for green, mail for the verify-email prompt)

### 11.4 Loading / busy conventions

- Buttons that trigger an async action disable themselves and swap their label to a present-participle phrase ending in an ellipsis: "Loading Questions…", "Saving…", "Please wait…", "Redirecting…", "Opening billing portal…"
- The top bar and Pricing's Subscribe button both guard on `authReady()` specifically (distinct from "anonymous") to avoid a one-frame flash of the wrong state before Firebase's first auth callback resolves — shown as "Loading…" in both places.

### 11.5 Form field conventions

- All labels are `<label>` elements, small, semibold, slate-500/600, positioned directly above their control with a small gap
- All text/select inputs share the same shape: `rounded-xl` corners, thin slate border, indigo focus ring; `<select>`s use a custom chevron-down icon (native arrow hidden via `appearance-none`)
- Segmented "pill" radio groups (Question Source, Question Type, True/False, Multiple/True-False question type) are used instead of native radio buttons or dropdowns wherever the option set is small (2–3 choices) — the underlying `<input type="radio">` is visually hidden (`sr-only`) and its wrapping `<label>` is styled as the visible control, with the selected option getting an indigo-100 fill + indigo-600 bold text; unselected labels use slate-600 (not a lighter grey) to keep body text at a readable contrast ratio against the segmented control's slate-100 track

### 11.6 Elevation & shape tokens

Named Tailwind utilities (`src/styles.css`) codify `BRAND_DESIGN_SYSTEM.md`'s shadow scale so every surface pulls from the same set: `shadow-card` (subtle card shadow), `shadow-card-lg` (quiz/game-over/leaderboard cards), `shadow-hero-card` (game-setup's large gradient-backed card), `shadow-dropdown` (auth menu), `shadow-cta`/`shadow-cta-hover` (primary gradient buttons), `shadow-pro-card` (pricing's Pro card). Corner radii follow Tailwind's default scale: `rounded-3xl` (24px, cards), `rounded-2xl` (16px, dropdowns/sub-cards), `rounded-xl` (12px, buttons/inputs/segmented controls).

### 11.7 Embed mode (`?embed=1`)

- Top bar (and therefore the entire Auth Menu, sign-in affordances) is not rendered at all.
- Every other button that opens the auth menu is hidden with it, since there is nowhere for it to open a menu into: Game Over's "Sign in" in the anonymous-player prompt (§3), and `/profile`'s two "Sign in" buttons — the stats card's and the avatar card's — in the signed-out state (§8). Both leave the explanatory text, at the same height.
- The footer goes with it, and therefore the "Buy me a coffee" CTA and the donation dialog it mounts (§0.3) — an embedded widget is a game panel, not a site.
- **No sound plays.** Both copies of the mute live in the top bar — the icon button and the drawer row — so an embedded game with audio would be a noise the reader has no way to switch off.
- All other screens/logic behave identically; this only affects the top bar's and footer's presence, the sounds, and those auth-menu openers.

---

## 12. Full route table

| Path            | Component                 | Guard                                             | Purpose                                                   |
| --------------- | ------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| `/`             | `GameSetupComponent`      | none                                              | Configure & start a game; `?donation=` return             |
| `/play`         | `QuizLoopComponent`       | redirects to `/` if no active question in memory  | Answer questions against a timer                          |
| `/game-over`    | `GameOverComponent`       | redirects to `/` if no completed game in memory   | Final score, save to leaderboard, view top 10             |
| `/quiz/:quizId` | `QuizDetailComponent`     | none (an unknown id renders "Quiz not found")     | One curated quiz: what it is, its time limit, and Start   |
| `/add-question` | `AddQuestionComponent`    | none (in-page gating by auth/Pro state instead)   | Submit a question to the custom bank (Pro only)           |
| `/profile`      | `ProfileStatsComponent`   | none (in-page gating on a signed-in real account) | A player's own lifetime totals, and their avatar          |
| `/pricing`      | `PricingComponent`        | none                                              | Compare Starter vs. Pro, subscribe via Stripe             |
| `/review`       | `ReviewQueueComponent`    | none (in-page gating on the reviewer role)        | Approve or reject submitted questions; read filed reports |
| `/my-questions` | `MyQuestionsComponent`    | none (in-page gating on a signed-in real account) | An author's own contributions; edit or remove one         |
| `/privacy`      | `PrivacyPolicyComponent`  | none                                              | Published Privacy Policy                                  |
| `/terms`        | `TermsOfServiceComponent` | none                                              | Published Terms of Service                                |
| `*` (unmatched) | —                         | redirects to `/`                                  | —                                                         |

---

## 13. Full copy inventory (verbatim strings)

Grouped by screen, for quick reference when building Figma text styles / content models.

**Global / Top Bar / Auth Menu**: Trivimind · Pricing · Review · Your stats · Menu · Close menu · Site menu · Dark mode · Light mode · Mute sounds · Unmute sounds · Loading… · Sign in · Sign up · Create an account · Continue with Google · or · Email · Password · Please wait… · Already have an account? Sign in · Don't have an account? Sign up · More sign-in options · Hide other sign-in options · Facebook · GitHub · Microsoft · Apple · Twitter / X · Yahoo · Account created! We've sent a verification link to your email. · Verify your email · We sent a verification link to {{email}}. Verify it to finish signing in and save scores to the leaderboard. · Resend verification email · Verification email sent — check your inbox. · Sign out · Your profile · Display name · Save · Saved! · Verified · Your questions · Add a question · Upgrade to Pro to add questions · Manage subscription · Opening billing portal… · Could not update your name. Please try again. · Could not open the billing portal. Please try again. · Sign in before managing your subscription. · Timed out waiting for the billing portal to open. Please try again. · Too many attempts just now. Reload the page and try again in a few minutes. · Could not send the verification email. Please try again.

**Game Setup**: Trivimind · Configure your quiz and test your knowledge · No questions were found for the selected options. Try a different topic, difficulty, or source. · Failed to load questions. Please check your connection and try again. · Number of Questions · Difficulty · Any Difficulty · Easy · Medium · Hard · Question Source · Open Trivia · Custom · Mixed · Topics · (optional) · Pick one of the suggested topics, or none to play every topic. · Pick topics to play questions about exactly those subjects. · Pick topics to narrow the community half; a suggested one narrows Open Trivia too. · Community questions match any of these; Open Trivia ones cover every topic until you add a suggested one. · Community questions match any of these; Open Trivia ones follow #{{tag}}. · Open Trivia plays only the suggested topics — Custom and Mixed take any. · Open Trivia plays one suggested topic, so the others were removed. · Open Trivia plays only the suggested topics, so yours were removed. · No tags yet. · Type a topic and press Enter · Maximum reached · Add · Will be saved as #{{tag}} · Too long — a tag is at most 32 characters. · A tag needs at least 2 letters or digits. · {{n}} of {{max}} chosen. · Suggestions · Only {{n}} of the {{m}} questions you asked for match those topics. Start again to play the {{n}} we found. · Start Game · Play {{n}} Questions · Loading Questions… · + Create custom question

**Quiz Loop**: Question {{n}} / {{total}} · Score: {{n}} · #{{topic}} (topic badge) · (difficulty badge) · (streak badge: {{streak}} ×{{multiplier}}) · Question {{n}}: streak of {{n}}. Answers are now worth {{multiplier}} times their points. · Question {{n}}: streak lost. Answers are back to 1.0 times their points. · Correct! Well done. · Time's up! The answer was {{correct_answer}}. · Incorrect. The correct answer is {{correct_answer}}. · Lifelines · 50/50 · +15s · Skip · Fifty-fifty: remove every wrong answer but one. One use per game. · Fifty-fifty is unavailable on a question with two options. · Fifty-fifty already used. · Question {{n}}: Fifty-fifty used. {{n}} options remain. · Extra time: add 15 seconds to this question. One use per game. · Extra time already used. · Skip: move to the next question. It still counts toward your total. One use per game. · Skip already used. · Rate this question · Like this question · Dislike this question · Question {{n}}: you liked this question. · Question {{n}}: you disliked this question. · Question {{n}}: your vote was removed. · Question {{n}}: your vote could not be saved. Please try again. · Question {{n}}: your vote could not be removed. Please try again. · Question {{n}}: sign in to like or dislike questions. · Question {{n}}: verify your email to like or dislike questions.

**Game Over**: Game Over! · Here's how you did · Score · points · Accuracy · Correct · correct answers · Best streak · in a row · Outstanding! · Great job! · Good effort! · Keep practicing! · Score saved to the leaderboard! · You're ranked #{{n}} on the {{boardLabel}} leaderboard[ in {{country}}]. · Your best score is already higher ({{n}} points) — nice consistency! We kept your existing best. · Sign in to save this score to the leaderboard. · Verify your email to save this score to the leaderboard. · Enter your name · Save Score · Saving… · Country to rank in · Prefer not to say · Published beside your name and score on that country's public board, as well as the global one. Leave it unset and only the global board gets your score. · Could not save your score. Please try again. · Top 10 — {{boardLabel}} games · Which leaderboard to show · Global · Regional · Worldwide · In {{country}} · Your country · Loading leaderboard… · Could not load the leaderboard. Please try again later. · No scores yet. Be the first! · No scores in {{country}} yet. Be the first! · Choose your country in the save form above to see how you rank there. · Sign in and choose your country to see how you rank there. · Play Again · YOU (leaderboard badge for the current player's own row) · Review answers ({{n}}/{{total}} correct) · Your answers · Correct answer: · Source: · Machine-generated from · Machine-generated · (opens in a new tab) · Justification · No answer · Time expired · You skipped this · Rate this question · Like this question · Dislike this question (and the quiz's vote announcements, numbered by the row) · Questions you flagged · Found something wrong in this game? Report it here. · Quizzes aren't ranked on a leaderboard. · Everyone plays a quiz's questions in the same order, so its score stays off the board.

**Curated quizzes (on `/`)**: Curated quizzes · Questions somebody chose, played in the order they chose them. · {{n}} questions · 1 question · Needs a connection · {{n}} quizzes. · 1 quiz. · No quizzes have been published yet. · The quizzes could not be loaded. · You're offline, and the quizzes need a connection. · Try again

**Curated quiz (`/quiz/:quizId`)**: Back to game · Curated quiz · Loading quiz… · Quiz not found · There is no published quiz at this address. It may have been taken down, or the link may be incomplete. · Play a random game · This quiz could not be loaded · Something went wrong while reading it. Please try again. · You're offline, and a quiz needs a connection to load its questions. · Try again · None of this quiz's questions can be played right now, so it cannot start. Try another quiz, or a random game. · {{n}} questions, in the order they were chosen · {{n}} of its {{total}} questions cannot be played right now, so it plays the other {{m}}. · Starting this quiz replaces the game you have in progress. · Time per Question · Suggested for this quiz: {{limit}}. · 15 seconds · 30 seconds · No limit · 15 seconds a question. Quizzes are not ranked, so pick the pace that suits you. · 30 seconds a question. Quizzes are not ranked, so pick the pace that suits you. · No countdown. Quizzes are not ranked, so take all the time you need. · Unlimited games with Pro. · {{n}} of {{max}} free games left today. · No free games left today. · That's your {{max}} free games for today. · They reset at midnight. Pro removes the limit entirely. · See Pro · Start quiz · Starting… · The quiz could not start. Please try again. · Quiz ready: {{n}} questions. · None of this quiz's questions can be played right now. · Quiz not found. · The quiz could not be loaded.

**Add a Question**: Add a Question · Contribute a question to the shared custom bank · Sign in to submit a question to the shared bank. · Verify your email to submit a question. · This one's for Pro members · Upgrade to Pro to create and add your own questions to the shared question bank. · Upgrade to Pro · Thanks! Your question has been submitted for review. · Add another · Back to game · Topics · Add at least one topic. · Difficulty · Question Type · Multiple Choice · True / False · Question · What is the question? · Formatting · Plain text · Markdown & math · Paragraphs and line breaks, bold, italics, strikethrough, lists, quotes, links, inline code and code blocks, plus LaTeX between $…$ and $$…$$. Anything else is removed rather than shown. · Preview · {{n}} of 2000 characters · Question must be 2000 characters or fewer. · Correct Answer · True · False · Incorrect Answers · Incorrect answer {{n}} · Remove incorrect answer {{n}} · Add an answer · Two to six answers in all, counting the correct one. · Incorrect answer {{n}} added. The question now has {{n}} answers. · Incorrect answer {{n}} removed. The question now has {{n}} answers. · That is the most a question can have. · That is the fewest a question can have. · Source link · (optional) · Where the answer comes from. Reviewers see it, and so do players after they answer. · Source name · Justification · Why is the right answer right, and why are the others wrong? · Only needed for a tricky question — where knowing the subject still isn't enough to see why the right answer is right. Reviewers see it, and so do players after they answer. · A few words for what this question is about, so players can ask for exactly this subject. Reviewers see them too. · Could not save your question. Please try again. · Cancel · Add Question

**Pricing**: Back to game · Pricing · Play free forever, or go Pro to contribute your own questions. · Subscription started! It may take a few seconds to finish activating. · Start playing · Dismiss · Checkout was cancelled — no charge was made. · Starter · Everything you need to play and compete. · Free ($0/month) · Play unlimited games · Submit scores to the global leaderboard · Your current plan · Pro · Contribute questions and shape the game. · {amount}/month · Currency · USD · BRL · Everything in Starter · Create and add custom questions to the global question bank · More features coming soon · You're subscribed · Loading… · Sign in to subscribe · Redirecting… · Subscribe · Subscribe — {amount}/mo · Verify your email first, then come back to subscribe. · Could not start checkout. Please try again. · Sign in before subscribing. · Pro isn't available to buy right now — no active monthly Pro price is set up. Please try again later. · Timed out waiting for Stripe checkout to start. Please try again. · Too many attempts just now. Reload the page and try again in a few minutes. · Could not start checkout. Please reload the page and try again. · Your account is already set up to pay in {currency}, so Pro can only be bought in {currency} from this account. · Cancel anytime. No hidden fees.

**Review Queue**: Review Queue · Back to game · Choose what to review · Pending · Approved · Rejected · Reports · Checking your access… · Loading… · Correct answer: · Difficulty: · Submitted: · Status: · Author: · Unattributed (predates attribution) · Question pipeline · Run: · Machine-generated from · Machine-generated · Topics · Reason for rejecting (optional) · Reason shown to the author (optional) · Reason kept on the record (optional) · What would have to change for this to be approved? · A reason must be 500 characters or fewer. · A rejection reason has to be 500 characters or fewer. · Question marked {{status}}. · Reason updated. · Reason cleared. · Approve · Reject · Update reason · This page is for question reviewers. If you think you should have access, ask the site owner. · Questions players have contributed to the shared bank, and the reports players have filed about them. Rejecting a question stops it being served in games; it is not deleted. · Nothing {{status}} right now. · Could not load the queue. Please try again. · Try again · Could not save that decision. Please try again. · Showing the first {{n}}. Review these and reload for more. · Everything this account contributed · Back to {{tab}} · The account that wrote: · Every status, newest first, 50 to a page. Rejecting stops a question being served and shows your reason to its author; nothing is deleted, and any of them can be approved again from the Rejected tab. Suspending or deleting the account itself is not done here — the site owner does that in the Firebase console. · Loading this account’s contributions… · Nothing this account contributed is in the bank any more. · There is nothing older from this account. · Could not load this account’s contributions. · {{n}} contributions, newest first. · Page {{n}}: {{m}} contributions, newest first. · Select all on this page · {{n}} of {{m}} selected · Everything on this page is already rejected. · Rejecting… {{n}} of {{m}} · Select at least one question to reject. · Reason for rejecting (required) · Shown to the author on every question this rejects. · Give a reason — it is shown to the author on every question this rejects. · Reject selected · Rejecting… · Rejected 1 question. · Rejected {{n}} questions. · Rejected {{k}} of {{n}}. 1 could not be confirmed and is still selected — try again. · Rejected {{k}} of {{n}}. {{n − k}} could not be confirmed and are still selected — try again. · That question could not be confirmed and is still selected — try again. · None of the {{n}} could be confirmed. They are still selected — try again. · Select question {{n}} · Pending review · Approved · Rejected · Unknown · Newer contributions · Older contributions · Selection cleared. · {{n}} selected on this page. · Loading reports… · No reports have been filed. · Newest first. Nothing is marked handled — a report stays as the record that somebody complained. · Could not load the reports. Please try again. · The answer is wrong · Inappropriate or offensive · Spam or nonsense · Something else · Reported {{date}} · Question {{id}} is no longer in the bank, so there is nothing left to act on. · Show more reports

**Your questions**: Back to game · Your questions · Everything you have contributed to the shared bank, and what became of it. Editing a question sends it back for review; removing one takes it out of play. · Loading your questions… · Sign in to see the questions you have contributed. Guest sessions cannot add questions, so there is nothing here for one. · Sign in · You have not contributed a question yet. · Add a question · Could not load your questions. Please try again. · Could not load more of your questions. Please try again. · Try again · Newest first. · Pending review · Approved · Rejected · Unknown · Difficulty: · Submitted: · Topics · Why it was rejected · No reason was given. · Edit · Remove · Show more · Edit your question · Saving sends it back for review, so it will not be served until a reviewer approves it again. · Cancel · Save and resubmit · Saving… · Could not save your changes. Please try again. · Remove this question from the app? · It stops being served in games straight away. It does not withdraw the licence you granted when you contributed it, and it cannot reach copies already played or saved offline. See the Terms. · Remove from the app · Removing… · Could not remove that question. Please try again. · Question updated. It is pending review again. · Question removed from the app.

**Your stats**: Back to game · Your stats · Your lifetime totals across every game you have finished while signed in. Only you can see them. · Loading your lifetime totals… · Sign in and your totals start counting from the next game you finish. · Nothing banked yet — finish a game and your totals will show up here. · Could not load your stats just now. · Your last game could not be added to your totals. · Tracking since {{date}}. · Tracking your lifetime totals. · Games played · Questions answered · Correct answers · Accuracy · Best streak · Start a game · Sign in · Try again · Your stats are ready. · Your stats are ready. Your last game took you to level {{level}}. · No finished games yet. · Signed out. Stats are only kept for a signed-in account. · Could not load your stats. · Your last game could not be added to your stats. · Your level · Loading your level… · Sign in to earn experience points (XP) from the games you finish. Guest games earn none. · Could not load your level just now. · Right answers earn experience points (XP) — more for harder questions, and for a run of them in a row. Only you can see them. · Your last game took you to level {{level}}. · Level · {{xp}} XP · {{xp}} XP to level {{level}} · Progress to the next level · {{into}} of {{span}} XP towards level {{level}} · Bold avatars · Opens at level 3 · Unlock at level 3 · Unlocked — choose one below · Your avatar · Loading your avatar… · Sign in to choose an avatar. A guest session has no account to keep one on. · Verify your email address to choose an avatar. · Could not load your avatar just now. · How you appear on your account button and on this page. · Saving… · Saved. · Avatars cannot be saved on this deployment yet. · Could not save your avatar. Please try again. · Your avatar could not be confirmed as saved. Reload in a moment to check. · Show as · Initials · Google photo · Build your own · Core · Shape · Dot · Ring · Diamond · Square · Triangle · Plus · Colour · Emerald · Forest · Gold · Night · Cocoa · Mint · Bold · Checking your level… · Could not check your level · Unlocks at level {{level}} · Unlocked at level {{level}} · Star · Bolt · Heart · Crown · Moon · Shield · Ruby · Amber · Blush · Honey · Slate · Jade · Show my avatar to other players · Nothing in the app shows avatars to other players yet; this decides what happens when something does. · Save avatar · Avatar saved. · Could not save your avatar. · Your avatar could not be confirmed as saved.

**Donation dialog**: Buy me a coffee · Close · Trivimind is free to play and always will be. A one-off tip helps pay for the servers. · Currency · USD · BRL · Amount · You're not signed in, so this donation won't be recorded against an account. Sign in first if you'd like it linked to yours. · Donate · Donate {amount} · Redirecting… · A one-off payment through Stripe. It buys nothing and is not refundable by default — see the Terms. · Donations aren't available right now — no donation amounts are set up. Please try again later. · Could not start the donation. Please try again. · The donation could not be started. Please try again. · Timed out waiting for the donation page to open. Please try again. · Still starting up — try that again in a moment. · Could not start the donation. Please reload the page and try again. · Your account is already set up to pay in {currency}, so a donation can only be made in {currency} from this account. · Thank you — your coffee is very much appreciated. · Donation cancelled — nothing was charged. · Dismiss

**Legal pages (`/privacy`, `/terms`)**: Back to Trivimind · Last updated: {{date}} · In force, but not yet reviewed by a lawyer · This document applies to your use of the service today, and everything it says about what the app does with your information was written by reading the application's own source code — so it describes real behaviour rather than what a template assumes. What it has not had is a professional legal review. If you spot something wrong, unclear, or missing, please write to {{contactEmail}} — that is genuinely useful and it will be fixed.

**Auth error messages** (surfaced verbatim in the red banner of the sign-in/sign-up form, mapped from Firebase Auth error codes): "This sign-in method isn't enabled yet." · "An account with this email already exists. Try signing in instead." · "That email address looks invalid." · "Choose a stronger password (at least 6 characters)." · "Incorrect email or password." · "No account found with this email." · "This account is already linked to another user." · "Network error. Please check your connection and try again." · "Something went wrong. Please try again." (default fallback) · "Email aliases (e.g. \"name+tag@domain.com\") aren't allowed. Please use your plain email address." (client-side, sign-up only)
