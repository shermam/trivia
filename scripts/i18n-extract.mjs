import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ng from '@angular/compiler';
import ts from 'typescript';

/**
 * Writes `src/app/i18n/en.json`: every interface message the app can show,
 * read from its call sites (`docs/app.md` §1.16).
 *
 * **English lives at the call site** — `t('setup.start', 'Start Game')` in
 * TypeScript, `{{ 'setup.start' | t: 'Start Game' }}` in a template — so the
 * English catalogue is not written by hand and is not shipped: nothing at
 * runtime reads this file. What it is for is everything that needs the whole
 * set at once — the `MessageKey` type (`message.ts` imports it type-only), the
 * translations a second locale is checked against, and review, where a change
 * to the copy shows up as a diff here.
 *
 * **Regenerated on purpose, checked in CI.** `npm run i18n:verify` re-runs
 * this extraction in memory and fails when the committed file differs, the
 * same pattern as `render-contract.golden.json`. So a new message is: write
 * the call, run `npm run i18n:extract`, commit both.
 *
 *     node scripts/i18n-extract.mjs
 *
 * What counts as a call site, and what this refuses:
 *
 * - `t(key, english, …)`, `msg(key, english, …)` and `routeTitle(key,
 *   english)` in `src/app/**\/*.ts` (not specs), including `this.i18n.t(…)`;
 *   `t(message)` with one argument renders a message and defines nothing.
 * - The `t` pipe with an English argument in any template, inline ones
 *   included; `message | t` with none renders one and defines nothing.
 * - The key and the English must both be literals. A key is
 *   `<component>.<purpose>` — lower camel case, dot-separated. The same key
 *   with two different English texts, and English that is not valid message
 *   syntax (`src/app/i18n/format.ts`), are errors rather than a guess.
 * - In a template, the English never contains `}}`, so a plural there closes
 *   with `} }`. Angular reads a quoted `}}` as text, but Prettier ends the
 *   interpolation at it and then reflows the rest of the string as markup —
 *   a line break and indentation inside the message, which is how the first
 *   ten of them arrived.
 *
 * Needs a Node that strips TypeScript types (22.18 or later; this repository
 * runs 24), because it parses English with the app's own `format.ts`.
 */

if (!process.features.typescript) {
  throw new Error('This Node cannot strip TypeScript types; run it on Node 22.18 or later.');
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url.endsWith('.ts') ? { ...resolved, format: 'module-typescript' } : resolved;
  },
});
const { parseMessage } = await import('../src/app/i18n/format.ts');

export const root = fileURLToPath(new URL('..', import.meta.url));
export const EN_JSON = join(root, 'src/app/i18n/en.json');
const APP = join(root, 'src/app');
const KEY = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;
const DEFINING_CALLS = new Set(['t', 'msg', 'routeTitle']);

/** Every non-spec `.ts` and `.html` file under `src/app`. */
export function sourceFiles(dir = APP) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (
      /\.html$/.test(entry.name) ||
      (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name))
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

/** Turns an offset into `file:line:col`, for every message this script or the verifier prints. */
export function locator(file, text, base = 0, baseText = text) {
  return (offset) => {
    const upTo = baseText.slice(0, base + offset);
    const line = upTo.split('\n').length;
    const col = upTo.length - upTo.lastIndexOf('\n');
    return `${relative(root, file)}:${line}:${col}`;
  };
}

/**
 * Every template in the app: each `.html` file, and each `template:` in a
 * `.ts` file, with what is needed to report a position in the file it came from.
 */
export function templates(files = sourceFiles()) {
  const found = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.html')) {
      found.push({ file, text, at: locator(file, text) });
      continue;
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'template' &&
        ts.isNoSubstitutionTemplateLiteral(node.initializer) &&
        ts.isDecorator(node.parent.parent?.parent)
      ) {
        const base = node.initializer.getStart() + 1;
        found.push({ file, text: node.initializer.text, at: locator(file, text, base, text) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/**
 * Walks a parsed template and calls `onExpression(ast)` for the root of every
 * expression in it — bindings, interpolations, event handlers, `@if`, `@for`,
 * `@switch`, `@let`, defer triggers — and `onNode(node)` for every template
 * node. Generic over the AST's shape on purpose: a block type added to Angular
 * later is walked rather than silently skipped.
 */
export function walkTemplate(nodes, { onExpression = () => {}, onNode = () => {} }) {
  const seen = new Set();
  const walk = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof ng.AST) {
      onExpression(value instanceof ng.ASTWithSource ? value.ast : value);
      return;
    }
    if (!Array.isArray(value)) onNode(value);
    for (const [key, child] of Object.entries(value)) {
      if (
        key === 'sourceSpan' ||
        key === 'keySpan' ||
        key === 'valueSpan' ||
        key === 'startSourceSpan'
      )
        continue;
      if (key === 'endSourceSpan' || key === 'nameSpan' || key === 'i18n') continue;
      walk(child);
    }
  };
  walk(nodes);
}

/** Calls `visit(node)` for every node of an expression AST, depth first. */
export function walkExpression(ast, visit) {
  const seen = new Set();
  const walk = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof ng.AST) visit(value);
    for (const [key, child] of Object.entries(value)) {
      if (key === 'span' || key === 'sourceSpan' || key === 'nameSpan' || key === 'argumentSpan')
        continue;
      walk(child);
    }
  };
  walk(ast);
}

