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
  const core = BUILT_AVATAR_SETS[DEFAULT_BUILT_SET];

  it('draws every variant of the core set, and names each by its own seed', () => {
    core.shapes.forEach((shape, shapeIndex) => {
      core.palettes.forEach((palette, paletteIndex) => {
        const seed = builtSeed(DEFAULT_BUILT_SET, shapeIndex, paletteIndex);
        // Every seed the picker can produce is one the server will store.
        expect(AVATAR_SEED_PATTERN.test(seed)).toBe(true);
        expect(builtAvatar(seed)).toEqual({
          set: DEFAULT_BUILT_SET,
          shapeIndex,
          paletteIndex,
          shape,
          palette,
        });
      });
    });
  });

  it('starts a new builder on a variant it can draw', () => {
    expect(builtAvatar(DEFAULT_BUILT_SEED)).not.toBeNull();
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
