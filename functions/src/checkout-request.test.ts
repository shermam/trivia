import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RejectedRequestError,
  clientMessageFor,
  currencyConflictMessage,
  isAllowedRedirectOrigin,
  isPriceIdShaped,
  isSellableProPrice,
  openCheckoutSessionIdsToExpire,
} from './checkout-request';

const REAL = 'intellectura-3b26a';
const DEMO = 'demo-trivia-app-e2e';

/**
 * The exact message Stripe returned on 2026-09-12, to a buyer who had left two
 * open USD Checkout Sessions behind and then chose BRL. Copied character for
 * character: the mapping is a match against this sentence, so a test that
 * paraphrases it proves nothing about the refusal that actually happens.
 */
const STRIPE_CURRENCY_CONFLICT =
  'You cannot combine currencies on a single customer. This customer has an active ' +
  'subscription, subscription schedule, discount, quote, invoice item or active ' +
  'subscription mode checkout session with currency usd.';

const CURRENCY_CONFLICT_ADVICE =
  'Your account is already set up to pay in USD, so Pro can only be bought in USD from this account.';

/**
 * One entry of what `stripe.checkout.sessions.list` returns, narrowed to the
 * two fields the decision reads. Everything else Stripe sends goes through
 * this helper rather than into the literal, because the parameter type names
 * only those two and an object literal carrying more is a type error — which
 * would otherwise make "ignores the currency" an untestable claim.
 */
function listed(session: Record<string, unknown>): { id?: unknown; status?: unknown } {
  return session;
}

describe('isPriceIdShaped', () => {
  it('accepts a Stripe price ID', () => {
    assert.equal(isPriceIdShaped('price_1QxYzABCdefGHI'), true);
  });

  it('accepts the underscore-separated IDs the e2e catalog seeds', () => {
    assert.equal(isPriceIdShaped('price_test_pro'), true);
  });

  it('rejects an ID for a different Stripe object', () => {
    assert.equal(isPriceIdShaped('prod_1QxYz'), false);
    assert.equal(isPriceIdShaped('cus_1QxYz'), false);
  });

  it('rejects a bare prefix with no handle', () => {
    assert.equal(isPriceIdShaped('price_'), false);
  });

  it('rejects anything that is not a string', () => {
    assert.equal(isPriceIdShaped(undefined), false);
    assert.equal(isPriceIdShaped(42), false);
    assert.equal(isPriceIdShaped({ toString: () => 'price_x' }), false);
  });
});

