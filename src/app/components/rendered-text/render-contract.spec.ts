import DOMPurify, { type Config, type HookName } from 'dompurify';
import jsdomPackage from 'jsdom/package.json';
import katex from 'katex';
import type { Marked, TokenizerExtensionFunction, TokenizerStartFunction } from 'marked';
import markedPackage from 'marked/package.json';
import { describe, expect, it, vi } from 'vitest';
// The renderer's contract and its golden corpus, as the repository publishes
// them for the question-generation pipeline, plus the app's own manifest for
// the declared dependency ranges. Read by this spec and nothing else: no file
// under `src/app` imports them, so none of them reaches a bundle.
import appPackage from '../../../../package.json';
import golden from '../../../../render-contract.golden.json';
import contract from '../../../../render-contract.json';
import {
  INLINE_SANITIZE_CONFIG,
  LANGUAGE_CLASS,
  SANITIZE_CONFIG,
  markedFor,
  renderMarkdown,
  sanitizeHtml,
} from './markdown-engine';
import { DISPLAY_MATH_BLOCK, DISPLAY_MATH_INLINE, INLINE_MATH } from './math-delimiters';
import { renderMath } from './math-engine';

/**
 * `render-contract.json` — what this renderer accepts and emits, published for
 * the renderer the repository does not run (the question-generation pipeline,
 * which renders every candidate the same way before a reviewer sees it) —
 * checked against the live engines.
 *
 * **Read back from what runs, never from what was passed.** The `marked`
 * options are taken off the instances `renderMarkdown` parses with, which hold
 * `marked`'s defaults merged with everything the engine passed — so a default
 * that moves in an upgrade fails here as surely as an edit does. The KaTeX
 * options are the ones `renderToString` actually receives, captured on the
 * call; the DOMPurify configuration is the object `sanitize` receives, in each
 * mode, and the hook is found where DOMPurify keeps it. A copy restated in
 * this file would keep passing after the real one changed.
 *
 * **Where a published value is a behaviour rather than a value** — which
 * attributes the hook confines to anchors, what a disabled tokenizer does, how
 * a delimiter becomes a token — the probes are derived from the file: the
 * expected result is computed from what it says, against the live code, so
 * either side moving alone fails.
 *
 * **The golden corpus is the other half.** `render-contract.golden.json` is
 * the output of this configuration for a corpus of inputs, and the last
 * describe block re-renders every one. A configuration can match field for
 * field and still render differently — which is exactly what the pipeline's
 * copy has to be checked against — so the outputs are pinned as well as the
 * settings. When one moves on purpose, `node scripts/render-contract-golden.mjs`
 * rewrites the file and the diff is the record.
 */

type Mode = 'block' | 'inline';
const MODES: readonly Mode[] = ['block', 'inline'];

/** The very instance `renderMarkdown` parses with in this mode — `markedFor` is memoized. */
const instanceFor = (mode: Mode): Marked => markedFor(renderMath, mode === 'inline');

interface Pattern {
  readonly source: string;
  readonly flags: string;
}

const patternOf = (regexp: RegExp): Pattern => ({ source: regexp.source, flags: regexp.flags });

/** A DOMPurify configuration in the file's notation: a RegExp as `{ source, flags }`. */
const published = (config: Config): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      value instanceof RegExp ? patternOf(value) : value,
    ]),
  );

/**
 * The own properties `use()` added to a tokenizer or renderer, which is how
 * `marked` records a replaced method: the class keeps its own on the
 * prototype, and the fields named here are its only other own properties.
 */
const replaced = (object: object | null | undefined, fields: readonly string[]): string[] =>
  object ? Object.keys(object).filter((key) => !fields.includes(key)) : [];

function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

interface PublishedDelimiter extends Pattern {
  readonly displayMode: Readonly<Record<Mode, boolean>>;
}

const delimiters = contract.math.delimiters as Readonly<Record<string, PublishedDelimiter>>;

/** Which export each published delimiter name stands for. */
const DELIMITER_EXPORTS: Readonly<Record<string, RegExp>> = {
  displayBlock: DISPLAY_MATH_BLOCK,
  displayInline: DISPLAY_MATH_INLINE,
  inline: INLINE_MATH,
};

