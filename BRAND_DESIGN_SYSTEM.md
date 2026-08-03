## 1. Material Design 3 Color Palette

To reflect the energy of a trivia game while remaining crisp, readable, and aligned with Material Design 3 guidelines (M3 Roles & Tonal Palettes), we use **Deep Indigo** as the primary brand anchor, balanced by **Electric Violet** for game highlights and **Warm Amber** for accents/badges.

### Primary Tonal System (Indigo)

* **Primary (`#4F46E5`)**: Main CTA buttons, active radio segments, logo header, focus states.
* **On Primary (`#FFFFFF`)**: Text/icons rendered over the Primary color.
* **Primary Container (`#E0E7FF`)**: Light indigo backgrounds (segmented radio selected fills, callout cards).
* **On Primary Container (`#312E81`)**: Text/icons inside Primary Container elements.

### Secondary Tonal System (Violet & Slate)

* **Secondary (`#7C3AED`)**: Gamification highlights, progress bars, countdown timer border.
* **Secondary Container (`#EDE9FE`)**: Category pill tags, secondary active badges.
* **On Secondary Container (`#4C1D95`)**: Text inside secondary pill tags.

### Neutral & Surface System

* **Surface Background (`#F8FAFC`)**: Page background (Slate 50).
* **Surface Container / Card (`#FFFFFF`)**: Central cards, modals, dropdowns (Slate White).
* **Outline / Border (`#E2E8F0`)**: Card borders, input field outlines, secondary buttons (Slate 200).
* **On Surface (High Contrast) (`#0F172A`)**: Headings, body text (Slate 900).
* **On Surface Variant (Muted) (`#64748B`)**: Labels, subheadings, placeholders (Slate 500).

### Status & Feedback System (6.3 In-App System)

* **Error / Correct-Incorrect System**:
* **Success Surface (`#F0FDF4`) / Border (`#BBF7D0`) / Text (`#15803D`)**: Correct answer, score saved, verified status.
* **Error Surface (`#FEF2F2`) / Border (`#FECACA`) / Text (`#B91C1C`)**: Wrong answer, timer warning (≤5s), error banners.
* **Warning Surface (`#FFFBEB`) / Border (`#FDE68A`) / Text (`#B45309`)**: Amber warnings, unverified email dot, non-fatal notes.
* **Pro Badge (Unlocked)**: `#4F46E5` fill with `#FFFFFF` text.
* **Pro Badge (Locked)**: `#E2E8F0` fill with `#64748B` text.



---

## 2. Brand Manual & Design Guidelines (Material 3 Expressive)

### Typography Hierarchy (Roboto / Inter)

* **Display Large** (App Title / Game Over): Bold, 32px / 40px line-height.
* **Headline Medium** (Question Text): Bold, 22px / 28px line-height.
* **Title Medium** (Card Titles / Section Heads): Semi-Bold, 18px / 24px line-height.
* **Body Large / Medium** (Inputs, Subtitles, Answers): Regular, 16px / 14px.
* **Label Small** (Badges, Chips, Segmented Radio Labels): Medium/Bold, 12px, Uppercase tracking.

### Component Styling Directives

1. **Cards & Surface Elevation**:
* Centered containers max-width 480px (for game loops and forms) and 960px (for 2-column pricing comparison).
* Soft M3 shadows (`0px 4px 20px rgba(15, 23, 42, 0.08)`), rounded corners (`16px` border-radius).


2. **Buttons & Inputs**:
* Corner radius: `12px` (Medium shape scale).
* Height: `48px` standard for primary touch targets.
* Inputs: `1px` border (`#E2E8F0`), active focus ring `2px` (`#4F46E5`).


3. **Segmented Radio Groups**:
* Container radius `12px`, padding `4px`. Unselected segments have no border and muted text. Selected segment has full `#E0E7FF` surface and `#4F46E5` outline with bold text.
