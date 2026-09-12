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

/*
 * `checkout.session.completed` used to be on the ignore list and no longer is.
 * It is the only event that carries a completed one-time payment, and it is
 * also emitted for every Pro subscription starting — so routing it is
 * necessary and not sufficient: `donationRecordFrom` is what decides whether
 * the object in it is a donation.
 */
test('routes a completed checkout session to the donation recorder', () => {
  assert.equal(webhookRouteFor('checkout.session.completed'), 'checkout-completed');
});

// A delayed payment method (boleto, Pix — both ordinary for a Brazilian Stripe
// account) completes the session unpaid and settles later, on this event.
// Without it that donation is never recorded and nothing says so.
test('routes a settled asynchronous payment to the same handler', () => {
  assert.equal(webhookRouteFor('checkout.session.async_payment_succeeded'), 'checkout-completed');
});

// The other two Checkout Session outcomes stay unhandled on purpose: an
// expired session was never paid, and a failed asynchronous payment is a
// donation that did not happen.
test('ignores checkout sessions that produced no money', () => {
  assert.equal(webhookRouteFor('checkout.session.expired'), 'ignore');
  assert.equal(webhookRouteFor('checkout.session.async_payment_failed'), 'ignore');
});

test('ignores everything else rather than erroring', () => {
  // A representative slice of what Stripe can send that we deliberately do
  // not act on. `ignore` must be the answer — a throw here would 500 the
  // endpoint and make Stripe retry (and eventually disable) it.
  for (const type of [
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
