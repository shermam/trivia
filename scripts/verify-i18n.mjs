import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import * as ng from '@angular/compiler';
import ts from 'typescript';
import {
  EN_JSON,
  definitionsIn,
  extract,
  locator,
  parseTemplateOrThrow,
  root,
  serialize,
  sourceFiles,
  templates,
  tsDefinitions,
  walkExpression,
  walkTemplate,
} from './i18n-extract.mjs';

/**
 * `npm run i18n:verify` — the second of the interface-text guard's three parts
 * (`docs/ci-cd.md` §4.5). The first is the `@angular-eslint/template/i18n`
 * rule, which fails lint on a letter in a template's text or in a static
 * attribute; the third is `i18n-bundles.spec.ts`. This covers what the lint
 * rule cannot see, and fails on any of:
 *
 * 1. **A stale `en.json`.** The extraction (`scripts/i18n-extract.mjs`) is
 *    re-run in memory and compared byte for byte with the committed file, so
 *    a message added, changed or removed at a call site fails until
 *    `npm run i18n:extract` has been run and its output committed.
 * 2. **A prose literal in TypeScript** under `src/app` (specs excepted): a
 *    string that reads like interface copy and is not the key or English of a
 *    `t()`/`msg()`/`routeTitle()` call. Developer-facing text — `console.*`,
 *    `new Error(…)` — import paths, property names and literal types are not
 *    copy and are skipped.
 * 3. **A prose literal in a template expression** — `[attr.aria-label]="'Close'"`,
 *    a ternary between two sentences — which the lint rule cannot see because
 *    it only reads static text.
 * 4. **An `i18n` attribute.** It is what the lint rule's message suggests and
 *    its autofix inserts, and it is Angular's build-time i18n, which this app
 *    does not use: the fix for a flagged string is a key.
 * 5. **A lint exemption without a reason** — an `eslint-disable` naming the
 *    template rule that does not end `-- <why>`.
 *
 * **What reads as prose** is a heuristic, and it is written down so it can be
 * argued with: two or more words with a capital, an apostrophe or a
 * sentence's closing punctuation; or one capitalised word (`'Close'`); or one
 * lower-case word ending a sentence. A Tailwind class list — lower-case,
 * unpunctuated tokens — is not prose. Text that is not copy and still reads
 * like it (a provider's name, a stored value) is exempted where it stands,
 * with a reason: `// i18n-exempt: <why>` on the literal's line or above the
 * statement, property or array element holding it — or above a whole function
 * whose every message is for a developer — or `<!-- i18n-exempt: <why> -->` on
 * or directly above the template line.
 *
 * What none of this catches is listed in `docs/ci-cd.md`: a sentence built
 * from fragments, a wrong translation, `Intl` without the locale, and text in
 * a state no test renders.
 */

const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);
const EXEMPT = /i18n-exempt:\s*\S.{2,}/;
const DEVELOPER_CALLEES = /^(console\.\w+|Error|TypeError|RangeError|SyntaxError|DOMException)$/;
/** A string method's argument is a pattern or a comparison, never something shown: `key.startsWith('Arrow')`. */
const STRING_METHODS =
  /\.(startsWith|endsWith|includes|indexOf|lastIndexOf|split|replace|replaceAll|match|matchAll|search|test)$/;
const EQUALITY = new Set(['==', '===', '!=', '!==']);
const DECORATOR_NON_COPY = new Set([
  'selector',
  'templateUrl',
  'styleUrl',
  'styleUrls',
  'template',
]);

