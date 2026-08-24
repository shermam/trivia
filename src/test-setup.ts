/**
 * Environment shims for the unit suite, wired in as `setupFiles` on the
 * `@angular/build:unit-test` target in `angular.json`.
 *
 * Everything here exists because **jsdom is not a browser**, and the right
 * place to say so is the test environment rather than the application. A
 * `typeof window.matchMedia === 'function'` guard in a component would be
 * production code shaped around a test runner's gaps, and it would go
 * permanently untested in the branch that matters.
 */

/**
 * `window.matchMedia` is unimplemented in jsdom, and calling it throws.
 *
 * `TopBarComponent` uses it to close the mobile navigation drawer when the
 * viewport grows past Tailwind's `sm` breakpoint — without it, widening a
 * window unmounts the panel via `sm:hidden` while focus is still inside it.
 * It is supported in every browser this app runs in (and has been since IE10),
 * so the gap is jsdom's alone.
 *
 * The stub is deliberately inert: `matches: false` and listeners that are
 * accepted and never called. A spec that wants to *drive* a breakpoint change
 * replaces this with its own, which is honest about the fact that nothing here
 * simulates a resize on its own.
 */
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
