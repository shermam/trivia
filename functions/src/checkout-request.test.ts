import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RejectedRequestError,
  clientMessageFor,
  isAllowedRedirectOrigin,
  isPriceIdShaped,
  isSellableProPrice,
} from './checkout-request';

const REAL = 'intellectura-3b26a';
const DEMO = 'demo-trivia-app-e2e';

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
});
