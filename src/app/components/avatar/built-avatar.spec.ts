import { AVATAR_SEED_PATTERN } from '../../models/avatar.model';
import {
  BUILT_AVATAR_SETS,
  DEFAULT_BUILT_SEED,
  DEFAULT_BUILT_SET,
  builtAvatar,
  builtSeed,
} from './built-avatar';

/**
 * The built avatar's catalog (`FEAT-038`). A seed is a reference into it, so
 * what is pinned is that every variant the picker can produce is one this
 * build can draw, that the two directions agree, and that nothing in the
 * tables could reach the DOM as anything but a presentation attribute.
 */
describe('builtAvatar', () => {
  it('draws every variant of every set, and names each by its own seed', () => {
    for (const [name, set] of Object.entries(BUILT_AVATAR_SETS)) {
      set.shapes.forEach((shape, shapeIndex) => {
        set.palettes.forEach((palette, paletteIndex) => {
          const seed = builtSeed(name, shapeIndex, paletteIndex);
          // Every seed the picker can produce is one the server will store.
          expect(AVATAR_SEED_PATTERN.test(seed), seed).toBe(true);
          expect(builtAvatar(seed)).toEqual({
            set: name,
            shapeIndex,
            paletteIndex,
            shape,
            palette,
          });
        });
      });
    }
  });

  /**
   * **A shipped set is frozen**: a stored seed is a reference into it, so
   * reordering, renaming or recolouring one entry silently changes every avatar
   * built from it. Pinned by name and colour, so an edit has to be a new set.
   */
  it('keeps every shipped set exactly as it shipped', () => {
    const catalog = Object.fromEntries(
      Object.entries(BUILT_AVATAR_SETS).map(([name, set]) => [
        name,
        {
          shapes: set.shapes.map((shape) => shape.id),
          palettes: set.palettes.map(
            (palette) => `${palette.id} ${palette.background} ${palette.foreground}`,
          ),
        },
      ]),
    );
    expect(catalog).toEqual({
      core: {
        shapes: ['dot', 'ring', 'diamond', 'square', 'triangle', 'plus'],
        palettes: [
          'emerald #047857 #d1fae5',
          'forest #064e3b #fde68a',
          'gold #d97706 #fef3c7',
          'night #0f172a #a7f3d0',
          'cocoa #78350f #fef3c7',
          'mint #d1fae5 #065f46',
        ],
      },
      bold: {
        shapes: ['star', 'bolt', 'heart', 'crown', 'moon', 'shield'],
        palettes: [
          'ruby #b91c1c #fef2f2',
          'amber #b45309 #fffbeb',
          'blush #fecaca #b91c1c',
          'honey #fde68a #78350f',
          'slate #64748b #f7f9f8',
          'jade #059669 #0f172a',
        ],
      },
    });
  });

  /**
   * The picker names each option by its id — the radio's label and its
   * `data-cy` — with every set on the page at once, so an id two sets shared
   * would be two controls nobody could tell apart.
   */
  it('gives no two shapes or colours the same name, across every set', () => {
    const sets = Object.values(BUILT_AVATAR_SETS);
    const shapes = sets.flatMap((set) => set.shapes.map((shape) => shape.id));
    const palettes = sets.flatMap((set) => set.palettes.map((palette) => palette.id));
    expect(new Set(shapes).size).toBe(shapes.length);
    expect(new Set(palettes).size).toBe(palettes.length);
  });

  it('starts a new builder on a variant it can draw, from the default set', () => {
    expect(builtAvatar(DEFAULT_BUILT_SEED)?.set).toBe(DEFAULT_BUILT_SET);
  });

  /**
   * A seed written by a newer app — a set `FEAT-041` has since added, or a
   * shape past the end of this build's table — is not an error here. It is
   * `null`, and the caller draws initials.
   */
  it('returns null for a seed this build cannot draw', () => {
    for (const seed of [
      'gems-00',
      'core-90',
      'bold-66',
      'core-09',
      'core-0',
      'core-000',
      'constructor-00',
      'tostring-00',
      '',
      null,
      undefined,
    ]) {
      expect(builtAvatar(seed)).toBeNull();
    }
  });

  it('keeps the tables to colours and path data, and nothing that could carry a style', () => {
    for (const set of Object.values(BUILT_AVATAR_SETS)) {
      for (const shape of set.shapes) {
        expect(shape.d).toMatch(/^[MmLlHhVvAaZz0-9.\s-]+$/);
      }
      for (const palette of set.palettes) {
        expect(palette.background).toMatch(/^#[0-9a-f]{6}$/);
        expect(palette.foreground).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  /**
   * Ten of each at most: a seed has one digit for the shape and one for the
   * colour, so an eleventh could never be named — and the picker would offer
   * a choice that saves as somebody else's.
   */
  it('fits every set in the two digits a seed has', () => {
    for (const set of Object.values(BUILT_AVATAR_SETS)) {
      expect(set.shapes.length).toBeLessThanOrEqual(10);
      expect(set.palettes.length).toBeLessThanOrEqual(10);
      expect(new Set(set.shapes.map((shape) => shape.id)).size).toBe(set.shapes.length);
      expect(new Set(set.palettes.map((palette) => palette.id)).size).toBe(set.palettes.length);
    }
  });
});
