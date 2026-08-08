import { defineConfig } from 'vitest/config';

/**
 * Standalone Vitest config for the `firestore.rules` suite.
 *
 * Separate from `ng test` on purpose: the Angular CLI's unit-test builder
 * compiles the whole application and runs in jsdom, neither of which these
 * tests want — they're plain Node talking to the Firestore emulator over the
 * wire, and the rules file is the only thing under test. Keeping them out of
 * `src/` also means the app's build and lint globs never pick them up.
 *
 * Every spec file uses its own `projectId` (see helpers.ts), so files are
 * isolated from each other's `clearFirestore()` and can run in parallel.
 */
export default defineConfig({
  test: {
    name: 'firestore-rules',
    environment: 'node',
    include: ['firestore-tests/**/*.spec.ts'],
    // The emulator round-trip is slower than a pure unit test, and CI runners
    // are slower still; the default 5s trips on cold starts.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
