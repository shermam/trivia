import { expect, test } from '../../fixtures/test';

/**
 * What the service worker's install actually put in the cache.
 *
 * `ngsw-config.json` splits the emitted chunks into a `deferred-routes` group
 * that installs lazily and an `app` group that is prefetched (`FEAT-017`), so
 * that a first visit does not fetch seven routes nobody has opened.
 * `scripts/verify-ngsw-groups.mjs` proves the split is *right* against the
 * built manifest and the bundle graph — every chunk `/`, `/play` and
 * `/game-over` statically need is in the prefetch group, and no route chunk is
 * unclassified. What it cannot see is whether a real browser, given that
 * manifest, ends up holding those files. That is this spec.
 *
 * **It runs only against a deployed channel**, for the same reason
 * `service-worker-oauth-origins.spec.ts` does: `ng serve --configuration=e2e`
 * sets no `serviceWorker` in `angular.json`, so there is no `ngsw-worker.js`
 * and no `ngsw.json` to install from. `playwright.config.ts` excludes it by
 * name; `playwright.preview.config.ts` does not.
 *
 * **Why this asks Cache Storage rather than cutting the network and playing.**
 * `context.setOffline(true)` is emulated on the *page's* network context, and
 * a service worker has its own — Playwright leaves it connected. So a round
 * played "offline" against a precache with `/play` wrongly left in the lazy
 * group passes anyway: the worker fetches the missing chunk over the network
 * the test believes it cut, and nothing the round can see is any different.
 * Measured both ways round. Against a build with `quiz-loop` and `game-over`
 * deliberately demoted the round still passed, with the origin's own log
 * showing it serving both chunks mid-test; and on a runner with real egress
 * even the app's `opentdb.com` request came back, so the offline question pool
 * was never reached and the offline banner never appeared. The cache
 * assertions below fail in the first case and do not depend on the second.
 * Playing a round with no network is covered where it can be made to mean
 * something — `offline-play.spec.ts`, on the emulator, with no worker to
 * re-issue anything.
 */
test.describe('Service worker precache scope', () => {
  /** Named chunks (`namedChunks` in `angular.json`) are what makes these addressable. */
  const GAME_CHUNKS = ['game-setup.component-', 'quiz-loop.component-', 'game-over.component-'];
  const DEFERRED_CHUNKS = ['pricing.component-', 'profile-stats.component-'];

  test('installs every chunk the offline game needs, and no route nobody has opened', async ({
    page,
  }) => {
    await page.goto('/');

    // `app.config.ts` gates registration on `!navigator.webdriver`, true under
    // any automation framework, so the worker has to be asked for by name.
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/ngsw-worker.js');
      await navigator.serviceWorker.ready;
    });

    // A reload is what guarantees the document is controlled from its first
    // byte — the state a returning visitor is in — rather than partway through.
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''), {
        message: 'the page is controlled by a service worker',
      })
      .toContain('ngsw-worker.js');

    /*
     * The install is asynchronous and everything below is about what it put in
     * the cache, so waiting for it is not optional. ngsw's own debug endpoint
     * reports the driver's state, and `NORMAL` means the latest version is
     * fully installed — polling that is the only signal that does not amount
     * to guessing at a duration. It doubles as the positive control:
     * `/ngsw/state` is answered by the worker and by nothing else, so a
     * response at all proves the interception this spec depends on is live.
     */
    await expect
      .poll(
        () =>
          page.evaluate(() => fetch('/ngsw/state', { cache: 'no-store' }).then((r) => r.text())),
        { message: 'the worker has finished installing the current version' },
      )
      .toContain('Driver state: NORMAL');

    /*
     * What the worker was *told* to cache, read from the manifest it installed
     * from rather than from a list restated here — hard-coded hashed filenames
     * would be wrong on the next build, and a list derived from
     * `ngsw-config.json` would only prove the config agrees with itself.
     */
    const manifest = await page.evaluate(
      () => fetch('/ngsw.json', { cache: 'no-store' }).then((r) => r.json()) as Promise<Manifest>,
    );
    const urlsFor = (prefixes: readonly string[]): string[] =>
      manifest.assetGroups
        .flatMap((group) => group.urls)
        .filter((url) => prefixes.some((prefix) => url.startsWith(`/${prefix}`)));

    const gameUrls = urlsFor(GAME_CHUNKS);
    expect(gameUrls, 'the manifest names one chunk per game route').toHaveLength(
      GAME_CHUNKS.length,
    );

    /*
     * `caches.match` searches every cache in the origin, so this asks the only
     * question that matters — is the chunk there — without depending on how
     * ngsw names its caches. Polled as a group rather than read one at a time,
     * because the install's last writes can land a beat after `NORMAL`
     * (`CLAUDE.md` §4.6).
     */
    const cachedStates = (urls: readonly string[]): Promise<Record<string, boolean>> =>
      page.evaluate(
        async (targets) =>
          Object.fromEntries(
            await Promise.all(
              targets.map(async (url) => [url, Boolean(await caches.match(url))] as const),
            ),
          ),
        urls,
      );

    await expect
      .poll(() => cachedStates(gameUrls), {
        message: 'every chunk the offline game needs was installed into Cache Storage',
      })
      .toEqual(Object.fromEntries(gameUrls.map((url) => [url, true])));

    // The other half of the split: a route nobody has visited is not in the
    // cache at all, which is what `installMode: "lazy"` buys and what every
    // first visit pays for when it is missing.
    const deferredUrls = urlsFor(DEFERRED_CHUNKS);
    expect(deferredUrls, 'the manifest names the deferred route chunks').toHaveLength(
      DEFERRED_CHUNKS.length,
    );
    expect(await cachedStates(deferredUrls)).toEqual(
      Object.fromEntries(deferredUrls.map((url) => [url, false])),
    );

    // And the shell itself, which is what makes a repeat visit work at all.
    await expect(page.getByRole('button', { name: 'Start Game', exact: true })).toBeVisible();
  });
});

/** Just the part of `ngsw.json` this spec reads. */
interface Manifest {
  readonly assetGroups: readonly { readonly name: string; readonly urls: readonly string[] }[];
}
