import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webhookRouteFor } from './webhook-routing';

test('routes every subscription lifecycle event to the subscription sync', () => {
  for (const type of [
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ]) {
    assert.equal(webhookRouteFor(type), 'subscription');
  }
});

test('routes catalog events to the product/price mirror', () => {
  assert.equal(webhookRouteFor('product.created'), 'product-sync');
  assert.equal(webhookRouteFor('product.updated'), 'product-sync');
  assert.equal(webhookRouteFor('product.deleted'), 'product-delete');
  assert.equal(webhookRouteFor('price.created'), 'price-sync');
  assert.equal(webhookRouteFor('price.updated'), 'price-sync');
  assert.equal(webhookRouteFor('price.deleted'), 'price-delete');
});

test('ignores everything else rather than erroring', () => {
  // A representative slice of what Stripe can send that we deliberately do
  // not act on. `ignore` must be the answer — a throw here would 500 the
  // endpoint and make Stripe retry (and eventually disable) it.
  for (const type of [
    'checkout.session.completed',
    'invoice.paid',
    'invoice.payment_failed',
    'payment_intent.succeeded',
    'customer.created',
    'customer.subscription.trial_will_end',
    'not.a.real.event',
  ]) {
    assert.equal(webhookRouteFor(type), 'ignore');
  }
});
