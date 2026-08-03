## 1. Material Design 3 Color Palette (Emerald & Gold)

### Primary Tonal System (Emerald Green)

* **Primary (`#059669`)**: Main CTA buttons, active radio segments, logo header, focus states.
* **On Primary (`#FFFFFF`)**: Text/icons rendered over the Primary color.
* **Primary Container (`#D1FAE5`)**: Light emerald background (segmented radio selected fills, callout cards).
* **On Primary Container (`#064E3B`)**: Text/icons inside Primary Container elements.

### Secondary Tonal System (Trophy Gold)

* **Secondary (`#D97706`)**: Gamification highlights, progress bars, countdown timer border, top-rank badges.
* **Secondary Container (`#FEF3C7`)**: Category pill tags, secondary active badges, highlight containers.
* **On Secondary Container (`#78350F`)**: Text inside secondary gold pill tags.

### Neutral & Surface System

* **Surface Background (`#F7F9F8`)**: Page background (Subtle warm light tint).
* **Surface Container / Card (`#FFFFFF`)**: Central cards, modals, dropdowns (Pure White).
* **Outline / Border (`#E2E8F0`)**: Card borders, input field outlines, secondary buttons.
* **On Surface (High Contrast) (`#0F172A`)**: Headings, body text (Slate 900).
* **On Surface Variant (Muted) (`#64748B`)**: Labels, subheadings, placeholders (Slate 500).

### Status & Feedback System (6.3 In-App System)

* **Error / Correct-Incorrect System**:
* **Success Surface (`#ECFDF5`) / Border (`#A7F3D0`) / Text (`#047857`)**: Correct answer, score saved, verified status.
* **Error Surface (`#FEF2F2`) / Border (`#FECACA`) / Text (`#B91C1C`)**: Wrong answer, timer warning (≤5s), error banners.
* **Warning Surface (`#FFFBEB`) / Border (`#FDE68A`) / Text (`#B45309`)**: Amber warnings, unverified email dot, non-fatal notes.
* **Pro Badge (Unlocked)**: `#D97706` fill (Gold) with `#FFFFFF` text.
* **Pro Badge (Locked)**: `#E2E8F0` fill with `#64748B` text.



---

## 2. Brand Manual & Design Guidelines (Material 3 Expressive — Emerald & Gold)

### Typography Hierarchy (Roboto / Inter)

* **Display Large** (App Title / Game Over): Bold, 32px / 40px line-height.
* **Headline Medium** (Question Text): Bold, 22px / 28px line-height.
* **Title Medium** (Card Titles / Section Heads): Semi-Bold, 18px / 24px line-height.
* **Body Large / Medium** (Inputs, Subtitles, Answers): Regular, 16px / 14px.
* **Label Small** (Badges, Chips, Segmented Radio Labels): Medium/Bold, 12px, Uppercase tracking.

### Component Styling Directives

1. **Cards & Surface Elevation**:
* Centered containers max-width 480px (game setup/loops) and 960px (2-column pricing comparison).
* Soft M3 elevated shadows (`0px 4px 20px rgba(5, 150, 105, 0.06)`), rounded corners (`16px` border-radius).


2. **Buttons & Inputs**:
* Corner radius: `12px` (Medium shape scale).
* Height: `48px` standard for primary touch targets.
* Inputs: `1px` border (`#E2E8F0`), active focus ring `2px` (`#059669`).


3. **Segmented Radio Groups**:
* Container radius `12px`, padding `4px`. Unselected segments have no border and muted text. Selected segment has full `#D1FAE5` surface and `#059669` outline with bold text.