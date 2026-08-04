## 1. Material Design 3 Color Palette (Monochrome & Slate Gray)

### Primary Tonal System (Obsidian & Charcoal)

* **Primary (`#18181B`)**: Main CTA buttons, active radio segments, logo header, active focus outlines (Zinc 900).
* **On Primary (`#FFFFFF`)**: Pure white text/icons rendered over the Primary color.
* **Primary Container (`#E4E4E7`)**: Light gray background for segmented radio selected fills, active tab surfaces, and callout cards (Zinc 200).
* **On Primary Container (`#09090B`)**: Deep charcoal text/icons inside Primary Container elements (Zinc 950).

### Secondary Tonal System (Cool Slate)

* **Secondary (`#52525B`)**: Sub-elements, secondary indicators, countdown timer border, structural highlights (Zinc 600).
* **Secondary Container (`#F4F4F5`)**: Category pill tags, secondary active badges, subtle surface highlights (Zinc 100).
* **On Secondary Container (`#27272A`)**: Text inside secondary gray pill tags (Zinc 800).

### Neutral & Surface System

* **Surface Background (`#FAFAFA`)**: Page background (Zinc 50).
* **Surface Container / Card (`#FFFFFF`)**: Central cards, modals, dropdowns (Pure White).
* **Outline / Border (`#E4E4E7`)**: Card borders, input field outlines, secondary buttons (Zinc 200).
* **On Surface (High Contrast) (`#09090B`)**: Headings, primary body text (Zinc 950).
* **On Surface Variant (Muted) (`#71717A`)**: Labels, subheadings, placeholder text (Zinc 500).

### Status & Feedback System (6.3 In-App System)

* **Error / Correct-Incorrect System**:
* **Success Surface (`#F0FDF4`) / Border (`#BBF7D0`) / Text (`#15803D`)**: Correct answer, score saved, verified status.
* **Error Surface (`#FEF2F2`) / Border (`#FECACA`) / Text (`#B91C1C`)**: Wrong answer, timer warning (≤5s), error banners.
* **Warning Surface (`#FFFBEB`) / Border (`#FDE68A`) / Text (`#B45309`)**: Amber warnings, unverified email dot, non-fatal notes.
* **Pro Badge (Unlocked)**: `#18181B` fill (Obsidian) with `#FFFFFF` text.
* **Pro Badge (Locked)**: `#E4E4E7` fill with `#71717A` text.



---

## 2. Brand Manual & Design Guidelines (Material 3 Expressive — Monochrome & Slate)

### Typography Hierarchy (Roboto / Inter)

* **Display Large** (App Title / Game Over): Bold, 32px / 40px line-height.
* **Headline Medium** (Question Text): Bold, 22px / 28px line-height.
* **Title Medium** (Card Titles / Section Heads): Semi-Bold, 18px / 24px line-height.
* **Body Large / Medium** (Inputs, Subtitles, Answers): Regular, 16px / 14px.
* **Label Small** (Badges, Chips, Segmented Radio Labels): Medium/Bold, 12px, Uppercase tracking.

### Component Styling Directives

1. **Cards & Surface Elevation**:
* Centered containers max-width 480px (game setup/loops) and 960px (2-column pricing comparison).
* Very subtle, crisp shadows (`0px 4px 16px rgba(0, 0, 0, 0.05)`), rounded corners (`16px` border-radius).


2. **Buttons & Inputs**:
* Corner radius: `12px` (Medium shape scale).
* Height: `48px` standard for primary touch targets.
* Inputs: `1px` border (`#E4E4E7`), active focus ring `2px` (`#18181B`).


3. **Segmented Radio Groups**:
* Container radius `12px`, padding `4px`. Unselected segments have no border and muted text (`#71717A`). Selected segment has full `#E4E4E7` surface and `#18181B` outline with bold text (`#09090B`).