import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The Trivimind brand mark, kept as a self-contained inline SVG (a rounded
 * square + white "?" glyph, sourced from public/favicon.svg) — same
 * no-CDN/no-icon-library convention as ProviderIconComponent's OAuth brand
 * marks, rather than fitting it into IconComponent's single-color
 * stroke-icon system, since this is a fixed filled mark, not a 24x24
 * stroke glyph. The background fills with `currentColor` (like
 * IconComponent's `stroke="currentColor"`), so callers set the exact brand
 * shade via a `text-*` class on `app-logo` itself, e.g. `text-emerald-600`
 * — favicon.svg hardcodes that same hex since static icon files have no
 * ambient CSS `color` to inherit from.
 *
 * `host: { class: 'inline-block' }` matters: without it this element's
 * display defaults to a plain block box with `width: auto`, which (unlike
 * the inner `<svg>`, a replaced element sized by its own width/height
 * attributes) has no intrinsic size and stretches to fill its container —
 * any `rounded-*`/`shadow-*` class on `app-logo` would then wrap that
 * full-width invisible box instead of the icon itself.
 */
@Component({
  selector: 'app-logo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-block' },
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 144 144"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g>
        <rect width="144" height="144" rx="32" fill="currentColor" id="rect1" x="0" y="0" />
        <!--
          fill is a presentation attribute, deliberately not an inline style.
          The CSP (firebase.json) sets style-src 'self' with no unsafe-inline,
          which blocks style *attributes* — so the white glyph silently lost
          its fill and rendered in the inherited colour. A presentation
          attribute is not a style declaration at all, so CSP doesn't touch it.

          Dropped alongside it was Inkscape residue from when this shape was a
          text element: font-weight, font-size, font-family,
          -inkscape-font-specification and text-anchor have no effect on a
          path, and stroke-width does nothing without a stroke.
        -->
        <path
          fill="#ffffff"
          d="m 86.341855,97.958512 q -2.2884,-0.837181 -4.077252,-1.666404 -1.764717,-1.057617 -3.344207,-2.68423 -4.625649,-4.763652 -5.633769,-10.613572 -1.008113,-5.849921 -1.492542,-11.920278 -0.347471,-6.182565 -1.468411,-12.148674 -1.12094,-5.966106 -5.972229,-10.962133 -5.415399,-5.576963 -12.368706,-4.886998 -6.81636,0.577742 -12.705435,5.402682 -3.69779,3.029611 -5.848653,5.626306 -2.126726,2.368304 -3.230218,4.524126 -0.966546,2.043606 -1.159618,3.870764 -0.305889,1.710975 -0.474836,3.309733 3.101701,-2.123988 7.299625,-1.599559 4.085104,0.408242 7.469725,3.893841 3.723086,3.834159 4.07841,8.758567 0.379457,4.696013 -5.920479,9.85757 -4.382563,3.590645 -10.07915,3.042347 -5.696574,-0.548305 -9.870944,-4.847212 -3.384622,-3.485601 -5.327291,-8.778467 -1.805714,-5.405058 -0.743209,-11.908335 1.199451,-6.615484 6.016441,-14.317228 4.816983,-7.701751 14.814711,-15.892918 6.847761,-5.610389 14.050269,-9.842452 7.202508,-4.232064 14.252349,-5.835606 7.186805,-1.71574 13.898775,-0.121764 6.71196,1.593984 12.465821,7.519502 5.30257,5.460775 6.447645,11.198491 1.282032,5.625503 0.428889,11.331385 -0.853136,5.705881 -2.955153,11.391868 -1.965063,5.573779 -3.293615,11.043309 -1.328557,5.469531 -0.997363,10.62233 0.468144,5.040596 4.368603,9.563916 z m 14.181685,5.487828 q 2.60215,-2.13195 5.696,-2.99778 3.11799,-1.09423 6.22811,-0.930291 2.99731,0.04774 5.87395,1.237461 2.76383,1.07354 4.7946,3.16488 4.28719,4.4151 3.77252,10.46954 -0.62752,5.93827 -5.83181,10.20215 -2.60214,2.13194 -5.72012,3.22618 -3.11799,1.09422 -6.25225,1.15873 -3.11013,-0.16394 -5.87395,-1.23748 -2.87664,-1.1897 -5.020231,-3.39725 -2.030769,-2.09135 -2.877217,-4.73579 -0.822315,-2.87285 -0.532692,-5.61357 0.313747,-2.96911 1.715282,-5.57777 1.425671,-2.83702 4.027818,-4.96897 z"
          id="text1"
          aria-label="?"
        />
      </g>
    </svg>
  `,
})
export class LogoComponent {
  readonly size = input<number>(24);
}
