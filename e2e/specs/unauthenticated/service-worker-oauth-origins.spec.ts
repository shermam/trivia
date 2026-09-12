import { createHash } from 'node:crypto';
import { APIRequestContext } from '@playwright/test';
import { findCspProblems, findDeploymentOriginProblems } from '../../../scripts/csp-rules.mjs';
import { expect, test } from '../../fixtures/test';

/**
 * Regression cover for PR #112 — the Google sign-in failure that nothing in
 * the pipeline could see.
 *
 * `ngsw-worker.js` calls `event.respondWith` for **every** fetch the page
 * makes, cross-origin included, and re-issues anything it does not cache as a
 * `fetch()` from inside the worker (`Driver.handleFetch` → `safeFetch`). A
 * service worker's `fetch()` is governed by the CSP delivered with the *worker
 * script*, and inside a worker every request is a connection — so `connect-src`
 * applies, not the `script-src`/`frame-src` the page itself would have used.
 * `connect-src` listed neither `apis.google.com` nor the Firebase `authDomain`,
 * both of which `browserPopupRedirectResolver` loads, so both were refused
 * inside the worker and `safeFetch` turned each refusal into a synthetic
 * `504 Gateway Timeout`. The popup resolver could not initialise and sign-in
 * failed with a code the client could not explain.
 *
 * `npm run csp:verify` (`scripts/verify-csp.mjs`, run by lint.yml) pins the
 * invariant **in `firebase.json`**, using the rule in `scripts/csp-rules.mjs`.
 * This spec imports that same function — deliberately not its own copy of the
 * rule — and applies it to what a deployed channel actually serves, covering
 * the two things reading a file on disk cannot:
 *
 *  1. that the policy `firebase.json` describes is the policy actually *served*
 *     — a headers rule that stopped matching `**`, a deploy that didn't take,
 *     or a CDN rewriting the header are all invisible to a static check; and
 *  2. that the worker really does re-fetch cross-origin subresources, which is
 *     the whole reason (1) is load-bearing rather than belt-and-braces.
 *
 * **This spec runs only against a deployed channel.** It cannot run against the
 * emulator config at all: `ng serve --configuration=e2e` sets no `serviceWorker`
 * in `angular.json`, so there is no `ngsw-worker.js` to register, and a dev
 * server sends none of `firebase.json`'s headers. `playwright.config.ts`
 * excludes it by name for that reason, and `playwright.preview.config.ts`
 * replaces that exclusion list with one that does not.
 *
 * **On what this can and cannot catch.** Two of the three questions here are
 * asked through `request` — Playwright's Node-side HTTP client — rather than
 * from the page, because they are about a *response header*, and reading a
 * header is not something a page can do for itself. The in-browser test is the
 * other half: it proves the worker really intercepts and re-fetches, which is
 * what makes the header matter. The page is served its real headers here, so
 * the policy is genuinely enforced against the in-browser probes below rather
 * than being stripped on the way in — worth knowing, because a runner that
 * strips it leaves that half asserting nothing at all.
 */

/**
 * What a `mode: 'no-cors'` fetch came back as. `ngsw`'s synthetic 504 is a
 * *constructed* `Response`, so its `status` is readable; a genuine cross-origin
 * success is opaque, which reports `type: 'opaque'` and `status: 0`. That
 * asymmetry is the whole assertion — the two cases are distinguishable from the
 * page without ever reading a body.
 */
interface ProbeResult {
  readonly type: string;
  readonly status: number;
  readonly error: string | null;
}

/**
 * Which project is actually being served, from the deployment's own runtime
 * config rather than from a list.
 *
 * `findCspProblems` compares the policy against itself and against a fixed list
 * of hosts, and both are blind to project *identity* — `frame-src` naming *a*
 * `firebaseapp.com` origin satisfies them whichever project it belongs to.
 * Reading it from `/__/firebase/init.json` is what cannot be wrong about which
 * project this channel belongs to.
 */