describe('isAllowedRedirectOrigin', () => {
  it('accepts both hostnames Firebase Hosting serves the project on', () => {
    assert.equal(isAllowedRedirectOrigin(`https://${REAL}.web.app`, REAL), true);
    assert.equal(isAllowedRedirectOrigin(`https://${REAL}.firebaseapp.com`, REAL), true);
  });

  it('accepts a preview channel of the same project', () => {
    assert.equal(isAllowedRedirectOrigin(`https://${REAL}--pr-46-a1b2c3d4.web.app`, REAL), true);
  });

  // The custom domain is where real users actually are, so getting this wrong
  // breaks checkout for everyone while every `.web.app` test still passes.
  it('accepts the custom domain, apex and www', () => {
    assert.equal(isAllowedRedirectOrigin('https://trivimind.com', REAL), true);
    assert.equal(isAllowedRedirectOrigin('https://www.trivimind.com', REAL), true);
  });

  it('rejects a host that only looks like the custom domain', () => {
    assert.equal(isAllowedRedirectOrigin('https://trivimind.com.evil.test', REAL), false);
    assert.equal(isAllowedRedirectOrigin('https://eviltrivimind.com', REAL), false);
    assert.equal(isAllowedRedirectOrigin('https://trivimind.co', REAL), false);
    assert.equal(isAllowedRedirectOrigin('https://evil.trivimind.com', REAL), false);
  });

  it('rejects a downgrade to http on the custom domain', () => {
    assert.equal(isAllowedRedirectOrigin('http://trivimind.com', REAL), false);
  });

  // The finding itself: `success_url` was passed to Stripe verbatim, so
  // anyone able to write a session document could have Stripe bounce the user
  // to a host they controlled, arriving from a genuine Stripe redirect.
  it('rejects an attacker-controlled host', () => {
    assert.equal(isAllowedRedirectOrigin('https://attacker.test', REAL), false);
  });

  it('rejects a host that merely ends with ours', () => {
    assert.equal(isAllowedRedirectOrigin(`https://evil-${REAL}.web.app`, REAL), false);
    assert.equal(isAllowedRedirectOrigin(`https://${REAL}.web.app.evil.test`, REAL), false);
  });

  it('rejects another project on the same Hosting domain', () => {
    assert.equal(isAllowedRedirectOrigin('https://someone-elses-app.web.app', REAL), false);
  });

  // A preview-channel-shaped hostname is only ours if the part before `--` is
  // the whole project ID.
  it('rejects a preview channel of a different project', () => {
    assert.equal(isAllowedRedirectOrigin('https://other-project--pr-1-abc.web.app', REAL), false);
  });

  it('rejects a path, query or fragment smuggled onto an allowed origin', () => {
    assert.equal(isAllowedRedirectOrigin(`https://${REAL}.web.app/evil`, REAL), false);
    assert.equal(isAllowedRedirectOrigin(`https://${REAL}.web.app?next=evil`, REAL), false);
    assert.equal(isAllowedRedirectOrigin(`https://${REAL}.web.app#x`, REAL), false);
  });

  it('rejects a downgrade to http on the real project', () => {
    assert.equal(isAllowedRedirectOrigin(`http://${REAL}.web.app`, REAL), false);
  });

  it('accepts localhost only on a demo project', () => {
    assert.equal(isAllowedRedirectOrigin('http://localhost:4200', DEMO), true);
    assert.equal(isAllowedRedirectOrigin('http://127.0.0.1:5000', DEMO), true);
    assert.equal(isAllowedRedirectOrigin('http://localhost:4200', REAL), false);
  });

  // A demo project has no domain attached, so offering it the production one
  // would only ever be a way for a test fixture to look more real than it is.
  it('does not offer the custom domain to a demo project', () => {
    assert.equal(isAllowedRedirectOrigin('https://trivimind.com', DEMO), false);
  });

  it('rejects everything when the project cannot be identified', () => {
    assert.equal(isAllowedRedirectOrigin(`https://${REAL}.web.app`, undefined), false);
  });

  it('rejects an over-long origin', () => {
    assert.equal(
      isAllowedRedirectOrigin(`https://${REAL}--${'a'.repeat(300)}.web.app`, REAL),
      false,
    );
  });

  it('rejects anything that is not a string', () => {
    assert.equal(isAllowedRedirectOrigin(undefined, REAL), false);
    assert.equal(isAllowedRedirectOrigin(['https://x.web.app'], REAL), false);
  });
});

describe('isSellableProPrice', () => {
  const proProduct = { active: true, role: 'pro' };

  it('accepts an active price on an active Pro product', () => {
    assert.equal(isSellableProPrice(proProduct, { active: true }), true);
  });

  it('rejects an archived price', () => {
    assert.equal(isSellableProPrice(proProduct, { active: false }), false);
  });

  it('rejects a price on an archived product', () => {
    assert.equal(isSellableProPrice({ active: false, role: 'pro' }, { active: true }), false);
  });

  // Anything else in the same Stripe account is a real, well-formed price ID
  // that this app does not sell.
  it('rejects a price belonging to a product that is not the Pro tier', () => {
    assert.equal(isSellableProPrice({ active: true, role: null }, { active: true }), false);
    assert.equal(isSellableProPrice({ active: true, role: 'basic' }, { active: true }), false);
  });

  it('rejects a missing product or price', () => {
    assert.equal(isSellableProPrice(undefined, { active: true }), false);
    assert.equal(isSellableProPrice(proProduct, undefined), false);
  });

  // `active: 'true'` from a hand-written document must not read as active.
  it('requires a real boolean, not a truthy value', () => {
    assert.equal(isSellableProPrice({ active: 'true', role: 'pro' }, { active: true }), false);
    assert.equal(isSellableProPrice(proProduct, { active: 1 }), false);
  });
});

describe('clientMessageFor', () => {
  it('collapses a refusal to the generic message', () => {
    assert.equal(
      clientMessageFor(
        new RejectedRequestError('price price_evil is not an active Pro price'),
        'Try again.',
      ),
      'Try again.',
    );
  });

  it('keeps a genuine backend failure message, which is worth more to a user', () => {
    assert.equal(
      clientMessageFor(new Error('No Stripe customer found for this account yet.'), 'Try again.'),
      'No Stripe customer found for this account yet.',
    );
  });

  it('falls back to the generic message for a non-Error throw', () => {
    assert.equal(clientMessageFor('boom', 'Try again.'), 'Try again.');
  });

  // The one Stripe message this app answers better than Stripe does. Verbatim
  // is what the buyer used to be shown.
  it('replaces the currency conflict rather than passing Stripe’s wording through', () => {
    assert.equal(
      clientMessageFor(new Error(STRIPE_CURRENCY_CONFLICT), 'Try again.'),
      CURRENCY_CONFLICT_ADVICE,
    );
  });
});