/** The packages as they are installed — the code this suite is actually running. */
const INSTALLED: Readonly<Record<string, string>> = {
  marked: markedPackage.version,
  katex: katex.version,
  dompurify: DOMPurify.version,
};

/** The release series a caret range fixes: the major, or for a 0.x version the minor. */
function series(version: string): string {
  const [major, minor] = version.split('.');
  return major === '0' ? `0.${minor}` : major;
}

describe('render-contract.json: the file itself', () => {
  // Every section is one this suite checks. A key the file gains is a claim
  // nobody holds it to until a check is added here — the stance the bounds
  // file's spec takes for the same reason.
  it('holds exactly the sections this suite checks', () => {
    expect(Object.keys(contract).sort()).toEqual(
      [
        '$comment',
        'version',
        'source',
        'dependencies',
        'marked',
        'math',
        'katex',
        'dompurify',
      ].sort(),
    );
  });

  // The three files are the ones this spec imports, so a rename breaks the
  // build of this file; this keeps the published pointer moving with it.
  it('is version 1 of the format and names the modules it states', () => {
    expect(contract.version).toBe(1);
    expect(contract.source).toEqual({
      repository: 'shermam/trivia',
      directory: 'src/app/components/rendered-text',
      files: ['markdown-engine.ts', 'math-delimiters.ts', 'math-engine.ts'],
    });
  });
});

describe('render-contract.json: marked', () => {
  // The other three options are the structural ones, each published under its
  // own key and checked below; anything else marked holds must be named here.
  it.each(MODES)('%s mode holds exactly the published options', (mode) => {
    const options = instanceFor(mode).defaults as Record<string, unknown>;
    expect(Object.keys(options).sort()).toEqual(
      [...Object.keys(contract.marked.options), 'extensions', 'renderer', 'tokenizer'].sort(),
    );
    for (const [option, value] of Object.entries(contract.marked.options)) {
      expect(options[option], option).toEqual(value);
    }
  });

  it.each(MODES)('%s mode replaces exactly the published tokenizers', (mode) => {
    const tokenizer = instanceFor(mode).defaults.tokenizer;
    expect(replaced(tokenizer, ['options', 'rules', 'lexer'])).toEqual(
      Object.keys(contract.marked.tokenizer),
    );
  });

  // `disabled` means the replacement claims nothing — returns no token — so the
  // run falls through to the text tokenizer and is escaped. Asked of the
  // replaced method directly, with input the built-in one would have claimed.
  it.each(MODES)('%s mode has every published disabled tokenizer claim nothing', (mode) => {
    const methods = instanceFor(mode).defaults.tokenizer as unknown as Record<
      string,
      (src: string) => unknown
    >;
    for (const [name, behaviour] of Object.entries(contract.marked.tokenizer)) {
      expect(behaviour, name).toBe('disabled');
      for (const html of ['<div>block</div>\n', '<b>tag</b>', '<!-- comment -->']) {
        expect(methods[name](html), `${name}(${JSON.stringify(html)})`).toBeUndefined();
      }
    }
  });

  it.each(MODES)('%s mode replaces exactly the published renderers', (mode) => {
    expect(replaced(instanceFor(mode).defaults.renderer, ['options', 'parser'])).toEqual(
      Object.keys(contract.marked.renderer[mode]),
    );
  });

  // `label`: the link's own inline tokens, rendered as they would be without it.
  it('renders a link as its label where the file says label', () => {
    expect(contract.marked.renderer.inline).toEqual({ link: 'label' });
    const instance = instanceFor('inline');
    expect(instance.parseInline('[**a** `b`](https://example.org/)')).toBe(
      instance.parseInline('**a** `b`'),
    );
  });

  it.each(MODES)('%s mode parses with the published method', (mode) => {
    const instance = instanceFor(mode);
    const calls = {
      parse: vi.spyOn(instance, 'parse'),
      parseInline: vi.spyOn(instance, 'parseInline'),
    };
    try {
      renderMarkdown('x', { renderMath, inline: mode === 'inline' });
      expect({
        parse: calls.parse.mock.calls.length,
        parseInline: calls.parseInline.mock.calls.length,
      }).toEqual({ parse: 0, parseInline: 0, [contract.marked.parse[mode]]: 1 });
    } finally {
      calls.parse.mockRestore();
      calls.parseInline.mockRestore();
    }
  });
});

