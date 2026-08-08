import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EVENT_CREATED_FIELD, isStaleEvent } from './event-order';

/**
 * `event.created` is epoch **seconds**, so these fixtures are seconds too —
 * mixing in a millisecond value would make every comparison pass for the wrong
 * reason.
 */
const EARLIER = 1_770_000_000;
const LATER = 1_770_000_060;

describe('isStaleEvent', () => {
  // The finding: `cancelled` arriving after `active` used to overwrite it, and
  // the stripeRole claim was then recomputed from the older truth.
  it('drops an event older than what the document already holds', () => {
    assert.equal(isStaleEvent(LATER, EARLIER), true);
  });

  it('accepts an event newer than the document', () => {
    assert.equal(isStaleEvent(EARLIER, LATER), false);
  });

  // Not stale: a redelivery of the event that wrote the document carries
  // exactly its mark, and two genuine updates can share a second. Both write
  // the same or equivalent data, so letting them through is correct and
  // treating a tie as stale would drop the second of two real updates.
  it('accepts an event with the same timestamp', () => {
    assert.equal(isStaleEvent(LATER, LATER), false);
  });

  // Otherwise the first event after this shipped would be dropped on every
  // document that predates the field.
  it('accepts any event against a document with no high-water mark', () => {
    assert.equal(isStaleEvent(undefined, EARLIER), false);
    assert.equal(isStaleEvent(null, EARLIER), false);
  });

  // A hand-edited or seeded document must not be able to freeze itself against
  // all future events by carrying a non-numeric mark.
  it('accepts any event against a non-numeric mark', () => {
    assert.equal(isStaleEvent('9999999999', EARLIER), false);
    assert.equal(isStaleEvent({ seconds: LATER }, EARLIER), false);
  });

  it('names the field in seconds, matching Stripe', () => {
    assert.equal(EVENT_CREATED_FIELD, 'eventCreated');
  });
});
