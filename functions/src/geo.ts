import { onRequest } from 'firebase-functions/v2/https';
import { countryFromHeaders } from './geo-country';

/**
 * Tells the page which country the visitor's IP address maps to, and nothing
 * else.
 *
 * **Why the server has to answer this at all.** The pricing page has to open
 * on the right currency before anyone clicks anything: this Stripe account is
 * registered in Brazil, and a Brazilian-issued card presented a USD price is
 * declined outright (`checkout-sessions.ts`). The first version of that
 * default read the browser's *language*, which is not where anybody is — a
 * Brazilian browsing in `en-US` was quoted dollars and got the refusal this
 * whole feature exists to avoid.
 *
 * **Why it is first-party.** Firebase Hosting already resolves the client IP
 * to a country at the edge and passes it down as `X-Country-Code` on every
 * request it proxies to a function. Reaching it through a Hosting rewrite
 * (`/api/geo` in `firebase.json`) therefore means the browser calls the app's
 * own origin: no third-party geolocation service, no new host in the CSP
 * (`connect-src 'self'` already covers it), and nothing about the visitor
 * leaving the systems the Privacy Policy already lists.
 *
 * **What is kept: nothing.** The country is read off the request, written into
 * the response, and forgotten. There is no Firestore write, no log line naming
 * it, and no cookie — `Cache-Control: private, no-store` so no shared cache
 * can hold one visitor's answer and hand it to the next. The platform's own
 * request logs are the only record, and those exist for every request already.
 *
 * **What the caller must tolerate.** The header is the platform's and it may
 * be absent — on `ng serve`, on a request that did not come through Hosting,
 * or if Hosting simply could not resolve the address. Every one of those
 * answers `{"country": null}` rather than guessing, and the client treats it
 * exactly like a request that never arrived: it falls through to its own
 * signals. A preview channel is the same case from the other side — preview
 * channels deploy Hosting only (`docs/ci-cd.md` §4.2a), so on a PR that adds
 * this function the rewrite resolves to nothing and the page degrades instead
 * of breaking.
 *
 * `invoker: 'public'` for the same reason `stripeWebhook` needs it: 2nd-gen
 * `onRequest` functions deploy onto Cloud Run, which defaults to demanding a
 * Google-issued token on every invocation, and a browser has none. There is no
 * authorisation to give up here — the endpoint reads one header off the
 * caller's own request and tells them what it said.
 */
export const geo = onRequest(
  {
    invoker: 'public',
    // Unauthenticated by necessity, so anyone can call it in a loop. The gen-2
    // default is 100 instances at 80 concurrent requests each; five still
    // serves ~400 at once, far past anything this app sees, and a caller who
    // exceeds it waits — which the client already treats as "country unknown"
    // after two seconds. That turns a bill someone else can run up into a
    // pre-selected radio button not moving.
    maxInstances: 5,
  },
  (req, res) => {
    // A shared cache holding one visitor's country and serving it to the next
    // is the one way this endpoint could be actively wrong, so it is refused
    // before anything else — including on the 405 path, which is still a
    // response an intermediary could store.
    res.set('Cache-Control', 'private, no-store');

    if (req.method !== 'GET') {
      res.status(405).set('Allow', 'GET').json({ error: 'Method not allowed.' });
      return;
    }

    res.status(200).json({ country: countryFromHeaders(req.headers) });
  },
);
