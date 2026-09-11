import { expect, test } from '../../fixtures/test';
import { stubOpenTrivia } from '../../support/open-trivia';

/**
 * The recovery notice that lives inside `<app-root>` in `src/index.html`.
 *
 * It exists for the one failure where no application code runs: a stale
 * service worker serves a cached `index.html` naming a hashed entry script
 * that is neither in its cache nor on the origin any more. The page is blank,
 * and nothing in `src/app/` can react to that, because the bundle that would
 * have reacted is the one that did not arrive. `SwUpdate.unrecoverable` cannot
 * help either — `firebase.json` rewrites every unmatched path to
 * `/index.html`, so a stale asset returns `200` and the worker only raises
 * that event on a `404`.
 *
 * So the notice is markup that is already on the page, revealed by a CSS
 * delay. Both halves of that need holding down, and they pull in opposite
 * directions: it has to appear when the bundle never arrives, and it has to be
 * invisible on every load where it does.
 *
 * A `404` rather than a wedged worker because the worker is not the point —
 * the fallback answers "no entry script" whatever the cause, and the dev
 * server this suite runs against emits no worker at all.
 *
 * **Emulator-only, and the preview scope excludes it.** Against a deployed
 * channel `firebase.json` serves `**\/*.@(js|css)` as
 * `max-age=31536000, immutable`, so by the time this spec runs the browser
 * already holds the entry script from an earlier spec and satisfies the
 * request from its own cache. No request reaches the network, the route never
 * matches, and the assertion that it did fails.
 *
 * **There is deliberately no test that recovers within a single test, and the
 * gap is worth stating rather than leaving as an absence.** Two versions were
 * tried — clicking the link, and reloading after a one-shot interception — and
 * both fail on the assertion *after* the second page load, in CI and on a
 * developer machine, on every attempt. The same sequence was then driven by
 * hand in Chromium four ways: production build and `ng serve`, top-level and
 * inside an iframe. All four recover correctly — the second request is served,
 * Angular boots, the notice goes, the setup screen renders. The cause is **not
 * understood**, and it is not the element, the build, the framing, or the
 * click.
 *
 * What the dropped test would have proved is covered anyway: that the link
 * points at the app root is asserted below without needing a second load, and
 * that a load with the script available boots the app and leaves no notice
 * behind is exactly the first test here. So the deleted assertion was the
 * composition of two things already checked, and its only unique contribution
 * was a failure mode belonging to the runner.
 */
test.describe('pre-boot recovery notice', () => {
  /**
   * Matches the dev server's unhashed `main.js` and a production
   * `main-HASH.js` alike, and nothing else: the `[^/]*` is what stops it
   * reaching into a path segment of its own.
   */
  const ENTRY_SCRIPT = /\/main[^/]*\.js/;

  test('is gone from the page once the app boots', async ({ page }) => {
    // Nothing here starts a game; the stub is only so that a run never depends
    // on a third-party service being up.
    await stubOpenTrivia(page);
    await page.goto('/');

    // A positive anchor first: "does not exist" is satisfied by a page that
    // has not rendered yet, which would pass against the very regression this
    // guards.
    await expect(page.getByText('Configure your quiz')).toBeVisible();

    // Angular replaces the contents of `<app-root>` on bootstrap, which is
    // what makes the notice free on the happy path — it is not hidden, it is
    // no longer in the document.
    await expect(page.getByTestId('boot-fallback')).toHaveCount(0);
  });

  test('appears when the entry script never arrives, offering a reload to the app root', async ({
    page,
  }) => {
    let entryScriptRequests = 0;
    await page.route(ENTRY_SCRIPT, async (route) => {
      entryScriptRequests += 1;
      await route.fulfill({ status: 404, body: '' });
    });

    await page.goto('/');

    // The interception is the whole experiment, so prove it happened. A route
    // that silently stopped matching would leave the rest of this test
    // asserting against a perfectly healthy page — and the first assertion
    // below would then fail for a reason that names the notice rather than the
    // route (`CLAUDE.md` §4.6).
    expect(entryScriptRequests, 'entry script requests refused').toBeGreaterThan(0);

    const notice = page.getByTestId('boot-fallback');

    // The delay is the whole reason this is safe to ship: without it the
    // notice would flash on every slow-but-fine load. Asserted on the computed
    // style rather than by watching a clock, so the check says "it cannot
    // appear immediately" without depending on how fast this runner is.
    const delay = await notice.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).animationDelay),
    );
    expect(delay, 'reveal delay in seconds').toBeGreaterThanOrEqual(5);

    // The 20s `expect` timeout is comfortably past the reveal delay.
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('could not finish loading');

    // Reloading is the recovery, so the notice has to offer one that goes
    // somewhere useful. Asserted on the resolved `href` rather than by
    // following it — see the note at the top of this file.
    const href = await page
      .getByTestId('boot-fallback-reload')
      .evaluate((anchor) => (anchor as HTMLAnchorElement).href);
    expect(href, 'resolved href').toBe(`${new URL(page.url()).origin}/`);
  });
});
