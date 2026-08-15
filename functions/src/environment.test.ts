import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isDemoProject,
  isEventForThisEnvironment,
  isMockCheckoutEnabled,
  resolveProjectId,
  stripeModeOfKey,
} from './environment';

describe('resolveProjectId', () => {
  it('prefers the runtime-provided GCLOUD_PROJECT', () => {
    assert.equal(
      resolveProjectId({
        GCLOUD_PROJECT: 'intellectura-3b26a',
        FIREBASE_CONFIG: '{"projectId":"other"}',
      }),
      'intellectura-3b26a',
    );
  });

  it('falls back to GOOGLE_CLOUD_PROJECT', () => {
    assert.equal(
      resolveProjectId({ GOOGLE_CLOUD_PROJECT: 'demo-trivia-app-e2e' }),
      'demo-trivia-app-e2e',
    );
  });

  it('falls back to the projectId inside FIREBASE_CONFIG', () => {
    assert.equal(resolveProjectId({ FIREBASE_CONFIG: '{"projectId":"demo-x"}' }), 'demo-x');
  });

  it('reports an unknown project rather than throwing on malformed FIREBASE_CONFIG', () => {
    assert.equal(resolveProjectId({ FIREBASE_CONFIG: 'not json' }), undefined);
  });

  it('reports an unknown project when FIREBASE_CONFIG carries no projectId', () => {
    assert.equal(resolveProjectId({ FIREBASE_CONFIG: '{"storageBucket":"b"}' }), undefined);
  });

  it('reports an unknown project when nothing is set at all', () => {
    assert.equal(resolveProjectId({}), undefined);
  });
});

describe('isDemoProject', () => {
  it('accepts the e2e/Lighthouse emulator project', () => {
    assert.equal(isDemoProject('demo-trivia-app-e2e'), true);
  });

  it('rejects the real project', () => {
    assert.equal(isDemoProject('intellectura-3b26a'), false);
  });

  // The check is a prefix, not a substring — otherwise `not-a-demo-project`
  // would qualify, and so would anything an attacker could get named.
  it('rejects a project that merely contains "demo-"', () => {
    assert.equal(isDemoProject('prod-demo-trivia'), false);
  });

  it('rejects an unknown project', () => {
    assert.equal(isDemoProject(undefined), false);
  });
});

describe('isMockCheckoutEnabled', () => {
  it('is on for a demo project with the flag set', () => {
    assert.equal(isMockCheckoutEnabled('demo-trivia-app-e2e', 'true'), true);
  });

  // This is the whole point of finding A7: the flag alone must not be enough,
  // or one stray environment variable makes production hand out fake checkout
  // URLs that look like they worked and take money from nobody.
  it('is off on the real project even with the flag set', () => {
    assert.equal(isMockCheckoutEnabled('intellectura-3b26a', 'true'), false);
  });

  it('is off on a demo project without the flag', () => {
    assert.equal(isMockCheckoutEnabled('demo-trivia-app-e2e', undefined), false);
  });

  it('is off when the flag is set to anything other than the exact string "true"', () => {
    assert.equal(isMockCheckoutEnabled('demo-trivia-app-e2e', '1'), false);
    assert.equal(isMockCheckoutEnabled('demo-trivia-app-e2e', 'TRUE'), false);
  });

  // Failing open when the project can't be identified would put the fallback
  // on the wrong side of the decision.
  it('is off when the project cannot be identified', () => {
    assert.equal(isMockCheckoutEnabled(undefined, 'true'), false);
  });
});

describe('stripeModeOfKey', () => {
  it('classifies both standard key modes', () => {
    assert.equal(stripeModeOfKey('sk_live_51AbCdEfGh'), 'live');
    assert.equal(stripeModeOfKey('sk_test_51AbCdEfGh'), 'test');
  });

  // Matched on the mode infix, not an `sk_` prefix, so restricted keys — and
  // any future key type — classify rather than falling through as unknown.
  it('classifies restricted keys', () => {
    assert.equal(stripeModeOfKey('rk_live_51AbCdEfGh'), 'live');
    assert.equal(stripeModeOfKey('rk_test_51AbCdEfGh'), 'test');
  });

  it('classifies nothing it cannot read', () => {
    assert.equal(stripeModeOfKey(undefined), null);
    assert.equal(stripeModeOfKey(''), null);
    assert.equal(stripeModeOfKey('placeholder-value'), null);
  });
});

const LIVE_KEY = 'sk_live_51AbCdEfGh';
const TEST_KEY = 'sk_test_51AbCdEfGh';
const REAL = 'intellectura-3b26a';
const DEMO = 'demo-trivia-app-e2e';

describe('isEventForThisEnvironment', () => {
  it('accepts a live event when a live key is deployed', () => {
    assert.equal(isEventForThisEnvironment(true, LIVE_KEY, REAL), true);
  });

  // The failure this exists for: the test and live signing secrets are one
  // `functions:secrets:set` apart, and with the wrong one installed alongside a
  // live key, every test-mode event a developer triggers verifies cleanly and
  // rewrites real customers, claims and prices.
  it('rejects a test-mode event when a live key is deployed', () => {
    assert.equal(isEventForThisEnvironment(false, LIVE_KEY, REAL), false);
  });

  /*
   * The regression this replaced. The check used to derive the expected mode
   * from the project ID — a real project must mean live — which is false here:
   * production deliberately runs a test key before launch (`docs/known-gaps.md` §6).
   * That rule refused every genuine delivery, so a completed checkout would
   * never have granted anyone Pro. The key is the right authority because it
   * *defines* which Stripe the deployment talks to.
   */
  it('accepts a test-mode event on the real project when a test key is deployed', () => {
    assert.equal(isEventForThisEnvironment(false, TEST_KEY, REAL), true);
  });

  it('rejects a live event when only a test key is deployed', () => {
    assert.equal(isEventForThisEnvironment(true, TEST_KEY, REAL), false);
  });

  // The emulator runs on placeholder secrets that classify as neither mode, so
  // a demo project is pinned to test rather than left unclassifiable.
  it('pins a demo project to test mode whatever the key looks like', () => {
    assert.equal(isEventForThisEnvironment(false, 'placeholder', DEMO), true);
    assert.equal(isEventForThisEnvironment(true, 'placeholder', DEMO), false);
    assert.equal(isEventForThisEnvironment(false, LIVE_KEY, DEMO), true);
  });

  // A dropped event on a misconfigured deploy is recoverable; live billing
  // state mutated by a test is not.
  it('accepts nothing when the key cannot be classified', () => {
    assert.equal(isEventForThisEnvironment(true, 'placeholder', REAL), false);
    assert.equal(isEventForThisEnvironment(false, 'placeholder', REAL), false);
    assert.equal(isEventForThisEnvironment(true, undefined, REAL), false);
  });

  // The project ID only decides the demo pin; once past that the key is the
  // authority, so an unidentifiable project is not by itself disqualifying.
  it('still trusts a classifiable key when the project cannot be identified', () => {
    assert.equal(isEventForThisEnvironment(true, LIVE_KEY, undefined), true);
    assert.equal(isEventForThisEnvironment(false, LIVE_KEY, undefined), false);
  });
});
