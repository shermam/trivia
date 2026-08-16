import { readFileSync } from 'node:fs';
import { MASKABLE_SAFE_RADIUS_FRACTION, measureIcon } from './icon-geometry.mjs';

/**
 * Checks that every icon the manifest declares actually matches the `purpose`
 * it is declared under.
 *
 * `npm run icons:verify`, and a step in `lint.yml`.
 *
 * **This exists because nothing else can check it.** Lighthouse removed its
 * PWA category in v12, so there is no `maskable-icon` audit any more; the
 * manifest is just JSON, and a wrong `purpose` renders perfectly everywhere
 * except on an actual Android home screen. Declaring `maskable` is a claim
 * about geometry, and a claim about geometry can be measured.
 *
 * It is pure Node on purpose — no browser, no image library — so it costs a
 * second in CI. Generating the icons needs Chromium; *checking* them does
 * not, and that asymmetry is what lets the check run where it matters.
 */

const MANIFEST = 'public/manifest.webmanifest';

/**
 * `any` icons are deliberately exempt from the safe-zone rule. They are shown
 * unmasked, so the mark is meant to fill the canvas — holding them to the
 * maskable budget would be demanding padding that makes them look shrunken
 * everywhere they are actually used.
 */
function checkAnyIcon(m) {
  const problems = [];
  if (m.width !== m.height) {
    problems.push(`not square: ${m.width}x${m.height}`);
  }
  return problems;
}

function checkMaskableIcon(m) {
  const problems = [];

  if (m.glyphRadiusFraction > MASKABLE_SAFE_RADIUS_FRACTION) {
    problems.push(
      `glyph reaches ${(m.glyphRadiusFraction * 100).toFixed(1)}% of the canvas width, outside the ` +
        `${(MASKABLE_SAFE_RADIUS_FRACTION * 100).toFixed(1)}% safe circle — an adaptive-icon mask will crop it`,
    );
  }

  if (m.transparentCorners > 0) {
    problems.push(
      `${m.transparentCorners} of 4 corners are not fully opaque — a maskable icon must be ` +
        `full-bleed, or the launcher background shows through as an icon-inside-an-icon`,
    );
  }

  return problems;
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const icons = manifest.icons ?? [];

  if (icons.length === 0) {
    console.error(`${MANIFEST}: declares no icons`);
    process.exit(1);
  }

  // A manifest with no maskable icon at all would pass every per-icon check
  // below by vacuously having nothing to check — the same shape of hole as a
  // rules suite made only of reject cases. Assert the set, not just its
  // members.
  const maskable = icons.filter((i) =>
    String(i.purpose ?? '')
      .split(/\s+/)
      .includes('maskable'),
  );
  if (maskable.length === 0) {
    console.error(`${MANIFEST}: no icon declares purpose "maskable"`);
    process.exit(1);
  }

  let failed = 0;
  for (const entry of icons) {
    const path = `public/${entry.src}`;
    const purposes = String(entry.purpose ?? 'any').split(/\s+/);
    let m;
    try {
      m = measureIcon(path);
    } catch (error) {
      console.error(`✘ ${entry.src}: ${error.message}`);
      failed++;
      continue;
    }

    const problems = [
      ...(purposes.includes('maskable') ? checkMaskableIcon(m) : []),
      ...(purposes.includes('any') ? checkAnyIcon(m) : []),
    ];

    const declared = entry.sizes;
    if (declared !== `${m.width}x${m.height}`) {
      problems.push(`manifest says sizes "${declared}" but the file is ${m.width}x${m.height}`);
    }

    if (problems.length) {
      failed++;
      console.error(`✘ ${entry.src} (purpose: ${purposes.join(' ')})`);
      for (const p of problems) console.error(`    ${p}`);
    } else {
      console.log(
        `✔ ${entry.src.padEnd(34)} ${String(`${m.width}x${m.height}`).padEnd(9)} ` +
          `purpose ${purposes.join(' ').padEnd(9)} glyph ${(m.glyphRadiusFraction * 100).toFixed(1)}%`,
      );
    }
  }

  if (failed) {
    console.error(`\n${failed} icon(s) do not match their declared purpose.`);
    process.exit(1);
  }
  console.log(
    `\nAll ${icons.length} icons match their declared purpose (${maskable.length} maskable).`,
  );
}

main();
