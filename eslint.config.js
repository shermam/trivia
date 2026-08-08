// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');

/**
 * Scaffolded via `ng add angular-eslint@22.1.0` (version-pinned to the
 * installed Angular major — see INFRASTRUCTURE.md §2a for why an unpinned
 * `ng add` is a trap), then extended below.
 *
 * The extensions are deliberate rather than "recommended plus everything":
 * each one either backs an invariant in CLAUDE.md §4 or catches a class of
 * defect the audit actually found. Rules that would only enforce a style
 * preference are left off — Prettier owns formatting, and a lint run that
 * cries wolf gets ignored.
 */
module.exports = defineConfig([
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    languageOptions: {
      parserOptions: {
        // Type-aware linting. Costs a little run time, and buys the
        // `no-floating-promises` / `no-misused-promises` pair below, which
        // are the only mechanical defence this codebase has against a
        // forgotten `await` on a Firestore or Auth call.
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],

      // An unawaited promise in a service that talks to Firestore/Auth fails
      // silently — no rejection surfaces, the UI just never updates. Both of
      // these need type information, hence `projectService` above.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // `const { cachedAt: _cachedAt, ...rest }` is the idiomatic way to drop
      // a field; the leading underscore is the conventional opt-out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {
      // Not in the recommended sets, all cheap, all catching real classes of
      // bug this app is exposed to:
      //  - button-has-type: a <button> without `type` inside a <form> submits
      //    it. This app has forms with sibling non-submit buttons.
      //  - no-duplicate-attributes: silently drops one of the two.
      //  - no-positive-tabindex: breaks natural focus order for everyone.
      //  - eqeqeq: `==` in a template coerces, same footgun as in TS.
      '@angular-eslint/template/button-has-type': 'error',
      '@angular-eslint/template/no-duplicate-attributes': 'error',
      '@angular-eslint/template/no-positive-tabindex': 'error',
      '@angular-eslint/template/eqeqeq': 'error',
    },
  },
]);
