import { formatMessage, parseMessage } from './format';

/**
 * The message syntax (`format.ts`): text, `{name}`, and one plural. What is
 * pinned here is the grammar a translator is promised in `docs/app.md` §1.16,
 * and the two promises the English call sites rely on — that a placeholder
 * reads exactly as `String(value)` did before the string was extracted, and
 * that nothing a message says can throw.
 */
describe('formatMessage', () => {
  describe('text and placeholders', () => {
    it('returns text with no placeholder as it is, # and apostrophes included', () => {
      expect(formatMessage("It's #1 — or isn't it?", undefined, 'en')).toBe(
        "It's #1 — or isn't it?",
      );
    });

    it('fills a placeholder with the value as text, unformatted', () => {
      expect(formatMessage('{n} of {total}', { n: 1234, total: 'many' }, 'en')).toBe(
        '1234 of many',
      );
      expect(formatMessage('{n} points', { n: 1234 }, 'pt-BR')).toBe('1234 points');
    });

    it('shows a placeholder nobody filled as itself, rather than breaking the line', () => {
      expect(formatMessage('Hello, {name}.', {}, 'en')).toBe('Hello, {name}.');
      expect(formatMessage('Hello, {name}.', { name: null }, 'en')).toBe('Hello, {name}.');
      expect(formatMessage('Hello, {name}.', undefined, 'en')).toBe('Hello, {name}.');
    });

    it('fills the same placeholder everywhere it appears', () => {
      expect(formatMessage('{a}, {b}, {a}', { a: 'x', b: 'y' }, 'en')).toBe('x, y, x');
    });

    it('treats markup in a value as text', () => {
      expect(formatMessage('Hi {name}', { name: '<b>{n}</b>' }, 'en')).toBe('Hi <b>{n}</b>');
    });
  });

  describe('plurals', () => {
    const items = '{n, plural, one {# item} other {# items}}';

    it('picks English branches for 0, 1 and 2', () => {
      expect([0, 1, 2].map((n) => formatMessage(items, { n }, 'en'))).toEqual([
        '0 items',
        '1 item',
        '2 items',
      ]);
    });

    /** pt-BR's `one` includes 0 — why a message that has to say "none" says it with `=0`. */
    it('picks Brazilian Portuguese branches for 0, 1 and 2, where 0 is "one"', () => {
      expect([0, 1, 2].map((n) => formatMessage(items, { n }, 'pt-BR'))).toEqual([
        '0 item',
        '1 item',
        '2 items',
      ]);
    });

    it('picks Spanish branches for 0, 1 and 2', () => {
      expect([0, 1, 2].map((n) => formatMessage(items, { n }, 'es'))).toEqual([
        '0 items',
        '1 item',
        '2 items',
      ]);
    });

    it('takes an exact =N branch before the locale’s category', () => {
      const none = '{n, plural, =0 {none} one {# item} other {# items}}';
      expect(formatMessage(none, { n: 0 }, 'pt-BR')).toBe('none');
      expect(formatMessage(none, { n: 0 }, 'en')).toBe('none');
      expect(formatMessage(none, { n: 1 }, 'pt-BR')).toBe('1 item');
    });

    it('falls back to other for a category the message does not have', () => {
      // es puts a million in `many`; a message without `many` still reads.
      expect(formatMessage(items, { n: 1_000_000 }, 'es')).toBe('1.000.000 items');
    });

    it('formats # for the locale, grouping included', () => {
      expect(formatMessage(items, { n: 1234 }, 'en')).toBe('1,234 items');
      expect(formatMessage(items, { n: 1234 }, 'pt-BR')).toBe('1.234 items');
      expect(formatMessage(items, { n: 12345 }, 'es')).toBe('12.345 items');
    });

    it('fills placeholders inside a branch, and keeps the text around the plural', () => {
      expect(
        formatMessage(
          'Page {page}: {n, plural, one {# of {total}} other {# of {total}}} shown.',
          { n: 2, total: 9, page: 3 },
          'en',
        ),
      ).toBe('Page 3: 2 of 9 shown.');
    });

    it('accepts whitespace between the branches and before the closing brace', () => {
      expect(formatMessage('{n, plural, one {# day} other {# days} }', { n: 3 }, 'en')).toBe(
        '3 days',
      );
    });

    it('shows the plural’s placeholder when the count is missing or not a number', () => {
      expect(formatMessage(items, {}, 'en')).toBe('{n}');
      expect(formatMessage(items, { n: '3' }, 'en')).toBe('{n}');
    });
  });

  describe('a message that does not parse', () => {
    const broken = [
      '{unclosed',
      'stray } brace',
      '{n, plural, one {# item}}', // no `other`
      '{n, select, a {x} other {y}}', // no select
      '{n, plural, one {{m, plural, other {#}}} other {x}}', // no nesting
      '{n, plural, few {x} few {y} other {z}}', // a selector twice
      '{n, plural, some {x} other {y}}', // not a category
      '{not a name}',
    ];

    it.each(broken)('renders %j as its raw text rather than throwing', (source) => {
      expect(parseMessage(source)).toBeNull();
      expect(formatMessage(source, { n: 1 }, 'en')).toBe(source);
    });

    it('parses every valid shape', () => {
      for (const source of [
        'plain',
        '{a}',
        '{n, plural, other {#}}',
        '{n, plural, =0 {none} =1 {one} zero {z} one {o} two {t} few {f} many {m} other {#}}',
      ]) {
        expect(parseMessage(source), source).not.toBeNull();
      }
    });
  });
});
