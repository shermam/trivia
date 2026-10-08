import { describe, expect, it } from 'vitest';
import {
  OPEN_TRIVIA_CATEGORIES,
  SEED_TAGS,
  categoryTag,
  firstSeedTag,
  firstTopicTag,
  isSeedTag,
  openTriviaCategoryId,
  seedTagForCategoryName,
  seedTagRule,
  topicTagsOf,
} from './category-tags';
import { isNormalizedTag } from './normalize-tag.util';

describe('the seed-tag table', () => {
  /**
   * The whole of Open Trivia DB's category list, ids 9 to 32 with no gap and no
   * repeat. The list is first-party now — nothing fetches `api_category.php` —
   * so a row lost in an edit is a topic the app silently stops offering.
   */
  it('holds Open Trivia DB’s twenty-four categories, ids 9 to 32', () => {
    expect(OPEN_TRIVIA_CATEGORIES.map((row) => row.id)).toEqual(
      Array.from({ length: 24 }, (_, index) => 9 + index),
    );
    expect(new Set(OPEN_TRIVIA_CATEGORIES.map((row) => row.name)).size).toBe(24);
    expect(new Set(SEED_TAGS).size).toBe(24);
  });

  /**
   * Every row against the rule, one assertion per row so a failure names the
   * category. The tag column is not free text: it is the rule applied to the
   * name, and a tag that drifted from it would be a seed tag the derivation
   * never produces — so a legacy question in that category would derive one
   * tag while the setup screen offered another.
   */
  for (const row of OPEN_TRIVIA_CATEGORIES) {
    it(`derives #${row.tag} from "${row.name}" by the rule, as a stored tag`, () => {
      expect(seedTagRule(row.name)).toBe(row.tag);
      expect(isNormalizedTag(row.tag)).toBe(true);
    });
  }

  /**
   * The spec's table, verbatim, so an edit to either side has to be made to
   * both. The three the e2e fixture used to stub — 9, 21 and 23 — are among
   * them and agree.
   *
   * **The names are pinned as well as the tags**, because the rule above cannot
   * see a name drift in case or spacing — `Entertainment: Video games` still
   * derives `video-games` — while the adapter matches a fetched question's
   * decoded category against the name exactly. A name that drifted would pass
   * every rule check and leave every question in that category served with no
   * topic at all.
   */
  it('matches the FEAT-052 table row for row', () => {
    expect(OPEN_TRIVIA_CATEGORIES.map((row) => [row.id, row.name, row.tag])).toEqual([
      [9, 'General Knowledge', 'general-knowledge'],
      [10, 'Entertainment: Books', 'books'],
      [11, 'Entertainment: Film', 'film'],
      [12, 'Entertainment: Music', 'music'],
      [13, 'Entertainment: Musicals & Theatres', 'musicals-theatres'],
      [14, 'Entertainment: Television', 'television'],
      [15, 'Entertainment: Video Games', 'video-games'],
      [16, 'Entertainment: Board Games', 'board-games'],
      [17, 'Science & Nature', 'science-nature'],
      [18, 'Science: Computers', 'computers'],
      [19, 'Science: Mathematics', 'mathematics'],
      [20, 'Mythology', 'mythology'],
      [21, 'Sports', 'sports'],
      [22, 'Geography', 'geography'],
      [23, 'History', 'history'],
      [24, 'Politics', 'politics'],
      [25, 'Art', 'art'],
      [26, 'Celebrities', 'celebrities'],
      [27, 'Animals', 'animals'],
      [28, 'Vehicles', 'vehicles'],
      [29, 'Entertainment: Comics', 'comics'],
      [30, 'Science: Gadgets', 'gadgets'],
      [31, 'Entertainment: Japanese Anime & Manga', 'japanese-anime-manga'],
      [32, 'Entertainment: Cartoon & Animations', 'cartoon-animations'],
    ]);
  });
});

describe('seedTagForCategoryName — the adapter’s lookup', () => {
  it('maps a decoded Open Trivia name to its seed tag', () => {
    expect(seedTagForCategoryName('Entertainment: Video Games')).toBe('video-games');
    expect(seedTagForCategoryName('Science & Nature')).toBe('science-nature');
  });

  /**
   * A category Open Trivia DB adds tomorrow is not a seed tag: the setup screen
   * does not offer it and the request cannot turn it back into an id. So the
   * adapter stamps nothing, and the question is still served.
   */
  it('yields nothing for a name the table does not hold', () => {
    expect(seedTagForCategoryName('Entertainment: Podcasts')).toBeNull();
  });

  /** The API entity-encodes `&`; the table holds the decoded name, which is what the adapter compares. */
  it('does not match the still-encoded spelling', () => {
    expect(seedTagForCategoryName('Science &amp; Nature')).toBeNull();
  });
});

