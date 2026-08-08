## 1. Material Design 3 Color Palette (Emerald & Gold)

### Primary Tonal System (Emerald Green)

- **Primary (`#059669`)**: Logo header, focus states, icon-only badges, borders, and large-text (≥24px) headings/prices. **Not** used as a solid fill behind white text at body/button size — see the CTA note below.
- **On Primary (`#FFFFFF`)**: Text/icons rendered over the Primary color.
- **Primary Container (`#D1FAE5`)**: Light emerald background (segmented radio selected fills, callout cards).
- **On Primary Container (`#064E3B`)**: Text/icons inside Primary Container elements.
- **CTA fill (`#047857`, Emerald 700)**: Solid buttons and badges that carry white text (e.g. "Start Game", "Subscribe", avatar initials, the PRO ribbon). `#059669` (Primary) measures only ~3.7:1 against white — short of the 4.5:1 WCAG AA minimum for body-size text — so every button/badge with white text uses this one step darker instead. Hover states go one step darker again (`#065F46`, Emerald 800).

### Secondary Tonal System (Trophy Gold)

- **Secondary (`#D97706`)**: Gamification highlights, top-rank badges.
- **Secondary Container (`#FEF3C7`)**: Category pill tags, secondary active badges, highlight containers.
- **On Secondary Container (`#78350F`)**: Text inside secondary gold pill tags.

### Neutral & Surface System

- **Surface Background (`#F7F9F8`)**: Page background (Subtle warm light tint).
- **Surface Container / Card (`#FFFFFF`)**: Central cards, modals, dropdowns (Pure White).
- **Outline / Border (`#E2E8F0`)**: Card borders, input field outlines, secondary buttons.
- **On Surface (High Contrast) (`#0F172A`)**: Headings, body text (Slate 900).
- **On Surface Variant (Muted) (`#64748B`)**: Labels, subheadings, placeholders (Slate 500).

### Status & Feedback System (6.3 In-App System)

- **Error / Correct-Incorrect System**:
- **Success Surface (`#ECFDF5`) / Border (`#A7F3D0`) / Text (`#047857`)**: Correct answer, score saved, verified status.
- **Error Surface (`#FEF2F2`) / Border (`#FECACA`) / Text (`#B91C1C`)**: Wrong answer, timer warning (≤5s), error banners.
- **Warning Surface (`#FFFBEB`) / Border (`#FDE68A`) / Text (`#B45309`)**: Amber warnings, unverified email dot, non-fatal notes.
- **Pro Badge (Unlocked)**: `#D97706` fill (Gold) with `#FFFFFF` text.
- **Pro Badge (Locked)**: `#E2E8F0` fill with `#64748B` text.

### Dark Theme

A manual light/dark toggle (top-bar sun/moon button, `ThemeService`) applies a `dark` class on `<html>` — Tailwind's `dark:` variant is repointed at that class (`@custom-variant dark` in `src/styles.css`) rather than the default `prefers-color-scheme` media strategy, since a real toggle needs to be able to override the OS setting. The initial value still defaults to the OS preference (via an inline no-flash script in `index.html`) when there's no stored choice yet.

Dark-mode token mapping, applied via `dark:` utility variants alongside every light-mode class rather than as a separate stylesheet:

- **Page background**: `slate-50` → `slate-950`.
- **Surface / Card**: `white` → `slate-900`; a secondary/inset panel (e.g. stat tiles) uses `slate-800`/`slate-800/60`.
- **Outline / Border**: `slate-900/N%` opacity borders → `white/N%` at the same opacity step (e.g. `border-slate-900/8` → `dark:border-white/10`).
- **On Surface (headings/body)**: `slate-900` → `slate-50`; `slate-700` → `slate-300`; `slate-600`/`slate-500` → `slate-400`; `slate-400` → `slate-500`.
- **Primary (brand emerald)**: `emerald-600` text/headings → `dark:text-emerald-400` (better contrast against a dark surface); solid `emerald-700` CTA fills are unchanged in dark mode — they already meet contrast against white button text regardless of page theme.
- **Primary Container**: `emerald-50`/`emerald-100` tinted surfaces (badges, callouts, PRO pills) → `emerald-500/10`–`/20` translucent fills with `emerald-300`/`emerald-400` text, rather than a solid dark-emerald swatch — keeps them legible at low opacity over any dark surface.
- **Status surfaces** (success/error/warning banners): same translucent-fill pattern — `{color}-50`/`{color}-200` → `dark:bg-{color}-500/10 dark:border-{color}-500/20 dark:text-{color}-300`.
- **Inverted neutral CTA** ("Play Again", `bg-slate-900` on white text): flips to a light fill in dark mode (`dark:bg-slate-100 dark:text-slate-900`) rather than disappearing into the dark background.

---

## 2. Brand Manual & Design Guidelines (Material 3 Expressive — Emerald & Gold)

### Typography Hierarchy (Roboto / Inter)

- **Display Large** (App Title / Game Over): Bold, 32px / 40px line-height.
- **Headline Medium** (Question Text): Bold, 22px / 28px line-height.
- **Title Medium** (Card Titles / Section Heads): Semi-Bold, 18px / 24px line-height.
- **Body Large / Medium** (Inputs, Subtitles, Answers): Regular, 16px / 14px.
- **Label Small** (Badges, Chips, Segmented Radio Labels): Medium/Bold, 12px, Uppercase tracking.

### Component Styling Directives

1. **Cards & Surface Elevation**:

- Centered containers max-width 480px (game setup/loops) and 960px (2-column pricing comparison).
- Soft M3 elevated shadows (`0px 4px 20px rgba(5, 150, 105, 0.06)`), rounded corners (`16px` border-radius).

2. **Buttons & Inputs**:

- Corner radius: `12px` (Medium shape scale).
- Height: `48px` standard for primary touch targets.
- Inputs: `1px` border (`#E2E8F0`), active focus ring `2px` (`#059669`).
- **Solid fills only — no gradients** on buttons or icon badges. Reserve gradients (if used at all) for large decorative surfaces only (e.g. a full-page hero background), never anything a user clicks or a glyph sits on top of.

3. **Segmented Radio Groups**:

- Container radius `12px`, padding `4px`. Unselected segments have no border and muted text. Selected segment has full `#D1FAE5` surface and `#059669` outline with bold text.
