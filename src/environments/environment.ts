/**
 * Production. The default; every other environment file is a substitution of
 * this one via `fileReplacements` in `angular.json`.
 */
export const environment = {
  production: true,
  useEmulators: false,
  /** Unused while `useEmulators` is false; present so the shape is uniform. */
  emulatorProjectId: '',
  /**
   * Renders a badge in the top bar naming the environment. Empty in
   * production, and that is the only place it is empty.
   *
   * **The badge exists because the dev project is a faithful copy.** Its
   * whole value is that a production build deployed to `trivimind-dev`
   * behaves identically to one deployed to production — `environment.production`
   * is read nowhere in `src/`, only Angular's own `isDevMode()`, which the
   * optimiser drives. Identical is the point, and identical is also the
   * hazard: nothing on screen would tell you which backend you are looking
   * at. One boolean's worth of divergence buys that back.
   */
  environmentLabel: '',
  enableOfflinePrefetch: true,
};
