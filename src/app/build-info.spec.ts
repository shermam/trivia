import { BUILD_COMMIT, BUILD_COMMIT_DATE, buildLabel } from './build-info';

/**
 * The interesting half of this module is what it does when the `--define`
 * values are **absent**, because that is every build except the two that
 * deploy: `ng serve`, `ng test` and plain `ng build` all leave the identifiers
 * undeclared. Reading an undeclared identifier throws a `ReferenceError`, so
 * "the version is missing" would otherwise be a crash in the footer of every
 * locally served page rather than a fallback string.
 *
 * These specs run under exactly that condition — no `--define` — so the
 * `null` cases are real rather than simulated, and `buildLabel` is a pure
 * function of its inputs so the stamped cases can be driven directly.
 */
describe('build-info', () => {
  it('reports no commit in a build that carried none', () => {
    // Not simulated: `ng test` passes no `--define`, so this is the genuine
    // undeclared-identifier path, and it must not throw.
    expect(BUILD_COMMIT).toBeNull();
    expect(BUILD_COMMIT_DATE).toBeNull();
  });

  it('names an unstamped build rather than admitting ignorance', () => {
    expect(buildLabel('')).toBe('local build');
  });

  it('keeps the environment label alongside it', () => {
    expect(buildLabel('DEV')).toBe('DEV · local build');
  });
});

/**
 * The second `describe` here originally asserted that `buildLabel('')`
 * "omits the separator", checking `not.toContain('·')`. It passed — and would
 * have gone on passing — for a reason that has nothing to do with the claim:
 * the middot also separates the commit from its date, so the assertion only
 * held because these specs run unstamped, and a stamped build makes it false
 * while the test name stays plausible. Exactly the shape `CLAUDE.md` §4.6 is
 * about, caught by asking what the string looks like in production rather than
 * in the runner.
 *
 * What is worth pinning is the *order*: the environment label comes first, so
 * the answer to "which deployment am I looking at?" is the first thing read.
 */
describe('buildLabel ordering', () => {
  it('leads with the environment label when there is one', () => {
    expect(buildLabel('DEV').startsWith('DEV')).toBe(true);
  });

  it('leads with the build itself when there is no label, as in production', () => {
    expect(buildLabel('').startsWith('DEV')).toBe(false);
    expect(buildLabel('')).toBe('local build');
  });

  it('treats an empty label as absent rather than rendering a dangling separator', () => {
    expect(buildLabel('').startsWith(' ')).toBe(false);
    expect(buildLabel('').endsWith('·')).toBe(false);
  });
});
