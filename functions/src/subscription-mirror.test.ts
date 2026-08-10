import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Stripe from 'stripe';
import { subscriptionMirrorFrom } from './subscription-mirror';

/**
 * The handful of fields the mirror actually reads, cast to the full Stripe
 * type the way the webhook's own `event.data.object as Stripe.Subscription`
 * already does — building a complete, honest Stripe.Subscription would pin
 * dozens of fields this code never looks at.
 */
function subscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: 'sub_123',
    status: 'active',
    cancel_at_period_end: false,
    metadata: { firebaseUID: 'user-1' },
    items: {
      data: [
        {
          price: {
            id: 'price_123',
            product: 'prod_123',
            metadata: { firebaseRole: 'pro' },
          },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

test('maps a subscription to the doc shape the client listener reads', () => {
  const mirror = subscriptionMirrorFrom(subscription());
  assert.deepEqual(mirror, {
    uid: 'user-1',
    doc: {
      status: 'active',
      role: 'pro',
      price: 'price_123',
      product: 'prod_123',
      cancel_at_period_end: false,
    },
  });
});

test('refuses a subscription with no firebaseUID metadata', () => {
  // The metadata is the only link back to an Auth user. Guessing a uid is
  // not an option, so the mapping has to say "skip" rather than invent one.
  assert.equal(subscriptionMirrorFrom(subscription({ metadata: {} })), null);
  assert.equal(subscriptionMirrorFrom(subscription({ metadata: undefined })), null);
  assert.equal(subscriptionMirrorFrom(subscription({ metadata: { firebaseUID: '' } })), null);
});

test('stores the product ID whether Stripe sent a string or an expanded object', () => {
  const expanded = subscription({
    items: {
      data: [{ price: { id: 'price_123', product: { id: 'prod_expanded' }, metadata: {} } }],
    },
  });
  assert.equal(subscriptionMirrorFrom(expanded)?.doc.product, 'prod_expanded');

  const asString = subscriptionMirrorFrom(subscription());
  assert.equal(asString?.doc.product, 'prod_123');
});

test('a price without firebaseRole metadata yields a null role, not a granted one', () => {
  const noRole = subscription({
    items: { data: [{ price: { id: 'price_123', product: 'prod_123', metadata: {} } }] },
  });
  assert.equal(subscriptionMirrorFrom(noRole)?.doc.role, null);
});

test('a subscription with no items still mirrors, with null price/product/role', () => {
  const empty = subscriptionMirrorFrom(subscription({ items: { data: [] } }));
  assert.deepEqual(empty?.doc, {
    status: 'active',
    role: null,
    price: null,
    product: null,
    cancel_at_period_end: false,
  });
});
