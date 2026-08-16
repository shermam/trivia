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
 *
 * ## Three TypeScript blocks, not one
 *
 * There is a block per source tree — `src/`, `functions/src/`, `cypress/` —
 * because each is a different program with different globals and a different
 * set of rules that make sense in it. They share the type-aware base; what
 * differs is written down at each block with the reason.
 *
 * The blocks are scoped narrowly on purpose. The first one used to match
 * every TypeScript file in the repo, which was harmless only because
 * `angular.json`'s `lintFilePatterns` never sent it anything outside `src/`.
 * Widening those patterns without narrowing this glob would have quietly
 * applied the Angular config — and `processor: angular.processInlineTemplates`
 * — to Cloud Functions and Cypress specs, which have no components in them at
 * all. Flat config merges *every* matching block rather than picking the most
 * specific one, so a narrow block cannot override a broad one; the broad one
 * has to stop matching.
 *
 * **`eslint.config.js` and `angular.json` have to be changed together.** The
 * config decides what the rules are; `lintFilePatterns` decides which files
 * are handed to it. Editing one alone accomplishes nothing, which is the trap
 * that left two of these three trees unlinted for as long as they were.
 */

/**
 * Shared by every TypeScript block. Type-aware linting costs a little run
 * time and buys `no-floating-promises` / `no-misused-promises`, which are the
 * only mechanical defence this codebase has against a forgotten `await` on a
 * Firestore, Auth or Stripe call.
 *
 * `projectService: true` resolves each file against the nearest ancestor
 * `tsconfig.json` — `tsconfig.app.json` via the root solution file for `src/`,
 * `functions/tsconfig.json` for the functions, `cypress/tsconfig.json` for the
 * specs. No explicit `project` array is needed, and adding one would be a
 * third place to keep in sync.
 */
const typeAwareLanguageOptions = {
  parserOptions: {
    projectService: true,
    tsconfigRootDir: __dirname,
  },
};

/** `const { cachedAt: _cachedAt, ...rest }` is the idiomatic way to drop a field. */
const unusedVarsWithUnderscoreOptOut = /** @type {const} */ ([
  'error',
  { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
]);

module.exports = defineConfig([
  {
    files: ['src/**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    languageOptions: typeAwareLanguageOptions,
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
      // these need type information, hence the shared parser options above.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      '@typescript-eslint/no-unused-vars': unusedVarsWithUnderscoreOptOut,
    },
  },
  {
    files: ['src/**/*.html'],
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
  {
    /**
     * The Cloud Functions package. This is the code that actually runs in the
     * Cloud Functions runtime and makes every billing and claim decision in
     * the product, and it went unlinted for longer than the app did.
     *
     * No `angular.*` here: there is not a component in the package, and the
     * inline-template processor would run over all thirty files for nothing.
     */
    files: ['functions/src/**/*.ts'],
    extends: [eslint.configs.recommended, tseslint.configs.recommended, tseslint.configs.stylistic],
    languageOptions: typeAwareLanguageOptions,
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          /**
           * `node:test`'s `test`/`it`/`describe` return a promise that the
           * runner itself awaits — calling one is not a forgotten `await`.
           * Without this the functions test suite alone reports 118 floating
           * promises, which is not 118 defects; it is one wrong assumption
           * about a framework, repeated.
           *
           * Scoped by package name, so it exempts exactly these three
           * imported from exactly `node:test` and nothing else. Prefixing 118
           * call sites with `void` would have been the same claim written
           * illegibly, and would have had to be repeated in every test file
           * added afterwards.
           */
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'it', 'test'] },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',

      // Kept for symmetry with `src/`, though `functions/tsconfig.json`
      // already sets `noUnusedLocals`/`noUnusedParameters`, so `tsc` has been
      // enforcing this all along and the rule finds nothing today.
      '@typescript-eslint/no-unused-vars': unusedVarsWithUnderscoreOptOut,
    },
  },
  {
    /**
     * The Cypress suite. Two rules differ from `src/`, both because chai and
     * Cypress's own types are shaped differently from Vitest and Angular —
     * not because the suite deserves a lower standard.
     */
    files: ['cypress/**/*.ts'],
    extends: [eslint.configs.recommended, tseslint.configs.recommended, tseslint.configs.stylistic],
    languageOptions: typeAwareLanguageOptions,
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': unusedVarsWithUnderscoreOptOut,

      /**
       * `declare global { namespace Cypress { interface Chainable } }` is the
       * only way to declare a custom Cypress command's type; ES2015 module
       * syntax cannot express it. `allowDeclarations` permits exactly that
       * shape and still rejects a plain, non-declared namespace, which is
       * what the rule is actually for.
       */
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],

      /**
       * Chai's BDD assertions (`expect(x).to.be.false`) are property accesses,
       * not calls, so they are indistinguishable from a genuinely dead
       * expression by any option this rule has. `src/` never trips it because
       * Vitest's `expect(x).toBe(y)` is a call.
       */
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    /**
     * The two Cypress config files sit at the repo root, so the project
     * service resolves them against the root `tsconfig.json` — which is a
     * solution file with `files: []` and would reject them outright.
     * `cypress/tsconfig.json` does list them in `include`, but a tsconfig in
     * a subdirectory is never consulted for a file above it.
     *
     * Pointing `defaultProject` at it gives these two the same `strict: true`
     * and `types: ['cypress', 'node']` as the rest of the suite, rather than
     * inferred defaults.
     */
    files: ['cypress.config.ts', 'cypress.preview.config.ts'],
    extends: [eslint.configs.recommended, tseslint.configs.recommended, tseslint.configs.stylistic],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['cypress.config.ts', 'cypress.preview.config.ts'],
          defaultProject: 'cypress/tsconfig.json',
        },
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': unusedVarsWithUnderscoreOptOut,
    },
  },
]);
