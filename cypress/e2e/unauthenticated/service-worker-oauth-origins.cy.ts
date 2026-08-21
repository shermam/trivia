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
 * **This is deliberately its own spec file, and it is deliberately not in the
 * local suite.** Registering the service worker is expensive — `app.config.ts`
 * records two preview specs going from ~7 s to 46 s+ with a timeout when the
 * worker was left on — so the registration is confined here and torn down in
 * `after()`. It cannot run against `cypress.config.ts` at all: `ng serve
 * --configuration=e2e` sets no `serviceWorker` in `angular.json`, so there is
 * no `ngsw-worker.js` to register and no CSP on a dev server to govern it.
 * `cypress.config.ts` excludes it by name for that reason.
 *
 * **On what this can and cannot catch.** Cypress strips `Content-Security-Policy`
 * response headers from documents it loads in the browser (its own injected
 * runtime would violate them), so the *enforcement* half of the mechanism is
 * not reproducible in-browser here — the second test proves the worker
 * intercepts and re-fetches, not that a bad CSP would stop it. That is why the
 * first test asserts the served header via `cy.request`, which runs outside the
 * browser and sees the response unmodified. Between the two, a #112 regression
 * has to get past a check that reads the real deployed header.
 */

import { findCspProblems } from '../../../scripts/csp-rules.mjs';

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

describe('service worker: OAuth origins stay reachable (PR #112)', () => {
  let authDomain: string;

  before(() => {
    // `cy.request` runs outside the browser, which is the only way to read a
    // `/__/`-prefixed path here: Cypress reserves `/__` for its own runner and
    // any in-browser request to one hangs forever (see e2e.preview.ts).
    cy.request(`${Cypress.config('baseUrl')}/__/firebase/init.json`).then((response) => {
      authDomain = (response.body as { authDomain: string }).authDomain;
      expect(authDomain, 'authDomain from runtime config').to.be.a('string').and.not.be.empty;
    });
  });

  it('serves a CSP that satisfies the same rule csp:verify enforces on disk', () => {
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
      cy.request(`${Cypress.config('baseUrl')}${path}`).then((response) => {
        const csp = response.headers['content-security-policy'];
        expect(csp, `Content-Security-Policy served with ${path}`).to.be.a('string');

        const problems = findCspProblems(csp as string).map(
          ({ origin, detail, why }) => `${origin} — ${detail}. ${why}`,
        );
        expect(problems, `the CSP served with ${path} fails csp:verify's own rule`).to.deep.equal(
          [],
        );
      });
    }
  });

  it('serves a worker whose bytes carry a fingerprint of the CSP served with it', () => {
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
    cy.request(`${Cypress.config('baseUrl')}/ngsw-worker.js`).then((response) => {
      const csp = response.headers['content-security-policy'] as string;
      const body = response.body as string;

      const stamped = /\/\/ service-worker-policy-fingerprint: ([0-9a-f]{16})\s*$/.exec(body);
      expect(
        stamped,
        'ngsw-worker.js carries a policy fingerprint — without one, a CSP change can never ' +
          'reach a browser that already installed this worker',
      ).to.not.be.null;

      // Recomputed from the header actually served, not from `firebase.json`:
      // a stamp that describes a policy nobody is serving is no protection.
      return cy
        .wrap(null, { log: false })
        .then(() =>
          crypto.subtle
            .digest('SHA-256', new TextEncoder().encode(`Content-Security-Policy: ${csp}`))
            .then((buffer) =>
              [...new Uint8Array(buffer)]
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('')
                .slice(0, 16),
            ),
        )
        .then((expected) => {
          expect(
            stamped![1],
            'the fingerprint in ngsw-worker.js describes the CSP served with it',
          ).to.equal(expected);
        });
    });
  });

  it('re-fetches the OAuth popup resolver’s resources without synthesizing a 504', () => {
    // `app.config.ts` gates registration on `!navigator.webdriver`, which is
    // true for Cypress — so the worker this spec is about never registers on
    // its own here and has to be asked for by name.
    cy.visit('/');
    cy.window().then((win) => win.navigator.serviceWorker.register('/ngsw-worker.js'));
    cy.window().then((win) => win.navigator.serviceWorker.ready);

    // ngsw calls `clients.claim()` on activate, but a reload is what guarantees
    // the document is controlled from its very first byte rather than partway
    // through, which is the state a returning visitor is actually in.
    cy.reload();
    // Asserted through `should` rather than `its('...controller')`, which reports
    // an uncontrolled page as "the property does not exist" — true, and useless.
    cy.window().should((win) => {
      const controller = win.navigator.serviceWorker.controller;
      expect(controller, 'the page is controlled by a service worker').to.not.be.null;
      expect(controller!.scriptURL, 'controlling worker').to.contain('ngsw-worker.js');
    });

    // Positive control, and the reason this spec cannot pass vacuously: with no
    // worker intercepting, every probe below would trivially succeed as a plain
    // network fetch. `/ngsw/state` is answered by the worker and by nothing
    // else, so a response containing ngsw's debug banner proves interception is
    // live at the moment the probes run.
    cy.window()
      .then((win) => win.fetch('/ngsw/state', { cache: 'no-store' }).then((r) => r.text()))
      .should('contain', 'NGSW Debug Info');

    // Both origins the popup resolver needs. `apis.google.com/js/api.js` is the
    // gapi loader it injects as a page subresource; the `authDomain` is the
    // origin it frames. The authDomain is probed at its root rather than at
    // `/__/auth/iframe` because of the same Cypress `/__` collision as above —
    // `connect-src` is enforced per origin, so the root exercises the identical
    // rule through the identical code path.
    const probes: readonly string[] = [
      'https://apis.google.com/js/api.js',
      `https://${authDomain}/`,
    ];

    for (const url of probes) {
      cy.window()
        .then<ProbeResult>((win) =>
          win
            .fetch(url, { mode: 'no-cors', cache: 'no-store' })
            .then((r) => ({ type: r.type, status: r.status, error: null }))
            .catch((e: unknown) => ({ type: 'threw', status: -1, error: String(e) })),
        )
        .then((result) => {
          expect(
            result.status,
            `${url} came back as ngsw's synthetic "504 Gateway Timeout" — the worker could not ` +
              `re-fetch it, which is what breaks the OAuth popup resolver (PR #112)`,
          ).not.to.equal(504);
          expect(result, `${url} through the service worker`).to.deep.equal({
            type: 'opaque',
            status: 0,
            error: null,
          });
        });
    }
  });

  after(() => {
    // The registration outlives the spec file otherwise — `testIsolation` does
    // not clear it — and would slow every spec that runs after this one on the
    // same origin, which is the cost `app.config.ts` documents.
    cy.window({ log: false }).then(async (win) => {
      const registrations = await win.navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      const keys = await win.caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith('ngsw:')).map((key) => win.caches.delete(key)),
      );
    });
  });
});