/** Whether `text` reads like a piece of interface copy — the heuristic described above. */
function isProse(text) {
  const value = text.trim();
  if (!/\p{L}/u.test(value)) return false;
  const tokens = value.split(/\s+/);
  const words = tokens.filter((token) => /\p{L}{2,}/u.test(token));
  const endsSentence = /\p{L}[.!?…:]["')\]]?$/u.test(value);
  if (words.length >= 2) {
    const codeLike = tokens.every((token) =>
      /^[a-z0-9!:_\-[\]/.%()#&>~=*@,'"`+|^$<{}]*$/.test(token),
    );
    if (codeLike && !endsSentence) return false;
    return /\p{Lu}/u.test(value) || endsSentence || /\p{L}['’]\p{L}/u.test(value) || !codeLike;
  }
  return /^\p{Lu}\p{Ll}+[.!?…:]?$/u.test(value) || /^\p{Ll}{2,}[.!?…]$/u.test(value);
}

// 1. en.json is what the call sites say.
const { messages, errors } = extract();
for (const error of errors) failures.push(error);
if (!errors.length && readFileSync(EN_JSON, 'utf8') !== serialize(messages)) {
  fail(
    relative(root, EN_JSON),
    'stale — it does not match the messages at the call sites; run `npm run i18n:extract` and commit it',
  );
}

// 2. Prose literals in TypeScript.
function climbToArgument(node) {
  let current = node;
  while (
    (ts.isBinaryExpression(current.parent) &&
      current.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    (ts.isConditionalExpression(current.parent) && current.parent.condition !== current)
  ) {
    current = current.parent;
  }
  return current;
}

function isSkippedContext(node) {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isExternalModuleReference(parent) || ts.isLiteralTypeNode(parent)) return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  // Compared, never shown: `event.key === 'Escape'`, `case 'True':`.
  if (ts.isCaseClause(parent)) return true;
  if (
    ts.isBinaryExpression(parent) &&
    [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(parent.operatorToken.kind)
  ) {
    return true;
  }
  // A host binding's value is an expression, as in a template: `'[attr.x]': 'y() + "-z"'`.
  if (
    ts.isPropertyAssignment(parent) &&
    ts.isStringLiteral(parent.name) &&
    /^[[(]/.test(parent.name.text)
  ) {
    return true;
  }
  if (
    ts.isPropertyAssignment(parent) &&
    ts.isIdentifier(parent.name) &&
    DECORATOR_NON_COPY.has(parent.name.text) &&
    parent.parent?.parent?.parent &&
    ts.isDecorator(parent.parent.parent.parent)
  ) {
    return true;
  }
  const argument = climbToArgument(node);
  const call = argument.parent;
  if (
    (ts.isCallExpression(call) || ts.isNewExpression(call)) &&
    call.arguments?.includes(argument)
  ) {
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
    const callee = call.expression.getText();
    if (DEVELOPER_CALLEES.test(callee) || STRING_METHODS.test(callee)) return true;
  }
  return false;
}

function isExemptTs(node, text) {
  const lineStart = text.lastIndexOf('\n', node.getStart()) + 1;
  const lineEnd = text.indexOf('\n', node.getStart());
  if (EXEMPT.test(text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd))) return true;
  // The trivia before a node holds both a comment on the lines above it and one
  // ending the previous line (`? // i18n-exempt: …`). An exemption reaches the
  // nearest statement, class member, property or array element holding the
  // literal — or a whole function, for one whose every message is for a
  // developer — and never the file.
  const trivia = (current) => text.slice(current.getFullStart(), current.getStart());
  let reachedStatement = false;
  for (let current = node; current && !ts.isSourceFile(current); current = current.parent) {
    const isFunction = ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current);
    if ((!reachedStatement || isFunction) && EXEMPT.test(trivia(current))) return true;
    if (ts.isStatement(current) || ts.isClassElement(current)) reachedStatement = true;
  }
  return false;
}

for (const file of sourceFiles().filter(
  (f) => f.endsWith('.ts') && !/\/src\/app\/i18n\//.test(f),
)) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const at = locator(file, text);
  const definitionArgs = new Set(tsDefinitions(source).flatMap((d) => [d.keyNode, d.enNode]));
  const visit = (node) => {
    let value;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text;
    else if (ts.isTemplateExpression(node)) {
      value = node.head.text + node.templateSpans.map((span) => `{} ${span.literal.text}`).join('');
    }
    if (value !== undefined && !definitionArgs.has(node) && isProse(value)) {
      if (!isSkippedContext(node) && !isExemptTs(node, text)) {
        fail(
          at(node.getStart()),
          `prose literal ${JSON.stringify(value)} — use t()/msg() or exempt it with a reason`,
        );
      }
    }
    if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
  };
  visit(source);
}

// 3–5. Templates: prose in expressions, `i18n` attributes, reasons on exemptions.
for (const template of templates()) {
  const nodes = parseTemplateOrThrow(template);
  const lines = template.text.split('\n');
  const lineOf = (offset) => template.text.slice(0, offset).split('\n').length - 1;
  const exempt = (offset) => {
    const line = lineOf(offset);
    return EXEMPT.test(lines[line] ?? '') || EXEMPT.test(lines[line - 1] ?? '');
  };
  walkTemplate(nodes, {
    onNode: (node) => {
      if (node.i18n && node.sourceSpan) {
        fail(
          template.at(node.sourceSpan.start.offset),
          'an `i18n` attribute — interface text goes through a key and the `t` pipe',
        );
      }
    },
    onExpression: (ast) => {
      const definitionArgs = new Set(definitionsIn(ast).flatMap((d) => [d.keyNode, d.enNode]));
      // Compared, never shown: `form.value.correctAnswer === 'True'`.
      walkExpression(ast, (node) => {
        if (node instanceof ng.Binary && EQUALITY.has(node.operation)) {
          definitionArgs.add(node.left);
          definitionArgs.add(node.right);
        }
      });
      walkExpression(ast, (node) => {
        let value;
        if (node instanceof ng.LiteralPrimitive && typeof node.value === 'string')
          value = node.value;
        else if (node instanceof ng.TemplateLiteral)
          value = node.elements.map((e) => e.text).join('{} ');
        if (value === undefined || definitionArgs.has(node) || !isProse(value)) return;
        if (!exempt(node.sourceSpan.start)) {
          fail(
            template.at(node.sourceSpan.start),
            `prose literal ${JSON.stringify(value)} in a template expression — use the \`t\` pipe`,
          );
        }
      });
    },
  });
}
for (const file of sourceFiles()) {
  const text = readFileSync(file, 'utf8');
  const at = locator(file, text);
  for (const match of text.matchAll(
    /eslint-disable[^\n]*?@angular-eslint\/template\/i18n([^\n]*)/g,
  )) {
    if (!/\s--\s+\S/.test(match[1])) {
      fail(
        at(match.index),
        'an exemption from the template i18n rule needs a reason: `… -- <why>`',
      );
    }
  }
}

if (failures.length) {
  console.error(`✗ Interface text check failed (${failures.length}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `✓ Interface text: ${messages.size} messages, en.json is current, no prose outside a key.`,
);
