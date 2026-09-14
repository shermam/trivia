import { describe, expect, it } from 'vitest';
import {
  MAX_TAGS_PER_QUESTION,
  MAX_TAG_LENGTH,
  isNormalizedTag,
  normalizeTag,
  normalizeTags,
  readTags,
} from './normalize-tag.util';
import { TAG_SUGGESTIONS } from './tag-suggestions';

describe('normalizeTag', () => {
  it("lower-cases and hyphenates the spec's three spellings of one tag", () => {
    // The example the whole design turns on: three ways a contributor might
    // type the same topic have to reach the same stored string, or the filter
    // and the recommender are comparing different things.
    expect(normalizeTag('World War 2')).toBe('world-war-2');
    expect(normalizeTag('world_war_2')).toBe('world-war-2');
    expect(normalizeTag(' WORLD WAR 2 ')).toBe('world-war-2');
  });

  it('leaves an already-normalised tag exactly as it is', () => {
    expect(normalizeTag('world-war-2')).toBe('world-war-2');
  });

  it('collapses runs of whitespace, tabs and underscores into one hyphen', () => {
    expect(normalizeTag('  cold \t\n war __ era ')).toBe('cold-war-era');
  });

  it('collapses repeated hyphens and trims them off both ends', () => {
    expect(normalizeTag('--world---war--')).toBe('world-war');
  });

  it('drops punctuation rather than turning it into a separator', () => {
    // `.`/`'` inside a word are removed, not hyphenated: `st.-louis` would be a
    // different tag from `st-louis` for no reason a reader would predict.
    expect(normalizeTag('St. Louis')).toBe('st-louis');
    expect(normalizeTag('rock & roll')).toBe('rock-roll');
    // ...and a name that is *mostly* punctuation ends up with nothing left to
    // store: `C++` reduces to `c`, one character, which is dropped. The
    // selector says so rather than silently accepting nothing.
    expect(normalizeTag('C++')).toBeNull();
  });

  it('folds diacritics instead of deleting the letter under them', () => {
    // Deleting the character gives `matemtica`, which nobody types twice.
    expect(normalizeTag('matemática')).toBe('matematica');
    expect(normalizeTag('Café Society')).toBe('cafe-society');
    expect(normalizeTag('SÃO PAULO')).toBe('sao-paulo');
  });

  it('drops a script that carries no ascii at all rather than storing an empty tag', () => {
    expect(normalizeTag('日本語')).toBeNull();
    expect(normalizeTag('🎉🎉')).toBeNull();
  });

  it('returns null for anything that normalises to fewer than two characters', () => {
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('!!!')).toBeNull();
    expect(normalizeTag('---')).toBeNull();
    expect(normalizeTag('a')).toBeNull();
    expect(normalizeTag(' 7 ')).toBeNull();
  });

  it('accepts exactly two characters', () => {
    expect(normalizeTag('AI')).toBe('ai');
    expect(normalizeTag('C#')).toBeNull(); // `c` alone is one character
  });

  it('accepts a tag at the length cap and refuses the one past it', () => {
    expect(normalizeTag('a'.repeat(MAX_TAG_LENGTH))).toBe('a'.repeat(MAX_TAG_LENGTH));
    expect(normalizeTag('a'.repeat(MAX_TAG_LENGTH + 1))).toBeNull();
  });

  it('refuses rather than truncates, so a long tag never becomes a different one', () => {
    // Truncation would silently store `the-treaty-of-westphalia-and-it` — a tag
    // that looks deliberate and matches nothing anyone will type again.
    expect(normalizeTag('The Treaty of Westphalia and its consequences')).toBeNull();
  });

  it('never produces a value that isNormalizedTag would reject', () => {
    const inputs = [
      'World War 2',
      '  spaced  out  ',
      'Ünïcödé Tëst',
      'trailing---',
      '12345',
      'a'.repeat(MAX_TAG_LENGTH),
    ];
    for (const input of inputs) {
      const tag = normalizeTag(input);
      expect(tag === null || isNormalizedTag(tag)).toBe(true);
    }
  });
});

