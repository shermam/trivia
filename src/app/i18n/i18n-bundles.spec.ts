/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatMessage, parseMessage } from './format';

/**
 * The message catalogue against the code that uses it — the third part of the
 * guard (`docs/ci-cd.md` §4.5), beside the lint rule and `npm run i18n:verify`.
 *
 * **Deliberately a second reading, not the extractor's.** The extractor walks
 * the TypeScript and template ASTs; this reads the source as text with
 * patterns of its own, so a fault in one is not silently shared by the other.
 * And it holds what the type cannot: `MessageKey` refuses an unknown key at a
 * call the compiler checks, but not one that reaches the service through a
 * cast, and not a key nobody uses any more.
 *
 * From the second locale on, this is also where a translation is held to
 * English's keys.
 */

const APP = join(process.cwd(), 'src/app');
const KEY = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;
const KEY_SOURCE = String.raw`[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+`;

/** `t('key'`, `msg('key'`, `routeTitle('key'` and `.t('key'`, in TypeScript and in templates. */
const CALL = new RegExp(
  String.raw`(?:^|[^\w$])(?:t|msg|routeTitle)\(\s*(['"])(${KEY_SOURCE})\1`,
  'g',
);
/** `'key' | t`, across a line break where Prettier put one. */
const PIPE = new RegExp(String.raw`(['"])(${KEY_SOURCE})\1\s*\|\s*t\b`, 'g');
/** `<name>…</name>`, the rich-text tags (`RichTextComponent`). */
const TAG = /<([a-z][a-zA-Z0-9]*)>([\s\S]*?)<\/\1>/g;

const en: Record<string, string> = JSON.parse(
  readFileSync(join(APP, 'i18n/en.json'), 'utf8'),
) as Record<string, string>;

/** The app's source, comments removed — a doc comment's example is not a call. */
function sources(): { file: string; text: string }[] {
  return (readdirSync(APP, { recursive: true }) as string[])
    .filter((file) => /\.(ts|html)$/.test(file) && !file.endsWith('.spec.ts'))
    .map((file) => ({
      file,
      text: readFileSync(join(APP, file), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1'),
    }));
}

/** Every key the code asks for, with the first file that asks. */
function referencedKeys(): Map<string, string> {
  const found = new Map<string, string>();
  for (const { file, text } of sources()) {
    for (const pattern of [CALL, PIPE]) {
      for (const match of text.matchAll(pattern)) {
        if (!found.has(match[2])) found.set(match[2], file);
      }
    }
  }
  return found;
}

describe('the message catalogue (en.json)', () => {
  const referenced = referencedKeys();

  it('finds the call sites at all', () => {
    // A pattern that matched nothing would pass every test below vacuously.
    expect(referenced.size).toBeGreaterThan(500);
  });

  it('defines every key the code asks for', () => {
    const missing = [...referenced]
      .filter(([key]) => !(key in en))
      .map(([key, file]) => `${key} (${file})`);
    expect(missing, 'referenced but not in en.json — run `npm run i18n:extract`').toEqual([]);
  });

  it('holds no key the code no longer asks for', () => {
    const unused = Object.keys(en).filter((key) => !referenced.has(key));
    expect(unused, 'in en.json but referenced nowhere — run `npm run i18n:extract`').toEqual([]);
  });

  it('names every key <component>.<purpose>', () => {
    expect(Object.keys(en).filter((key) => !KEY.test(key))).toEqual([]);
  });

  it('writes every English default in the message syntax', () => {
    const unparsable = Object.entries(en)
      .filter(([, text]) => parseMessage(text) === null)
      .map(([key]) => key);
    expect(unparsable).toEqual([]);
  });

  /**
   * `RichTextComponent` splits the tags out before it fills anything in, so
   * each piece has to parse on its own: a tag may sit inside a sentence, but
   * never across a plural's braces — and a tag left open or unmatched would be
   * shown to the reader as markup.
   */
  it('keeps every rich-text tag closed, whole, and outside any plural', () => {
    const broken = Object.entries(en)
      .filter(([, text]) => {
        const pieces = text.split(TAG).filter((_, i) => i % 3 !== 1);
        return (
          pieces.some((piece) => parseMessage(piece) === null) ||
          /<\/?[a-z][a-zA-Z0-9]*>/.test(pieces.join(''))
        );
      })
      .map(([key]) => key);
    expect(broken).toEqual([]);
  });

  it('keeps the verbatim message a bare placeholder, in every language', () => {
    expect(en['i18n.verbatim']).toBe('{text}');
    expect(formatMessage(en['i18n.verbatim'], { text: 'as typed {x}' }, 'en')).toBe('as typed {x}');
  });
});
