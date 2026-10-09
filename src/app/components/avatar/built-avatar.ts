/**
 * The built avatar (`FEAT-038`): a seed turned into one shape on one colour,
 * drawn as inline SVG.
 *
 * **Generated, never fetched.** No sprite files, no `public/` assets, no
 * dependency and no request: the whole catalog is the two short tables below,
 * which is what keeps the account chip — part of the initial bundle — from
 * paying for it. Colours come from `BRAND_DESIGN_SYSTEM.md` and reach the DOM
 * as presentation attributes (`fill="…"`), never a `style` attribute, which
 * the CSP would drop while leaving it in the markup (`CLAUDE.md` §4.4).
 *
 * **A seed names a variant**: `<set>-<shape digit><colour digit>`, so
 * `core-35` is the `core` set's square on night blue. Sets are what `FEAT-041`
 * will lock and unlock by name, with no change to the stored field; which sets
 * a player may use is a later rule, not this table's business. **A shipped set
 * is frozen** — a stored seed is a reference into it, so a new shape or colour
 * is a new set rather than an edit to an old one, or every avatar built from
 * the old one silently changes.
 */

export interface BuiltShape {
  /** Stable identity for the picker's `@for` track and its label. */
  readonly id: string;
  /** Path data in a 32×32 box, kept inside the circle it is drawn on. */
  readonly d: string;
  /** A shape with a hole in it, drawn with `fill-rule="evenodd"`. */
  readonly evenOdd?: boolean;
}

export interface BuiltPalette {
  readonly id: string;
  readonly background: string;
  readonly foreground: string;
}

export interface BuiltAvatarSet {
  readonly shapes: readonly BuiltShape[];
  readonly palettes: readonly BuiltPalette[];
}

/** The sets this build can draw, by the name a seed uses. */
export const BUILT_AVATAR_SETS: Readonly<Record<string, BuiltAvatarSet>> = {
  core: {
    shapes: [
      { id: 'dot', d: 'M9 16a7 7 0 1 0 14 0a7 7 0 1 0-14 0z' },
      {
        id: 'ring',
        d: 'M8 16a8 8 0 1 0 16 0a8 8 0 1 0-16 0zm3.5 0a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0z',
        evenOdd: true,
      },
      { id: 'diamond', d: 'M16 7l9 9-9 9-9-9z' },
      { id: 'square', d: 'M10 10h12v12H10z' },
      { id: 'triangle', d: 'M16 7l8 14H8z' },
      { id: 'plus', d: 'M13.5 8h5v5.5H24v5h-5.5V24h-5v-5.5H8v-5h5.5z' },
    ],
    palettes: [
      { id: 'emerald', background: '#047857', foreground: '#d1fae5' },
      { id: 'forest', background: '#064e3b', foreground: '#fde68a' },
      { id: 'gold', background: '#d97706', foreground: '#fef3c7' },
      { id: 'night', background: '#0f172a', foreground: '#a7f3d0' },
      { id: 'cocoa', background: '#78350f', foreground: '#fef3c7' },
      { id: 'mint', background: '#d1fae5', foreground: '#065f46' },
    ],
  },
};

/** The set the picker builds from today — the only one there is. */
export const DEFAULT_BUILT_SET = 'core';

/** What the picker starts a player on the first time they build one. */
export const DEFAULT_BUILT_SEED = 'core-00';

/** One variant, decoded. */
export interface BuiltAvatar {
  readonly set: string;
  readonly shapeIndex: number;
  readonly paletteIndex: number;
  readonly shape: BuiltShape;
  readonly palette: BuiltPalette;
}

/**
 * The variant a seed names, or `null` for one this build cannot draw — an
 * unknown set, a digit past the end of its table, or anything malformed. The
 * caller shows initials then: a seed written by a newer app on another device
 * is not an error on this one.
 */
export function builtAvatar(seed: string | null | undefined): BuiltAvatar | null {
  const match = /^([a-z]{1,8})-([0-9])([0-9])$/.exec(seed ?? '');
  if (!match || !Object.hasOwn(BUILT_AVATAR_SETS, match[1])) {
    return null;
  }
  const set = BUILT_AVATAR_SETS[match[1]];
  const shapeIndex = Number(match[2]);
  const paletteIndex = Number(match[3]);
  const shape = set.shapes[shapeIndex];
  const palette = set.palettes[paletteIndex];
  return shape && palette ? { set: match[1], shapeIndex, paletteIndex, shape, palette } : null;
}

/** The seed naming one shape and one colour of a set — the inverse of {@link builtAvatar}. */
export function builtSeed(set: string, shapeIndex: number, paletteIndex: number): string {
  return `${set}-${shapeIndex}${paletteIndex}`;
}