describe('render-contract.json: the math tokenizers', () => {
  it('publishes each delimiter as the pattern the tokenizers are built from', () => {
    expect(
      Object.fromEntries(
        Object.entries(delimiters).map(([name, { source, flags }]) => [name, { source, flags }]),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(DELIMITER_EXPORTS).map(([name, regexp]) => [name, patternOf(regexp)]),
      ),
    );
  });

  it('names every published delimiter in exactly one extension', () => {
    expect(contract.math.extensions.flatMap((extension) => extension.delimiters).sort()).toEqual(
      Object.keys(delimiters).sort(),
    );
  });

  /**
   * Sources a math tokenizer is offered, chosen around the edges the
   * delimiters exist for: the newlines a block formula swallows, a display
   * formula with text after it, whitespace inside the inline delimiters, and
   * the prices the inline rule has to leave alone.
   */
  const TOKEN_PROBES = [
    '$$ x^2 $$',
    '$$ x^2 $$\n\nafter',
    '$$x$$ and more',
    '$$\n\\frac{a}{b}\n$$',
    '$x^2$ and more',
    '$ x$',
    '$x $',
    '$5 and $6',
    '$5$6',
    '$$',
    'no math',
  ];

  /** What the file says a tokenizer trying these delimiters, in order, makes of the source. */
  function expectedToken(names: readonly string[], source: string, mode: Mode) {
    for (const name of names) {
      const delimiter = delimiters[name];
      const match = new RegExp(delimiter.source, delimiter.flags).exec(source);
      if (match) {
        return { raw: match[0], text: match[1].trim(), displayMode: delimiter.displayMode[mode] };
      }
    }
    return undefined;
  }

  it.each(MODES)(
    '%s mode carries the published extensions, in order, at their levels, tokenizing as published',
    (mode) => {
      const instance = instanceFor(mode);
      const extensions = instance.defaults.extensions;
      expect(Object.keys(extensions?.renderers ?? {})).toEqual(
        contract.math.extensions.map((extension) => extension.name),
      );

      // `use()` adds a tokenizer to the front of its level's list and a start
      // function to the back of its own, so the first list is read reversed.
      const tokenizers: Record<'block' | 'inline', TokenizerExtensionFunction[]> = {
        block: [...(extensions?.block ?? [])].reverse(),
        inline: [...(extensions?.inline ?? [])].reverse(),
      };
      const starts: Record<'block' | 'inline', TokenizerStartFunction[]> = {
        block: extensions?.startBlock ?? [],
        inline: extensions?.startInline ?? [],
      };
      const context = { lexer: new instance.Lexer(instance.defaults) };

      for (const level of ['block', 'inline'] as const) {
        const atLevel = contract.math.extensions.filter((extension) => extension.level === level);
        expect(tokenizers[level], level).toHaveLength(atLevel.length);
        expect(starts[level], level).toHaveLength(atLevel.length);

        atLevel.forEach((extension, index) => {
          for (const source of ['', 'x', '$', '$$', 'a$b', 'a$b$$c', 'a$$b$c']) {
            expect(
              starts[level][index].call(context, source),
              `${extension.name} start in ${JSON.stringify(source)}`,
            ).toBe(source.indexOf(extension.start));
          }
          for (const source of TOKEN_PROBES) {
            const token = tokenizers[level][index].call(context, source, []);
            expect(
              token && { raw: token.raw, text: token['text'], displayMode: token['displayMode'] },
              `${extension.name} on ${JSON.stringify(source)}`,
            ).toEqual(expectedToken(extension.delimiters, source, mode));
          }
        });
      }
    },
  );
});

