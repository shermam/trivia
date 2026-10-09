import { writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import jsdom from 'jsdom';
import { format, resolveConfig } from 'prettier';

/**
 * Writes `render-contract.golden.json`: what the app's renderer emits for a
 * corpus of inputs, rendered by the live renderer — the TypeScript modules
 * under `src/app/components/rendered-text/`, not a copy of them — over jsdom.
 *
 * **The file is the test of a second renderer.** `render-contract.json`
 * publishes the configuration — the `marked` options, the math delimiters and
 * KaTeX options, the DOMPurify allowlist and hook — for the question-generation
 * pipeline, which renders every candidate the same way before a reviewer sees
 * it. A configuration can be transcribed faithfully and still render
 * differently: a hook ported slightly wrong, a dependency a minor version away,
 * a serialiser that writes an entity another one decodes. Matching this file
 * byte for byte is what turns "the same renderer" from a claim into a check.
 *
 * **Regenerated on purpose, never as a side effect.** Nothing runs this in CI
 * or from another script. `render-contract.spec.ts` re-renders every input
 * under the unit suite's jsdom and fails on any difference, and on a
 * `generatedWith` that no longer names the installed packages, so a change to
 * the renderer or to one of its dependencies fails until somebody runs this
 * and commits the diff — which is then the reviewable record of what changed
 * in the output, and the pipeline's freshness check sees it.
 *
 *     node scripts/render-contract-golden.mjs
 *
 * **The corpus is chosen for what each input exercises**, not for realism:
 * every construct the allowlist carries, each one it refuses, the math the
 * MathML list has to cover, the places the sanitiser is the one doing the
 * work, and inline mode's narrower rules. Add a case here, never in the JSON —
 * the file is written whole, so a case added by hand is gone at the next run.
 *
 * Needs a Node that strips TypeScript types (22.18 or later; this repository
 * runs 24), because it imports the renderer's own `.ts` modules rather than a
 * build of them.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT = `${root}render-contract.golden.json`;
const ENGINE = new URL('../src/app/components/rendered-text/', import.meta.url);
const require = createRequire(import.meta.url);

/** One input, the mode it renders in, and why it is in the corpus. */
const CORPUS = [
  // Text with nothing to parse.
  {
    name: 'plain-question',
    mode: 'block',
    about: 'Text with no Markdown in it: one paragraph.',
    input: 'Which planet is closest to the Sun?',
  },
  {
    name: 'plain-answer',
    mode: 'inline',
    about: 'An answer option carrying characters HTML reads: escaped, with no wrapper element.',
    input: 'Tom & Jerry <3',
  },
  {
    name: 'currency-is-not-math',
    mode: 'block',
    about:
      'Two prices are not a formula: the inline delimiter refuses whitespace before its closing $.',
    input: 'It cost $5 then and $6 today.',
  },
  {
    name: 'character-references',
    mode: 'block',
    about:
      'marked passes references through; the parse DOMPurify does decodes them and the serialiser re-escapes only what HTML needs.',
    input: '&copy; 2026 &amp; &#36;5',
  },

  // Every construct the allowlist carries.
  {
    name: 'emphasis-and-code',
    mode: 'block',
    about: 'strong, em, del (GFM) and an inline code span.',
    input: '**bold**, *italic*, ~~struck~~ and `code`',
  },
  {
    name: 'paragraphs-and-line-breaks',
    mode: 'block',
    about:
      'Two trailing spaces and a trailing backslash are hard breaks (br); a bare newline is a soft one and stays a newline (breaks: false).',
    input: 'First line  \nsecond line\\\nthird line\nsame paragraph\n\nNext paragraph.',
  },
  {
    name: 'blockquote',
    mode: 'block',
    about: 'A quote, with a mark inside it.',
    input: '> Quoted, with **bold** inside',
  },
  {
    name: 'lists',
    mode: 'block',
    about: 'A bulleted list with a nested one, then a numbered list.',
    input: '- one\n- two\n  - nested\n\n1. first\n2. second',
  },
  {
    name: 'https-links',
    mode: 'block',
    about:
      'An https link keeps its href and title and is given target and rel; a bare https URL is a GFM autolink and gets the same.',
    input: '[MDN](https://developer.mozilla.org/en-US/ "Reference") and https://example.org/page',
  },
  {
    name: 'fence-with-language',
    mode: 'block',
    about: 'The one class anything may carry: the fence language.',
    input: '```js\nconst answer = 42;\n```',
  },
  {
    name: 'fence-without-language',
    mode: 'block',
    about: 'A fence with no info string: a code block with no class.',
    input: '```\nno language here\n```',
  },

  // Math.
  {
    name: 'inline-math',
    mode: 'block',
    about: 'A $…$ formula in a sentence: MathML with no display attribute.',
    input: String.raw`The area is $\pi r^2$.`,
  },
  {
    name: 'display-math',
    mode: 'block',
    about: 'A $$…$$ formula on its own lines: a block of its own, display="block", no paragraph.',
    input: String.raw`$$
\int_0^\infty e^{-x}\,dx = 1
$$`,
  },
  {
    name: 'display-math-mid-sentence',
    mode: 'block',
    about: 'A $$…$$ formula inside a paragraph is still displayed in block mode.',
    input: String.raw`So $$e^{i\pi} + 1 = 0$$ holds.`,
  },
  {
    name: 'boxed-cancel-strike',
    mode: 'block',
    about:
      'menclose and its notation attribute — the element whose absence once rendered \\boxed{x} as x.',
    input: String.raw`$\boxed{x} + \cancel{y} + \sout{z}$`,
  },
  {
    name: 'fractions-roots-scripts',
    mode: 'block',
    about: 'mfrac, mroot, msqrt, the script elements, mmultiscripts and the large operators.',
    input: String.raw`$\frac{a}{b} + \sqrt[3]{x} + \sqrt{y} + {}^{3}_{4}z + \sum_{i=1}^{n} a_i$`,
  },
  {
    name: 'cases-environment',
    mode: 'block',
    about: 'mtable, mtr and mtd with their alignment and spacing attributes.',
    input: String.raw`$$\begin{cases} a & x < 0 \\ b & x \ge 0 \end{cases}$$`,
  },
  {
    name: 'delimiters-accents-fonts',
    mode: 'block',
    about:
      'Stretchy fences, an over-brace, an accent, a blackboard letter, a text run and an operator name.',
    input: String.raw`$\left( \frac{a}{b} \right] \overbrace{a+b}^{s} \vec{v} \mathbb{R} \text{ and } \operatorname{sin}\theta$`,
  },
  {
    name: 'math-inside-code',
    mode: 'block',
    about:
      'A delimiter inside a code span or a fence is code: the fence tokenizer claims it first.',
    input: 'Write `$x^2$` for a formula:\n\n```tex\n$$y$$\n```',
  },

  // Each construct the allowlist refuses.
  {
    name: 'heading',
    mode: 'block',
    about: 'A heading is not on the list: the tag goes, its words stay.',
    input: '# A heading\n\nBody text.',
  },
  {
    name: 'image',
    mode: 'block',
    about:
      'An image is not on the list, and an img has no text to keep: the alt text goes with it.',
    input: '![a cat](https://example.org/cat.png)',
  },
  {
    name: 'table',
    mode: 'block',
    about:
      'Table elements are not on the list; their text is kept, except the header row, which DOMPurify drops whole (thead is in its FORBID_CONTENTS).',
    input: '| a | b |\n|---|---|\n| 1 | 2 |',
  },
  {
    name: 'horizontal-rule',
    mode: 'block',
    about: 'A thematic break is not on the list and has no text: it goes.',
    input: 'above\n\n---\n\nbelow',
  },
  {
    name: 'task-list',
    mode: 'block',
    about: 'A GFM task item keeps its text and loses its checkbox.',
    input: '- [x] done\n- [ ] todo',
  },
  {
    name: 'links-that-are-not-https',
    mode: 'block',
    about:
      'http, a relative path, mailto: and javascript: lose their href, and so does a www autolink, which marked gives http://: each anchor stays as its label.',
    input:
      '[plain http](http://example.org/) [relative](/account) [mail](mailto:a@example.org) [click](javascript:alert(1)) www.example.org',
  },

  // Raw HTML and injection.
  {
    name: 'raw-html',
    mode: 'block',
    about:
      "marked's html and tag tokenizers are off: raw HTML is text, escaped before DOMPurify sees it.",
    input: '<b>bold?</b> <div class="x">block</div>',
  },
  {
    name: 'event-handler-injection',
    mode: 'block',
    about: 'An injection attempt: the img and its handler arrive as escaped text.',
    input: 'Before <img src=x onerror=alert(1)> after',
  },
  {
    name: 'markup-inside-math',
    mode: 'block',
    about:
      'Markup inside a formula is TeX to KaTeX: its characters become MathML operators and identifiers.',
    input: '$<script>alert(1)</script>$',
  },

  // KaTeX output the sanitiser has to strip.
  {
    name: 'katex-parse-error',
    mode: 'block',
    about:
      'A formula that will not compile: KaTeX emits a span with an inline style, which the sanitiser drops while keeping the source text.',
    input: String.raw`$\frac{$`,
  },
  {
    name: 'katex-colour-and-rule',
    mode: 'block',
    about:
      'mathcolor and mathbackground are a style attribute in MathML clothing: both go, and the rule keeps the space it reserves.',
    input: String.raw`$\textcolor{red}{x} \rule{1em}{1em}$`,
  },
  {
    name: 'katex-untrusted-command',
    mode: 'block',
    about:
      'KaTeX runs untrusted (trust: false): \\href compiles as an unsupported command, shown as text with its error colour stripped.',
    input: String.raw`$\href{https://evil.example}{x}$`,
  },

  // Inline mode: an answer option, which is a button.
  {
    name: 'inline-link-as-label',
    mode: 'inline',
    about:
      'A link inside a button is nested interactive content: it renders as its formatted label.',
    input: '[**Paris**](https://example.org/a)',
  },
  {
    name: 'inline-display-math',
    mode: 'inline',
    about: 'A $$…$$ formula in an answer compiles undisplayed.',
    input: '$$x^2$$',
  },
  {
    name: 'inline-block-syntax',
    mode: 'inline',
    about: 'parseInline: list, quote and heading syntax stay as characters.',
    input: '- one\n> two\n# three',
  },
  {
    name: 'inline-marks-and-math',
    mode: 'inline',
    about: 'What an answer can carry: marks, code and inline math.',
    input: '**b**, `c` and $\\sqrt{2}$',
  },
];

/**
 * The renderer's modules import each other without an extension, as the
 * Angular build expects. Node does not resolve those, so a sibling `.ts` is
 * tried — and `.ts` files load as ES modules with their types stripped.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    const extensionless =
      specifier.startsWith('.') &&
      !/\.[cm]?[jt]s$/.test(specifier) &&
      (context.parentURL?.endsWith('.ts') ?? false);
    const resolved = nextResolve(extensionless ? `${specifier}.ts` : specifier, context);
    return resolved.url.endsWith('.ts') ? { ...resolved, format: 'module-typescript' } : resolved;
  },
});

if (!process.features.typescript) {
  throw new Error('This Node cannot strip TypeScript types; run it on Node 22.18 or later.');
}

// DOMPurify binds to the global window when its module is first evaluated, so
// the window has to exist before the engine is imported — which is why the
// imports below are dynamic. A document with a doctype, like the unit suite's,
// because KaTeX warns in quirks mode.
const { window } = new jsdom.JSDOM('<!DOCTYPE html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.Element = window.Element;

const { renderMarkdown, sanitizeHtml } = await import(new URL('markdown-engine.ts', ENGINE).href);
const { renderMath } = await import(new URL('math-engine.ts', ENGINE).href);
const { default: katex } = await import('katex');
const { default: DOMPurify } = await import('dompurify');

// DOMPurify without a usable window returns its input untouched rather than
// failing, which would write a golden file of unsanitised markup without a
// word said. Refuse instead.
if (!DOMPurify.isSupported || sanitizeHtml('<img src=x onerror=alert(1)>kept') !== 'kept') {
  throw new Error('DOMPurify is not sanitising under this window; nothing written.');
}

const names = new Set();
for (const { name, mode } of CORPUS) {
  if (names.has(name)) {
    throw new Error(`Two cases are named ${name}.`);
  }
  names.add(name);
  if (mode !== 'block' && mode !== 'inline') {
    throw new Error(`${name}: mode must be block or inline, not ${mode}.`);
  }
}

const golden = {
  $comment: [
    "The app's rendered output for each input below, written by scripts/render-contract-golden.mjs from the live renderer (src/app/components/rendered-text/) under jsdom, with the configuration render-contract.json publishes. Regenerate it with that script; never edit it by hand.",
    'src/app/components/rendered-text/render-contract.spec.ts re-renders every input and fails on any difference, and on a generatedWith that no longer names the installed packages — so a change to the renderer, or to marked, KaTeX, DOMPurify or jsdom, is a change to this file in the same pull request.',
    "A renderer configured from render-contract.json reproduces every output here byte for byte, or it is not the app's renderer. block renders a question and its explanation; inline renders an answer option. output is the string the renderer returns — DOMPurify's serialisation, which the app writes into an element as it is.",
  ],
  version: 1,
  generatedWith: {
    marked: require('marked/package.json').version,
    katex: katex.version,
    dompurify: DOMPurify.version,
    jsdom: require('jsdom/package.json').version,
  },
  cases: CORPUS.map(({ name, mode, about, input }) => ({
    name,
    mode,
    about,
    input,
    output: renderMarkdown(input, { inline: mode === 'inline', renderMath }),
  })),
};

const text = await format(JSON.stringify(golden, null, 2), {
  ...(await resolveConfig(OUTPUT)),
  filepath: OUTPUT,
});
writeFileSync(OUTPUT, text);
console.log(`Wrote ${golden.cases.length} cases to render-contract.golden.json.`);