describe('categoryTag — what a stored category derives', () => {
  it('is the table’s tag for one of Open Trivia DB’s names', () => {
    expect(categoryTag('Entertainment: Japanese Anime & Manga')).toBe('japanese-anime-manga');
  });

  /**
   * The contribute form took free text, so a stored category can be anything.
   * `Science` is the one its own tests submitted, and it becomes exactly the tag
   * a contributor typing the word into the picker would get.
   */
  it('applies the table’s rule to any other string', () => {
    expect(categoryTag('Science')).toBe('science');
    expect(categoryTag('World War 2')).toBe('world-war-2');
    expect(categoryTag('Matemática Básica')).toBe('matematica-basica');
  });

  it('drops the family prefix however it was typed', () => {
    expect(categoryTag('science: physics')).toBe('physics');
    expect(categoryTag('ENTERTAINMENT :Podcasts')).toBe('podcasts');
  });

  it('derives nothing from a string that normalises to nothing', () => {
    expect(categoryTag('!!')).toBeNull();
    expect(categoryTag('')).toBeNull();
    expect(categoryTag('Science:')).toBeNull();
    expect(categoryTag('x'.repeat(40))).toBeNull();
  });

  it('derives nothing from a value that is not a string', () => {
    expect(categoryTag(undefined)).toBeNull();
    expect(categoryTag(7)).toBeNull();
    expect(categoryTag(['History'])).toBeNull();
  });
});

describe('the reverse lookup', () => {
  it('turns a seed tag back into Open Trivia DB’s id', () => {
    expect(openTriviaCategoryId('history')).toBe(23);
    expect(openTriviaCategoryId('general-knowledge')).toBe(9);
    expect(openTriviaCategoryId('cartoon-animations')).toBe(32);
  });

  it('has no id for any other tag', () => {
    expect(openTriviaCategoryId('world-war-2')).toBeUndefined();
    expect(isSeedTag('world-war-2')).toBe(false);
    expect(isSeedTag('history')).toBe(true);
  });

  /** What an Open Trivia draw follows: the first tag it can honour, in the reader’s order. */
  it('finds the first seed tag in a selection', () => {
    expect(firstSeedTag(['world-war-2', 'sports', 'history'])).toBe('sports');
    expect(firstSeedTag(['world-war-2', 'cold-war'])).toBeNull();
    expect(firstSeedTag([])).toBeNull();
  });
});

describe('topicTagsOf — the one derivation every reader uses', () => {
  it('reads a question’s own tags', () => {
    expect(topicTagsOf({ tags: ['world-war-2', 'history'], category: 'Science' })).toEqual([
      'world-war-2',
      'history',
    ]);
  });

  /** Tags win: whoever tagged it chose them, and the category is the older, coarser statement. */
  it('prefers the tags over the category when a question has both', () => {
    expect(firstTopicTag({ tags: ['cold-war'], category: 'History' })).toBe('cold-war');
  });

  it('falls back to the tag the category derives when there are no tags', () => {
    expect(topicTagsOf({ category: 'History' })).toEqual(['history']);
    expect(topicTagsOf({ tags: [], category: 'Science' })).toEqual(['science']);
  });

  /**
   * A console can write anything into `custom_questions`, so a stored list is
   * re-checked rather than trusted — and one with nothing usable in it is read
   * as no tags at all, which is what lets the category speak instead.
   */
  it('ignores a stored tag list with nothing usable in it', () => {
    expect(topicTagsOf({ tags: ['Not A Tag', 42], category: 'Sports' })).toEqual(['sports']);
    expect(topicTagsOf({ tags: 'history', category: 'Art' })).toEqual(['art']);
  });

  it('is empty for a question with neither', () => {
    expect(topicTagsOf({})).toEqual([]);
    expect(topicTagsOf({ category: '!!' })).toEqual([]);
    expect(firstTopicTag({})).toBeNull();
  });
});