describe('isNormalizedTag', () => {
  it('accepts the shape firestore.rules accepts', () => {
    expect(isNormalizedTag('ai')).toBe(true);
    expect(isNormalizedTag('world-war-2')).toBe(true);
    expect(isNormalizedTag('a'.repeat(MAX_TAG_LENGTH))).toBe(true);
  });

  it('refuses every shape firestore.rules refuses', () => {
    expect(isNormalizedTag('a')).toBe(false);
    expect(isNormalizedTag('a'.repeat(MAX_TAG_LENGTH + 1))).toBe(false);
    expect(isNormalizedTag('World-War-2')).toBe(false);
    expect(isNormalizedTag('world war 2')).toBe(false);
    expect(isNormalizedTag('world--war')).toBe(false);
    expect(isNormalizedTag('-world')).toBe(false);
    expect(isNormalizedTag('world-')).toBe(false);
    expect(isNormalizedTag('world_war')).toBe(false);
    expect(isNormalizedTag(42)).toBe(false);
    expect(isNormalizedTag(null)).toBe(false);
    expect(isNormalizedTag(['ai'])).toBe(false);
  });
});

describe('normalizeTags', () => {
  it("normalises each entry and keeps the writer's order", () => {
    expect(normalizeTags(['World War 2', 'Cold War'])).toEqual(['world-war-2', 'cold-war']);
  });

  it('collapses two entries that normalise to the same tag', () => {
    // The rules refuse a duplicate outright, so collapsing here is what keeps a
    // contributor from meeting a permission-denied they cannot act on.
    expect(normalizeTags(['World War 2', 'world_war_2', 'WORLD-WAR-2'])).toEqual(['world-war-2']);
  });

  it('drops entries with no tag in them', () => {
    expect(normalizeTags(['ai', '   ', '!!', 'ml'])).toEqual(['ai', 'ml']);
  });

  it('cuts the list at the per-question maximum', () => {
    const many = Array.from({ length: MAX_TAGS_PER_QUESTION + 4 }, (_, i) => `tag-${i}`);
    expect(normalizeTags(many)).toHaveLength(MAX_TAGS_PER_QUESTION);
    expect(normalizeTags(many)[0]).toBe('tag-0');
  });

  it('returns an empty list for no input, which is a valid question', () => {
    expect(normalizeTags([])).toEqual([]);
  });
});

describe('readTags', () => {
  it('returns the tags of a well-formed document', () => {
    expect(readTags(['world-war-2', 'cold-war'])).toEqual(['world-war-2', 'cold-war']);
  });

  it('returns undefined when there is nothing to render', () => {
    expect(readTags(undefined)).toBeUndefined();
    expect(readTags([])).toBeUndefined();
    expect(readTags('world-war-2')).toBeUndefined();
    expect(readTags({ 0: 'ai' })).toBeUndefined();
  });

  /**
   * Every one of these is refused by `firestore.rules` on any write the app can
   * make — and every one of them is writable straight into the collection from
   * the Firebase console, which the rules do not govern (`CLAUDE.md` §4.4: the
   * reader has to be right regardless of the writer).
   */
  it('drops what a console-written document could contain', () => {
    expect(readTags(['ai', 42, null, { x: 1 }, 'Shouty', 'has space', 'a'])).toEqual(['ai']);
    expect(readTags(['ai', 'ai', 'ml'])).toEqual(['ai', 'ml']);
    expect(readTags(['x'.repeat(MAX_TAG_LENGTH + 1), 'ok'])).toEqual(['ok']);
  });

  it('caps what it renders at the per-question maximum', () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag-${i}`);
    expect(readTags(many)).toHaveLength(MAX_TAGS_PER_QUESTION);
  });
});

describe('TAG_SUGGESTIONS', () => {
  /**
   * A suggestion that is not already normalised would put a chip on screen that
   * differs from the label the contributor clicked — and one over the length
   * cap would be a suggestion the rules refuse. Both are hand-edit accidents
   * that nothing else in the suite would notice.
   */
  it('is entirely made of tags the normaliser and the rules both accept', () => {
    for (const suggestion of TAG_SUGGESTIONS) {
      expect(normalizeTag(suggestion)).toBe(suggestion);
    }
  });

  it('holds no duplicates', () => {
    expect(new Set(TAG_SUGGESTIONS).size).toBe(TAG_SUGGESTIONS.length);
  });

  it('offers enough to cover the categories the setup screen lists', () => {
    expect(TAG_SUGGESTIONS.length).toBeGreaterThanOrEqual(40);
  });
});
