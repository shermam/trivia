import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isDemoProject,
  isEventForThisEnvironment,
  isMockCheckoutEnabled,
  resolveProjectId,
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

describe('isEventForThisEnvironment', () => {
  it('accepts a live event on the real project', () => {
    assert.equal(isEventForThisEnvironment(true, 'intellectura-3b26a'), true);
  });

  // The failure this exists for: the test and live signing secrets are one
  // `functions:secrets:set` apart, and with the wrong one installed every
  // test-mode event a developer triggers verifies cleanly and rewrites real
  // customers, claims and prices.
  it('rejects a test-mode event on the real project', () => {
    assert.equal(isEventForThisEnvironment(false, 'intellectura-3b26a'), false);
  });

  it('accepts a test-mode event on a demo project', () => {
    assert.equal(isEventForThisEnvironment(false, 'demo-trivia-app-e2e'), true);
  });

  it('rejects a live event on a demo project', () => {
    assert.equal(isEventForThisEnvironment(true, 'demo-trivia-app-e2e'), false);
  });

  // A dropped event on a misconfigured deploy is recoverable; live billing
  // state mutated by a test is not.
  it('accepts nothing when the project cannot be identified', () => {
    assert.equal(isEventForThisEnvironment(true, undefined), false);
    assert.equal(isEventForThisEnvironment(false, undefined), false);
  });
});