describe('render-contract.json: KaTeX', () => {
  it('receives exactly the published options, besides displayMode', () => {
    const renderToString = vi.spyOn(katex, 'renderToString');
    try {
      for (const displayMode of [true, false]) {
        renderToString.mockClear();
        renderMath('x', displayMode);
        expect(renderToString).toHaveBeenCalledOnce();
        expect(renderToString.mock.calls[0][1]).toStrictEqual({
          ...contract.katex.options,
          displayMode,
        });
      }
    } finally {
      renderToString.mockRestore();
    }
  });

  /**
   * The options KaTeX is not given are whatever its defaults say, so the ones
   * the renderer's safety rests on are published with their value and read
   * back from the schema KaTeX resolves them from. `katexDefault` is KaTeX's
   * own rule (`getDefaultValue` in `katex.mjs`): the schema's default, else
   * the zero value of the option's first type — which is how `trust` comes to
   * be `false` without a default of its own.
   */
  it('leaves the published options to KaTeX, whose defaults are the published values', () => {
    interface Setting {
      readonly type: unknown;
      readonly default?: unknown;
    }
    const schema = (katex as unknown as { SETTINGS_SCHEMA: Record<string, Setting | undefined> })
      .SETTINGS_SCHEMA;
    const katexDefault = (setting: Setting): unknown => {
      if (setting.default !== undefined) {
        return setting.default;
      }
      const type = Array.isArray(setting.type) ? setting.type[0] : setting.type;
      if (typeof type === 'object' && type !== null && 'enum' in type) {
        return (type as { enum: unknown[] }).enum[0];
      }
      return ({ boolean: false, string: '', number: 0, object: {} } as Record<string, unknown>)[
        type as string
      ];
    };

    for (const [option, value] of Object.entries(contract.katex.defaults)) {
      expect(Object.keys(contract.katex.options), option).not.toContain(option);
      const setting = schema[option];
      expect(setting, `${option} is a KaTeX option`).toBeDefined();
      expect(katexDefault(setting!), option).toEqual(value);
    }
  });
});

describe('render-contract.json: DOMPurify', () => {
  const block = contract.dompurify.block as Record<string, unknown>;
  const expected: Record<Mode, Record<string, unknown>> = {
    block,
    inline: { ...block, ...contract.dompurify.inline },
  };

  it.each(MODES)('%s mode sanitises with exactly the published configuration', (mode) => {
    const sanitize = vi.spyOn(DOMPurify, 'sanitize');
    try {
      renderMarkdown('x', { renderMath, inline: mode === 'inline' });
      expect(sanitize).toHaveBeenCalledOnce();
      const config = sanitize.mock.calls[0][1] as Config;
      expect(config).toBe(mode === 'inline' ? INLINE_SANITIZE_CONFIG : SANITIZE_CONFIG);
      expect(published(config)).toStrictEqual(expected[mode]);
    } finally {
      sanitize.mockRestore();
    }
  });

  /**
   * Every entry point DOMPurify has, held to its own type: a point it adds is
   * a missing key here, which fails to compile rather than going unchecked.
   */
  const HOOK_POINTS = {
    beforeSanitizeElements: true,
    uponSanitizeElement: true,
    afterSanitizeElements: true,
    beforeSanitizeAttributes: true,
    uponSanitizeAttribute: true,
    afterSanitizeAttributes: true,
    beforeSanitizeShadowDOM: true,
    uponSanitizeShadowNode: true,
    afterSanitizeShadowDOM: true,
  } satisfies Record<HookName, true>;

  /**
   * DOMPurify keeps its hooks private, so they are read the only way it
   * allows — removed one at a time — and put back in the order they were
   * found, which leaves the sanitiser exactly as it was for every test after
   * this one. Spec files share a worker's modules (`ci-cd.md` §4.5), so the
   * engine's hook may have been installed by another file; the sanitise call
   * first makes sure it is.
   */
  it('runs one hook, at the published entry point, and no other', () => {
    sanitizeHtml('<p>x</p>');
    const remove = DOMPurify.removeHook as unknown as (point: HookName) => unknown;
    const add = DOMPurify.addHook as unknown as (point: HookName, hook: unknown) => void;

    const installed: Partial<Record<HookName, number>> = {};
    for (const point of Object.keys(HOOK_POINTS) as HookName[]) {
      const hooks: unknown[] = [];
      for (let hook = remove(point); hook !== undefined; hook = remove(point)) {
        hooks.unshift(hook);
      }
      hooks.forEach((hook) => add(point, hook));
      if (hooks.length > 0) {
        installed[point] = hooks.length;
      }
    }

    expect(installed).toEqual(
      Object.fromEntries(Object.keys(contract.dompurify.hooks).map((point) => [point, 1])),
    );
  });

  const hook = contract.dompurify.hooks.afterSanitizeAttributes;

  it('keeps exactly the class names the published pattern matches', () => {
    expect(patternOf(LANGUAGE_CLASS)).toEqual(hook.classKeep);
    const keep = new RegExp(hook.classKeep.source, hook.classKeep.flags);
    const names = ['language-js', 'x-evil', 'language-c++', 'language-', 'lang-js', 'language-a!'];
    const code = parse(sanitizeHtml(`<pre><code class="${names.join(' ')}">c</code></pre>`));
    expect(code.querySelector('code')?.getAttribute('class')).toBe(
      names.filter((name) => keep.test(name)).join(' '),
    );
    // None left: the attribute goes rather than staying empty.
    expect(
      parse(sanitizeHtml('<code class="fixed inset-0">c</code>'))
        .querySelector('code')
        ?.hasAttribute('class'),
    ).toBe(false);
  });

  /**
   * Derived over the whole published attribute list rather than checked for
   * the two names alone: an attribute is anchor-only when an `<a>` keeps it
   * and both a prose element and a MathML one lose it. So the hook confining
   * one more, or one fewer, fails here whichever side it happened on.
   */
  it('confines exactly the published attributes to anchors', () => {
    const value = 'https://example.org/';
    const keeps = (html: string, selector: string, attribute: string): boolean =>
      parse(sanitizeHtml(html)).querySelector(selector)?.hasAttribute(attribute) ?? false;

    const anchorOnly = contract.dompurify.block.ALLOWED_ATTR.filter(
      (attribute) =>
        keeps(`<a ${attribute}="${value}">x</a>`, 'a', attribute) &&
        !keeps(`<p ${attribute}="${value}">x</p>`, 'p', attribute) &&
        !keeps(`<math><mi ${attribute}="${value}">x</mi></math>`, 'mi', attribute),
    );
    expect(anchorOnly).toEqual(hook.anchorOnly);
  });

  it('gives a link with the published protocol the published attributes, and any other link none', () => {
    for (const protocol of ['https:', 'http:', 'ftp:', 'mailto:', 'javascript:', 'data:']) {
      const href = `${protocol}//example.org/`;
      const link = parse(
        sanitizeHtml(`<a href="${href}" target="_top" rel="opener">x</a>`),
      ).querySelector('a');
      expect(
        Object.fromEntries([...(link?.attributes ?? [])].map(({ name, value }) => [name, value])),
        protocol,
      ).toEqual(protocol === hook.linkProtocol ? { href, ...hook.linkAttributes } : {});
    }
    // A relative reference does not parse as a URL on its own.
    expect(
      parse(sanitizeHtml('<a href="/account">x</a>')).querySelector('a')?.attributes,
    ).toHaveLength(0);
  });
});

