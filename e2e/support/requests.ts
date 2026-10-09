import { Page, Request, Route } from '@playwright/test';

/**
 * Holding a request open, so a transient state can be measured rather than
 * raced.
 *
 * A plain support module rather than something exported from a spec: a spec
 * file's `test` calls run on import, so a helper living in one would silently
 * re-register its own tests inside every spec that imported it.
 */

/**
 * Holds every request `matches` accepts until `release()` — a gate the test
 * opens, not a timer — so a transient state can be measured for exactly as
 * long as the measurement takes.
 *
 * `seen` resolves on the first held request, which is what proves the gate was
 * load-bearing: a gate that silently stopped matching would let the state it
 * exists to hold flash past, and the test would measure whatever came next.
 */
export async function holdRequests(
  page: Page,
  matches: (request: Request) => boolean,
): Promise<{ seen: Promise<void>; release: () => void }> {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let sawOne!: () => void;
  const seen = new Promise<void>((resolve) => {
    sawOne = resolve;
  });

  await page.route('**/*', async (route: Route) => {
    if (!matches(route.request())) {
      await route.fallback();
      return;
    }
    sawOne();
    await opened;
    await route.fallback();
  });

  return { seen, release: () => open() };
}

/**
 * The lazy chunk behind `/play` — `QuizLoopComponent`'s, named by
 * `namedChunks: true` in `angular.json` the way `ngsw-config.json` and
 * `scripts/verify-ngsw-groups.mjs` name it, on the dev server and in a
 * production build alike.
 *
 * It is what a Start press waits on after the game is committed: `startGame`
 * calls `beginGame` and only then navigates, so holding this request holds the
 * setup screen on screen with the new game already in memory — the window in
 * which a live read of that game shows up on a screen still being looked at.
 * Nothing re-fetches it once a document has loaded it, so a test that has
 * already been to `/play` needs a fresh page load before the gate can catch it.
 */
export function isPlayChunk(request: Request): boolean {
  return /\/quiz-loop\.component[-.][^/]*\.js(\?|$)/.test(request.url());
}
