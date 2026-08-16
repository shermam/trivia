import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MASKABLE_SAFE_RADIUS_FRACTION, measureIcon } from './icon-geometry.mjs';

/**
 * Regenerates the `purpose: "maskable"` PWA icons from `public/favicon.svg`.
 *
 * Run this only when the mark itself changes; the outputs are committed.
 *
 *   node scripts/make-maskable-icons.mjs
 *
 * Needs a Chromium binary (see CHROME_CANDIDATES). `npm run icons:verify` does
 * not — it is pure Node, which is why *that* one is the check that runs in CI
 * and this one is not.
 *
 * ## Why a separate icon rather than a `purpose: "any maskable"` on the
 * existing ones
 *
 * Android composes a maskable icon under a mask it chooses — circle, squircle,
 * rounded square, teardrop, per OEM — and only guarantees a centred circle of
 * 80% diameter survives. The Trivimind mark was drawn as a favicon: measured,
 * its glyph reaches 49.9% of the canvas width against a 40% budget, so it
 * overshoots by ×1.247 and a circular mask clips the "?" mid-stroke. Claiming
 * `maskable` on it would be an unverified claim that looks fine in the
 * manifest and wrong on a phone.
 *
 * So the maskable variant is the same mark, scaled down inside a full-bleed
 * ground, shipped under its own filenames. The `any` icons keep their exact
 * current bytes — a padded icon shown unmasked just looks small.
 *
 * ## Two things that are easy to get wrong
 *
 * - **The rounded corners have to go.** A maskable icon's canvas belongs to
 *   the OS; a transparent or rounded corner shows the launcher background
 *   through and produces an icon-inside-an-icon. Full-bleed square, and the
 *   verifier asserts all four corners are opaque.
 * - **Never overwrite the existing files.** `firebase.json` serves images
 *   `immutable` for a year, so a replaced `icon-512x512.png` stays wrong in
 *   clients' caches for that long. New names only.
 */

const SOURCE_SVG = 'public/favicon.svg';
const OUT_DIR = 'public/icons';

/**
 * 0.78, not the 0.802 the measurement strictly allows. 0.802 puts the glyph
 * exactly on the boundary, and "exactly on the boundary" loses to
 * antialiasing and to any OEM mask a shade tighter than the spec circle. This
 * leaves ~11% padding a side and a visible margin of error.
 */
const GLYPH_SCALE = 0.78;

/** 192 and 512 are the two sizes Chrome's installability check reads and Android actually uses. */
const SIZES = [192, 512];

const CHROME_CANDIDATES = [
  process.env['CHROME_PATH'],
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      'No Chromium binary found. Set CHROME_PATH, or install one. Tried:\n  ' +
        CHROME_CANDIDATES.join('\n  '),
    );
  }
  return found;
}

/**
 * Builds the maskable artwork *from* the favicon rather than duplicating its
 * path data, so the two marks cannot drift into being different shapes.
 *
 * Every extraction below is asserted. A regex that silently matches nothing
 * would produce a blank-but-plausible icon, and the verifier — which only
 * checks that the glyph is inside the safe circle — would happily pass it,
 * because no glyph at all is trivially inside.
 */
function buildMaskableSvg() {
  const svg = readFileSync(SOURCE_SVG, 'utf8');

  const rect = /<rect\b[^>]*\/>/s.exec(svg);
  if (!rect) throw new Error(`${SOURCE_SVG}: no <rect> — the ground shape is missing`);
  if (!/\brx\s*=\s*"32"/.test(rect[0])) {
    throw new Error(`${SOURCE_SVG}: expected the ground rect to have rx="32"; the source changed`);
  }

  const fill = /\bfill\s*=\s*"([^"]+)"/.exec(rect[0]);
  if (!fill) throw new Error(`${SOURCE_SVG}: the ground rect has no fill`);

  const path = /<path\b[^>]*\/>/s.exec(svg);
  if (!path) throw new Error(`${SOURCE_SVG}: no <path> — the glyph is missing`);

  const d = /\bd\s*=\s*"([^"]+)"/.exec(path[0]);
  if (!d || d[1].length < 100) {
    throw new Error(`${SOURCE_SVG}: glyph path data missing or implausibly short`);
  }

  // `fill` as a presentation attribute, never `style="fill:…"`. This file is
  // standalone so CSP does not reach it, but the same mark is inlined by
  // LogoComponent where it does — and a style attribute there is dropped
  // silently while staying in the DOM (CLAUDE.md §4.4). Same form in both
  // places means the trap cannot be reintroduced by copying between them.
  const centre = 72; // half of the 144 viewBox
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144" width="144" height="144">
  <rect x="0" y="0" width="144" height="144" fill="${fill[1]}"/>
  <g transform="translate(${centre},${centre}) scale(${GLYPH_SCALE}) translate(${-centre},${-centre})">
    <path fill="#ffffff" d="${d[1]}"/>
  </g>
</svg>
`;
}

function rasterize(chrome, svgPath, size, outPath) {
  execFileSync(
    chrome,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      `--force-device-scale-factor=${size / 144}`,
      '--window-size=144,144',
      '--default-background-color=00000000',
      `--screenshot=${outPath}`,
      `file://${svgPath}`,
    ],
    { stdio: 'pipe' },
  );
}

function main() {
  const chrome = findChrome();
  console.log(`Chromium: ${chrome}`);

  const svg = buildMaskableSvg();
  const tmp = mkdtempSync(join(tmpdir(), 'trivimind-icons-'));
  const svgPath = join(tmp, 'maskable.svg');
  writeFileSync(svgPath, svg);

  try {
    for (const size of SIZES) {
      const out = `${OUT_DIR}/icon-maskable-${size}x${size}.png`;
      rasterize(chrome, svgPath, size, out);

      const m = measureIcon(out);
      const pct = (m.glyphRadiusFraction * 100).toFixed(1);
      const budget = (MASKABLE_SAFE_RADIUS_FRACTION * 100).toFixed(1);
      console.log(
        `  ${out}  ${m.width}x${m.height}  glyph ${pct}% of width (budget ${budget}%)  ` +
          `opaque corners ${4 - m.transparentCorners}/4`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\nNow run: npm run icons:verify');
}

main();