describe('currencyConflictMessage', () => {
  it('names the currency the customer is committed to, in words they can act on', () => {
    assert.equal(
      currencyConflictMessage(new Error(STRIPE_CURRENCY_CONFLICT)),
      CURRENCY_CONFLICT_ADVICE,
    );
  });

  it('reads whichever currency the message names', () => {
    assert.equal(
      currencyConflictMessage(
        new Error(STRIPE_CURRENCY_CONFLICT.replace('currency usd', 'currency brl')),
      ),
      'Your account is already set up to pay in BRL, so Pro can only be bought in BRL from this account.',
    );
  });

  // "Different" is established by the refusal itself; the code is not. So a
  // reworded tail loses the code and keeps the instruction, rather than
  // naming a currency nobody read (`CLAUDE.md` §4.4).
  it('names no currency when the message carries none', () => {
    assert.equal(
      currencyConflictMessage(new Error('You cannot combine currencies on a single customer.')),
      'Your account is already set up to pay in a different currency, ' +
        'so Pro can only be bought in that currency from this account.',
    );
  });

  // The match is on the sentence because Stripe sends no code to key on, so
  // the sentence is also the thing that can rot. It has to rot into the
  // generic answer, never into a wrong one.
  it('declines every other failure, so the fallback stays generic', () => {
    assert.equal(currencyConflictMessage(new Error('No such price: price_123')), null);
    assert.equal(currencyConflictMessage(new Error('')), null);
    assert.equal(currencyConflictMessage('cannot combine currencies'), null);
    assert.equal(currencyConflictMessage(undefined), null);
  });

  it('matches Stripe’s wording however it is cased', () => {
    assert.equal(
      currencyConflictMessage(new Error('You Cannot Combine Currencies with currency USD.')),
      CURRENCY_CONFLICT_ADVICE,
    );
  });
});

describe('openCheckoutSessionIdsToExpire', () => {
  it('returns every open session, so no single one is left holding the currency', () => {
    assert.deepEqual(
      openCheckoutSessionIdsToExpire([
        listed({ id: 'cs_1', status: 'open' }),
        listed({ id: 'cs_2', status: 'open' }),
      ]),
      ['cs_1', 'cs_2'],
    );
  });

  // Not only the ones in another currency: an abandoned session is stale
  // whatever it is denominated in, and a listed session's own `currency` is
  // not a reliable answer to which that is anyway.
  it('does not consult the session’s currency', () => {
    assert.deepEqual(
      openCheckoutSessionIdsToExpire([
        listed({ id: 'cs_usd', status: 'open', currency: 'usd' }),
        listed({ id: 'cs_brl', status: 'open', currency: 'brl' }),
        listed({ id: 'cs_none', status: 'open', currency: null }),
      ]),
      ['cs_usd', 'cs_brl', 'cs_none'],
    );
  });

  // `expire` errors on anything that is not open, and a completed session is
  // somebody's live subscription — the one thing here that must never be
  // touched even if Stripe ignored the `status` query parameter.
  it('leaves completed and already-expired sessions alone', () => {
    assert.deepEqual(
      openCheckoutSessionIdsToExpire([
        listed({ id: 'cs_done', status: 'complete' }),
        listed({ id: 'cs_gone', status: 'expired' }),
        listed({ id: 'cs_unknown', status: null }),
        listed({ id: 'cs_live', status: 'open' }),
      ]),
      ['cs_live'],
    );
  });

  it('skips a session with no usable id', () => {
    assert.deepEqual(
      openCheckoutSessionIdsToExpire([
        listed({ id: undefined, status: 'open' }),
        listed({ id: '', status: 'open' }),
        listed({ id: 42, status: 'open' }),
        listed({ id: 'cs_ok', status: 'open' }),
      ]),
      ['cs_ok'],
    );
  });

  it('has nothing to do for a customer with no open sessions', () => {
    assert.deepEqual(openCheckoutSessionIdsToExpire([]), []);
  });
});
