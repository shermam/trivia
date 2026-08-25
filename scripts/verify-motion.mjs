import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * Fails when a template animates something without gating it on the reader's
 * motion preference.
 *
 * **The convention, in one line: motion is opt-out by default.** Anything that
 * moves, scales or loops is gated on the reader not having asked for less of
 * it — Tailwind's `motion-safe:` variant in a template, or a
 * `matchMedia('(prefers-reduced-motion: reduce)')` check for motion driven
 * from TypeScript. This file is where that rule lives, because it is also what
 * enforces it; a convention documented somewhere other than its check is a
 * convention with two places to drift.
 *
 * **Why a script and not a paragraph.** The rule is the kind that decays: it is invisible to anyone who does not have "reduce
 * motion" switched on, so a missing `motion-safe:` looks perfect to whoever
 * added it, to the reviewer, to Lighthouse and to the e2e suite. That is not
 * hypothetical here — the very first animation in this app shipped ungated
 * (`animate-pulse` on the account chip's loading skeleton), and nothing
 * noticed. Same reasoning as `verify-csp.mjs`: a guardrail nothing enforces is
 * a comment.
 *
 * **Scope is movement, deliberately narrow.** `animate-*` utilities are the
 * target because they loop, which is the case `prefers-reduced-motion` exists
 * for and the case WCAG 2.2.2 speaks to. Colour and shadow transitions
 * (`transition-colors`, and the `transition-all` on several buttons, which
 * animate `background-color` and `box-shadow` on hover) are not motion, and
 * sweeping them in would bury the real rule under noise nobody reads.
 *
 * The one class of transition that *is* swept in is a `transition-[…]` naming
 * a property that changes layout — `width`, `height`, `grid-template-columns`
 * and friends. Those move everything around them, which is the thing the
 * preference is about, and reaching for an arbitrary property is already a
 * deliberate act rather than a default. The distinction is load-bearing rather
 * than tidy: the quiz timer's `transition-[stroke-dashoffset]` sweeps a ring
 * continuously for fifteen seconds and is correctly *not* an offence, because
 * it repaints inside a fixed box and nothing on the page shifts.
 *
 * A wider rule would need to understand *what* a transition animates in the
 * general case, which means resolving Tailwind's utilities to declarations —
 * far more machinery than the risk warrants. If a transform-based movement is
 * ever added in a template, add it to MOVEMENT_PATTERNS below.
 */

/** Utilities that produce looping or translating motion. */
const MOVEMENT_PATTERNS = [
  // Tailwind's animation utilities: animate-spin, animate-pulse, animate-bounce,
  // animate-ping, and any custom `animate-<name>` from a @theme block.
  // `animate-none` is the opt-out and is not motion.
  /(?<!:)\banimate-(?!none\b)[a-z][a-z0-9-]*/g,
  // Arbitrary-property transitions of anything that changes layout, e.g.
  // `transition-[max-width]` on the account chip's label region.
  // Deliberately not every `transition-[…]`: see the note above about the quiz
  // timer's `stroke-dashoffset`, which animates without reflowing anything.
  /(?<!:)\btransition-\[[^\]]*\b(?:grid-template|width|height|margin|padding|inset|top|right|bottom|left|translate|transform|flex-basis|gap)[^\]]*\]/g,
];

/** The variant that gates a utility on `prefers-reduced-motion: no-preference`. */
const SAFE_VARIANT = 'motion-safe:';

function templates() {
  return globSync('src/app/**/*.html', { cwd: process.cwd() }).sort();
}

const offences = [];

for (const file of templates()) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    for (const pattern of MOVEMENT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        // The negative lookbehind above rejects `motion-safe:animate-…` and any
        // other variant chain ending in a colon, but a variant chain can also
        // put motion-safe earlier (`sm:motion-safe:animate-pulse`). Check the
        // whole token rather than just the character before it.
        const start = line.lastIndexOf(' ', match.index) + 1;
        const token = line.slice(start).split(/[\s"']/)[0];
        if (token.includes(SAFE_VARIANT)) {
          continue;
        }
        offences.push({ file, line: index + 1, token });
      }
    }
  });
}

if (offences.length > 0) {
  console.error("\n  Ungated motion — every animation must be gated on the reader's preference.\n");
  for (const { file, line, token } of offences) {
    console.error(`    ${file}:${line}  ${token}`);
  }
  console.error(
    `\n  Prefix each with \`${SAFE_VARIANT}\` (or check` +
      " `matchMedia('(prefers-reduced-motion: reduce)')` if the movement is" +
      ' driven from TypeScript).\n  The rule and its scope are documented at the' +
      ' top of this file.\n',
  );
  process.exit(1);
}

console.log(
  `✓ Motion: every animation across ${templates().length} template(s) is gated on ${SAFE_VARIANT}`,
);