describe('render-contract.json: dependencies', () => {
  it('names the three packages the renderer is built on', () => {
    expect(Object.keys(contract.dependencies).sort()).toEqual(['dompurify', 'katex', 'marked']);
  });

  it.each(Object.keys(contract.dependencies))(
    '%s is installed, and declared, in the published series',
    (name) => {
      const publishedSeries = (contract.dependencies as Record<string, string>)[name];
      expect(series(INSTALLED[name]), 'installed').toBe(publishedSeries);
      const declared = (appPackage.dependencies as Record<string, string>)[name];
      expect(declared, 'declared as a caret range').toMatch(/^\^\d/);
      expect(series(declared.slice(1)), 'declared').toBe(publishedSeries);
    },
  );
});

describe('render-contract.golden.json', () => {
  const REGENERATE =
    'differs from render-contract.golden.json — if that is meant, run ' +
    '`node scripts/render-contract-golden.mjs` and commit the diff';

  it('is version 1 of its format and was generated with the packages installed now', () => {
    expect(Object.keys(golden).sort()).toEqual(['$comment', 'cases', 'generatedWith', 'version']);
    expect(golden.version).toBe(1);
    expect(golden.generatedWith, REGENERATE).toEqual({ ...INSTALLED, jsdom: jsdomPackage.version });
  });

  it('names each case once, in one of the two modes', () => {
    const names = golden.cases.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of golden.cases) {
      expect(MODES, entry.name).toContain(entry.mode);
    }
  });

  it.each(golden.cases)('$name renders as published', ({ mode, input, output }) => {
    expect(renderMarkdown(input, { renderMath, inline: mode === 'inline' }), REGENERATE).toBe(
      output,
    );
  });
});
