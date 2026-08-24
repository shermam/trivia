/**
 * The one place that answers "may this move?".
 *
 * **The convention, in one line: motion is opt-out by default.** Anything that
 * moves, scales, or loops is gated on the reader not having asked for less of
 * it — with Tailwind's `motion-safe:` variant in a template, or with
 * {@link prefersReducedMotion} for motion driven from TypeScript.
 *
 * Scope is deliberately drawn at *movement*, not at "anything with a
 * transition". A `transition-colors` on a hover state is a colour change, not
 * motion, and gating it would be noise that makes the real rule easier to
 * ignore. What is in scope: `animate-*` utilities (they loop), transforms that
 * translate or scale, and any width/height/position change driven from code.
 *
 * Enforced by `scripts/verify-motion.mjs` (`npm run motion:verify`), which
 * fails the build on an ungated `animate-*` in a template — because this is
 * exactly the kind of rule that decays into a habit nobody remembers. The
 * first motion in this app shipped without it (`animate-pulse` on the account
 * chip's skeleton), which is why the check exists rather than a paragraph.
 */

/** Media query the platform exposes for the OS-level "reduce motion" setting. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the reader has asked for reduced motion, right now.
 *
 * Read at the moment of animating rather than cached, so toggling the OS
 * setting takes effect without a reload — and because a cached value would
 * need a listener, and a listener would need a teardown, for a boolean that is
 * free to read.
 *
 * Defensive about `matchMedia` because jsdom does not implement it: the unit
 * environment shims it (`src/test-setup.ts`), but a component should not fall
 * over if some other non-browser context loads this. Absent support means
 * "no preference expressed", which is the same answer a browser gives when the
 * user has not set one.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}
