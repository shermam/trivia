import { answerOption } from '../../support/game';
import { seedOfflineQuestions } from '../../support/offline-storage';
import { expect, test } from '../../fixtures/test';

/**
 * The guarantee the service worker's precache exists for: a player who has
 * loaded the app once can start and finish a game with no network at all.
 *
 * `ngsw-config.json` splits the emitted chunks into a `deferred-routes` group
 * that installs lazily and an `app` group that is prefetched at install
 * (`FEAT-017`). `scripts/verify-ngsw-groups.mjs` proves that split is right
 * against the built manifest and the bundle graph — every chunk `/`, `/play`
 * and `/game-over` statically need is in the prefetch group. This proves the
 * mechanism underneath it: that the worker really does install those chunks
 * into Cache Storage, and that a full round plays through `/` → `/play` →
 * `/game-over` with the page's own network gone.
 *
 * **It runs only against a deployed channel**, for the same reason
 * `service-worker-oauth-origins.spec.ts` does: `ng serve --configuration=e2e`
 * sets no `serviceWorker` in `angular.json`, so there is no `ngsw-worker.js`
 * and no `ngsw.json` for a worker to install from. `playwright.config.ts`
 * excludes it by name; `playwright.preview.config.ts` does not.
 *
 * **Why the round is not the assertion, and the cache check is.**
 * `context.setOffline(true)` does not reach requests a *service worker* makes:
 * it is emulated on the page's network context, and the worker has its own. So
 * a round played "offline" against a precache with `/play` wrongly left in the
 * lazy group still passes — the worker fetches the missing chunk over the
 * network the test believes it has cut, and nothing in the round can tell the
 * difference. Measured, against a build with `quiz-loop` and `game-over`
 * deliberately demoted: the round passed, and the origin's own log showed it
 * serving both chunks mid-test. The Cache Storage assertions below are what
 * fails in that state, and they are why this spec is not decorative. The round
 * stays because the two together are the promise, and because it covers
 * everything about playing offline that is not the precache.
 *
 * The questions are seeded into IndexedDB rather than prefetched from Open
 * Trivia DB — see `seedOfflineQuestions`. What is under test is which chunks
 * survive going offline, and a round that depended on a third-party API having
 * answered in time would fail for a reason that has nothing to do with that.
 */
test.describe('Offline play from the installed service worker', () => {
  /** The default the setup screen offers, so nothing has to be selected. */
  const QUESTION_COUNT = 5;

  /** Named chunks (`namedChunks` in `angular.json`) are what makes these addressable. */
  const GAME_CHUNKS = ['game-setup.component-', 'quiz-loop.component-', 'game-over.component-'];
  const DEFERRED_CHUNKS = ['pricing.component-', 'profile-stats.component-'];

  test('installs the game routes and plays a full round with the network gone', async ({
    page,
    context,
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

    await seedOfflineQuestions(page, QUESTION_COUNT);
    await context.setOffline(true);

    // The reload proves the shell is cached: with no worker this is a browser
    // error page rather than an app.
    await page.reload();
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();

    await expect(page).toHaveURL(/\/play$/);
    await expect(page.getByTestId('question-text')).toBeVisible();
    // The quiz loop's offline notice, which `TriviaService.getQuestions` only
    // raises when the network fetch failed and the pool answered instead —
    // proof the round really is coming from storage rather than from a request
    // that quietly succeeded.
    await expect(
      page.getByText("You're offline — these questions are from your saved offline pool."),
    ).toBeVisible();

    for (let i = 0; i < QUESTION_COUNT; i++) {
      // Every seeded question labels its correct option `Right`, so the round
      // is answerable without knowing the order the pool shuffled into. The
      // click waits out the result pause on its own: the previous question's
      // button is disabled while the banner shows, and Playwright re-resolves
      // the locator until an enabled one is there.
      await answerOption(page, 'Right').click();
    }

    await expect(page).toHaveURL(/\/game-over$/);
    // The count rather than the score: a streak multiplier makes the points a
    // function of `FEAT-004`'s ceiling, which this spec has no business
    // asserting. Whitespace-tolerant because the `<span>` holding the total
    // sits on its own line, and `toHaveText` does not normalize a pattern
    // (`CLAUDE.md` §4.6).
    await expect(page.getByTestId('correct-answers')).toHaveText(
      new RegExp(`^\\s*${QUESTION_COUNT}\\s*/\\s*${QUESTION_COUNT}\\s*$`),
    );
  });
});

/** Just the part of `ngsw.json` this spec reads. */
interface Manifest {
  readonly assetGroups: readonly { readonly name: string; readonly urls: readonly string[] }[];
}
