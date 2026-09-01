/**
 * Which commit this bundle was built from.
 *
 * Exists because "is the fix deployed here?" had no answer from inside the
 * app, and the absence cost a diagnosis: after `#153` fixed the CSP that
 * refused Google sign-in on dev, every preview channel picked it up and
 * `trivimind-dev.web.app` did not (nothing deployed it — `ci-cd.md` §4.2).
 * From the browser the two were indistinguishable, so the investigation
 * started at the client and stayed there through a storage clear, a service
 * worker unregister and several cache-disabled reloads. A commit hash on the
 * page answers it in one hover.
 *
 * **Injected at build time by `--define`, not read from a generated file.**
 * `ng build --define` substitutes the identifier in the emitted JavaScript, so
 * there is nothing on disk to generate, gitignore, keep in step, or
 * accidentally commit with a real hash in it — and a fresh clone type-checks
 * with no build step having run.
 *
 * **Deliberately no build timestamp.** A clock in the bundle makes every
 * rebuild of the same commit produce different bytes, which means a different
 * content hash, a different `ngsw.json`, and a service-worker update pushed to
 * every client for a deploy that changed nothing. The commit *date* below
 * answers the same "how stale is this?" question and is a property of the
 * commit rather than of the moment someone typed `npm run build`.
 */

/**
 * Substituted by `--define` in `build:prod` and `build:dev-project`. Declared
 * rather than imported because that is what esbuild replaces: a global
 * identifier, not a module export.
 *
 * They are genuinely absent in a build that does not pass `--define` —
 * `ng serve`, `ng test`, `ng build` — so every read goes through `defined()`
 * below. This is not a shim for a test runner's gap (the thing
 * `src/test-setup.ts` exists to avoid); a locally served build really has no
 * commit to report, and saying so is the honest answer.
 */
declare const NG_BUILD_COMMIT: string | undefined;
declare const NG_BUILD_COMMIT_DATE: string | undefined;

/**
 * Reads a `--define` global without throwing when it was never defined.
 *
 * `typeof` on an undeclared identifier is the one operation that does not
 * raise a `ReferenceError`, which is why the guard is shaped this way rather
 * than as a truthiness check.
 */
function defined(read: () => string | undefined): string | null {
  try {
    const value = read();
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Short commit hash, or `null` in a build that carried none. */
export const BUILD_COMMIT = defined(() =>
  typeof NG_BUILD_COMMIT === 'undefined' ? undefined : NG_BUILD_COMMIT,
);

/** Commit date as `YYYY-MM-DD`, or `null`. */
export const BUILD_COMMIT_DATE = defined(() =>
  typeof NG_BUILD_COMMIT_DATE === 'undefined' ? undefined : NG_BUILD_COMMIT_DATE,
);

/**
 * One line naming this build, for the footer's tooltip.
 *
 * Includes the environment label when there is one, so the string answers both
 * halves of the question somebody actually has — *which* deployment am I
 * looking at, and *what* is on it — rather than only the second.
 */
export function buildLabel(environmentLabel: string): string {
  const parts: string[] = [];
  if (environmentLabel) {
    parts.push(environmentLabel);
  }
  if (BUILD_COMMIT) {
    parts.push(BUILD_COMMIT_DATE ? `${BUILD_COMMIT} · ${BUILD_COMMIT_DATE}` : BUILD_COMMIT);
  } else {
    // Not "unknown": a build with no commit stamped is a local one, and naming
    // that is more useful than admitting ignorance about it.
    parts.push('local build');
  }
  return parts.join(' · ');
}