async function deploymentIdentity(
  request: APIRequestContext,
): Promise<{ projectId: string; authDomain: string }> {
  const response = await request.get('/__/firebase/init.json');
  expect(response.status(), '/__/firebase/init.json').toBe(200);
  const config = (await response.json()) as { authDomain?: string; projectId?: string };
  expect(config.authDomain, 'authDomain from runtime config').toBeTruthy();
  expect(config.projectId, 'projectId from runtime config').toBeTruthy();
  return { projectId: config.projectId!, authDomain: config.authDomain! };
}

/** The `Content-Security-Policy` served with a path, asserted to exist. */
async function servedCsp(request: APIRequestContext, path: string): Promise<string> {
  const response = await request.get(path);
  const csp = response.headers()['content-security-policy'];
  expect(csp, `Content-Security-Policy served with ${path}`).toBeTruthy();
  return csp;
}

test.describe('service worker: OAuth origins stay reachable (PR #112)', () => {
  test('serves a CSP that satisfies the same rule csp:verify enforces on disk', async ({
    request,
  }) => {
    // The rule is imported, not restated. `scripts/verify-csp.mjs` applies
    // `findCspProblems` to the policy written in `firebase.json`; this applies
    // the identical function to the policy a deployed channel actually serves.
    // Those are different questions — a headers rule that stops matching `**`,
    // a deploy that didn't take, or a CDN rewriting the header are all
    // invisible on disk — but they are the same *rule*, and it only stays the
    // same rule if there is one copy of it. There were two for the span of one
    // PR and they had already drifted (see `scripts/csp-rules.mjs`).
    //
    // The worker script's own headers are what govern its `fetch()`, so that is
    // the response that matters most — but the app shell is checked too, since
    // `firebase.json` applies one `**` rule to both and a regression splitting
    // them apart is exactly the kind worth catching.
    for (const path of ['/', '/ngsw-worker.js']) {
      const problems = findCspProblems(await servedCsp(request, path)).map(
        ({ origin, detail, why }) => `${origin} — ${detail}. ${why}`,
      );
      expect(problems, `the CSP served with ${path} fails csp:verify's own rule`).toEqual([]);
    }
  });

  /**
   * The check the other one cannot make: that the policy works for **this**
   * deployment.
   *
   * The CSP named the production project only, and Google sign-in was refused
   * on `trivimind-dev` and on every preview channel while this suite, running
   * against that very deployment, stayed green. The failure was in the *page's*
   * console (`Framing 'https://trivimind-dev.firebaseapp.com/' violates ...
   * frame-src`), and nothing here was looking at the page.
   *
   * `verify-csp.mjs` runs the same function over `DEPLOY_TARGETS` on disk,
   * which is the half that catches a *new* project before it is ever deployed;
   * this is the half that cannot be wrong about which project is actually being
   * served.
   */
  test('serves a CSP that names this deployment’s own project, not just some project', async ({
    request,
  }) => {
    const { projectId, authDomain } = await deploymentIdentity(request);
    const csp = await servedCsp(request, '/');

    const problems = findDeploymentOriginProblems(csp, { projectId, authDomain }).map(
      ({ origin, detail, why }) => `${origin} — ${detail}. ${why}`,
    );
    expect(
      problems,
      `the CSP served by ${projectId} does not cover ${projectId}'s own origins`,
    ).toEqual([]);
  });

  test('serves a worker whose bytes carry a fingerprint of the CSP served with it', async ({
    request,
  }) => {
    // A service worker's CSP is fixed when its *script is installed*, not when
    // it runs, and `ngsw-worker.js` is a static file — byte-identical across
    // every deploy that does not bump `@angular/service-worker`. The update
    // algorithm compares bytes, finds none changed, and installs nothing, so a
    // header-only change never reaches an already-installed worker. That is why
    // #112 fixed Google sign-in for new visitors and left everyone whose worker
    // predated the deploy refusing `apis.google.com` under the old policy,
    // quoting a `connect-src` that no longer existed on the server.
    //
    // `scripts/stamp-service-worker.mjs` (wired into `build:prod`) appends a
    // fingerprint of the CSP so the bytes move when the policy moves. This
    // asserts the deployed artifact actually carries it — remove the build step
    // and the stamp silently stops applying, which is exactly how the original
    // bug behaved.
    const response = await request.get('/ngsw-worker.js');
    const csp = response.headers()['content-security-policy'];
    expect(csp, 'Content-Security-Policy served with /ngsw-worker.js').toBeTruthy();

    const stamped = /\/\/ service-worker-policy-fingerprint: ([0-9a-f]{16})\s*$/.exec(
      await response.text(),
    );
    expect(
      stamped,
      'ngsw-worker.js carries a policy fingerprint — without one, a CSP change can never ' +
        'reach a browser that already installed this worker',
    ).not.toBeNull();

    // Recomputed from the header actually served, not from `firebase.json`:
    // a stamp that describes a policy nobody is serving is no protection.
    const expected = createHash('sha256')
      .update(`Content-Security-Policy: ${csp}`)
      .digest('hex')
      .slice(0, 16);
    expect(stamped![1], 'the fingerprint in ngsw-worker.js describes the CSP served with it').toBe(
      expected,
    );
  });

  test('re-fetches the OAuth popup resolver’s resources without synthesizing a 504', async ({
    page,
    request,
  }) => {
    const { authDomain } = await deploymentIdentity(request);

    // `app.config.ts` gates registration on `!navigator.webdriver`, which is
    // true under any browser-automation framework — so the worker this spec is
    // about never registers on its own here and has to be asked for by name.
    await page.goto('/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/ngsw-worker.js');
      await navigator.serviceWorker.ready;
    });

    // ngsw calls `clients.claim()` on activate, but a reload is what guarantees
    // the document is controlled from its very first byte rather than partway
    // through, which is the state a returning visitor is actually in.
    await page.reload();
    // Polled on the script URL rather than asserted once: `clients.claim()` is
    // asynchronous, so the controller can still be null for a beat after the
    // reload. Empty string rather than null for an uncontrolled page, so the
    // retry is always an ordinary `toContain` failure rather than a matcher
    // complaining about its input.
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''), {
        message: 'the page is controlled by a service worker',
      })
      .toContain('ngsw-worker.js');

    // Positive control, and the reason this spec cannot pass vacuously: with no
    // worker intercepting, every probe below would trivially succeed as a plain
    // network fetch. `/ngsw/state` is answered by the worker and by nothing
    // else, so a response containing ngsw's debug banner proves interception is
    // live at the moment the probes run.
    expect(
      await page.evaluate(() =>
        fetch('/ngsw/state', { cache: 'no-store' }).then((response) => response.text()),
      ),
      'the worker is answering /ngsw/state',
    ).toContain('NGSW Debug Info');

    // Both origins the popup resolver needs. `apis.google.com/js/api.js` is the
    // gapi loader it injects as a page subresource; the `authDomain` is the
    // origin it frames. The authDomain is probed at its root rather than at
    // `/__/auth/iframe` because `connect-src` is enforced per origin, so the
    // root exercises the identical rule through the identical code path.
    const probes: readonly string[] = [
      'https://apis.google.com/js/api.js',
      `https://${authDomain}/`,
    ];

    for (const url of probes) {
      const result = await page.evaluate<ProbeResult, string>(
        (target) =>
          fetch(target, { mode: 'no-cors', cache: 'no-store' })
            .then((response) => ({ type: response.type, status: response.status, error: null }))
            .catch((error: unknown) => ({ type: 'threw', status: -1, error: String(error) })),
        url,
      );

      expect(
        result.status,
        `${url} came back as ngsw's synthetic "504 Gateway Timeout" — the worker could not ` +
          `re-fetch it, which is what breaks the OAuth popup resolver (PR #112)`,
      ).not.toBe(504);
      expect(result, `${url} through the service worker`).toEqual({
        type: 'opaque',
        status: 0,
        error: null,
      });
    }

    // No teardown, and it is worth saying why rather than leaving it looking
    // forgotten: the registration belongs to this test's own `BrowserContext`
    // and is discarded with it. A runner that shared one origin across specs
    // would need an explicit unregister plus a sweep of the `ngsw:` caches, or
    // every later spec pays the cost `app.config.ts` documents at ~7 s → 46 s+.
  });
});