/**
 * The `t` pipes and `t(…)` calls in an expression that define a message, as
 * `{ keyNode, enNode }` — the literals the extractor reads and the prose check
 * leaves alone.
 */
export function definitionsIn(ast) {
  const found = [];
  walkExpression(ast, (node) => {
    if (node instanceof ng.BindingPipe && node.name === 't' && node.args.length > 0) {
      found.push({ keyNode: node.exp, enNode: node.args[0], at: node.sourceSpan.start });
    } else if (
      node instanceof ng.Call &&
      node.receiver instanceof ng.PropertyRead &&
      DEFINING_CALLS.has(node.receiver.name) &&
      node.args.length > 1
    ) {
      found.push({ keyNode: node.args[0], enNode: node.args[1], at: node.sourceSpan.start });
    }
  });
  return found;
}

/** Parses one template the way the Angular compiler does, failing loudly on a syntax error. */
export function parseTemplateOrThrow({ text, file }) {
  const parsed = ng.parseTemplate(text, file, { preserveWhitespaces: false });
  if (parsed.errors?.length) {
    throw new Error(
      `${relative(root, file)}: ${parsed.errors.map((e) => e.toString()).join('\n')}`,
    );
  }
  return parsed.nodes;
}

/**
 * The calls in a TypeScript file that define a message, as
 * `{ name, keyNode, enNode }` with TypeScript nodes.
 */
export function tsDefinitions(source) {
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      const definesOne = name === 't' ? node.arguments.length > 1 : node.arguments.length > 0;
      if (DEFINING_CALLS.has(name) && definesOne) {
        found.push({ name, keyNode: node.arguments[0], enNode: node.arguments[1], call: node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Reads every message definition in the app. Returns `{ messages, errors }`. */
export function extract(files = sourceFiles()) {
  const messages = new Map();
  const errors = [];
  const record = (key, en, where, inTemplate = false) => {
    if (typeof key !== 'string' || !KEY.test(key)) {
      errors.push(
        `${where}: the key must be a literal "<component>.<purpose>", not ${JSON.stringify(key)}`,
      );
      return;
    }
    if (typeof en !== 'string') {
      errors.push(`${where}: the English for "${key}" must be a string literal`);
      return;
    }
    if (inTemplate && en.includes('}}')) {
      errors.push(
        `${where}: the English for "${key}" contains "}}", which Prettier takes for the end of the interpolation; close the plural with "} }"`,
      );
      return;
    }
    if (parseMessage(en) === null) {
      errors.push(
        `${where}: the English for "${key}" is not valid message syntax: ${JSON.stringify(en)}`,
      );
      return;
    }
    const seen = messages.get(key);
    if (seen && seen.en !== en) {
      errors.push(
        `${where}: "${key}" is ${JSON.stringify(en)} here and ${JSON.stringify(seen.en)} at ${seen.where}`,
      );
      return;
    }
    if (!seen) messages.set(key, { en, where });
  };

  for (const file of files.filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const at = locator(file, text);
    // The mechanism's own forwarding calls (`this.i18n.t(key, en)` inside the
    // pipe) pass variables along and define nothing; its literal ones
    // (`verbatim()`'s) define a message like any other.
    const forwards = file.startsWith(join(APP, 'i18n'));
    for (const { keyNode, enNode, call } of tsDefinitions(source)) {
      const literal = (node) =>
        node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
          ? node.text
          : undefined;
      if (forwards && (literal(keyNode) === undefined || literal(enNode) === undefined)) continue;
      record(literal(keyNode), literal(enNode), at(call.getStart()));
    }
  }
  for (const template of templates(files)) {
    const nodes = parseTemplateOrThrow(template);
    walkTemplate(nodes, {
      onExpression: (ast) => {
        for (const { keyNode, enNode, at } of definitionsIn(ast)) {
          const literal = (node) =>
            node instanceof ng.LiteralPrimitive && typeof node.value === 'string'
              ? node.value
              : undefined;
          record(literal(keyNode), literal(enNode), template.at(at), true);
        }
      },
    });
  }
  return { messages, errors };
}

/** `en.json` as it should read, given `messages` — sorted, so the diff is the change. */
export function serialize(messages) {
  const sorted = Object.fromEntries(
    [...messages.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, v.en]),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { messages, errors } = extract();
  if (errors.length) {
    console.error(`✗ ${errors.length} message definition(s) refused:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  writeFileSync(EN_JSON, serialize(messages));
  console.log(`✓ Wrote ${relative(root, EN_JSON)}: ${messages.size} messages.`);
}
