import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  STRIPE_ROLE_CLAIM,
  isPrivilegeDowngrade,
  readStripeRole,
  withStripeRoleClaim,
} from './claims';

describe('readStripeRole', () => {
  it('reads the role off an existing claims object', () => {
    assert.equal(readStripeRole({ [STRIPE_ROLE_CLAIM]: 'pro' }), 'pro');
  });

  it('reports no role for a user with no claims at all', () => {
    assert.equal(readStripeRole(undefined), null);
    assert.equal(readStripeRole({}), null);
  });

  it('reports no role for other claims', () => {
    assert.equal(readStripeRole({ admin: true }), null);
  });

  // A non-string claim would otherwise flow into the downgrade comparison and
  // into `firestore.rules`, where `== 'pro'` is the only thing standing
  // between a user and a privileged write.
  it('reports no role for a claim that is not a non-empty string', () => {
    assert.equal(readStripeRole({ [STRIPE_ROLE_CLAIM]: true }), null);
    assert.equal(readStripeRole({ [STRIPE_ROLE_CLAIM]: 1 }), null);
    assert.equal(readStripeRole({ [STRIPE_ROLE_CLAIM]: '' }), null);
    assert.equal(readStripeRole({ [STRIPE_ROLE_CLAIM]: null }), null);
  });
});

describe('withStripeRoleClaim', () => {
  it('sets the role on a user who had no claims', () => {
    assert.deepEqual(withStripeRoleClaim(undefined, 'pro'), { stripeRole: 'pro' });
  });

  // Finding A4. `setCustomUserClaims` replaces the whole object, so writing
  // `{ stripeRole: 'pro' }` directly deletes everything else the user had.
  it('keeps every other claim when granting a role', () => {
    assert.deepEqual(withStripeRoleClaim({ admin: true, tier: 'beta' }, 'pro'), {
      admin: true,
      tier: 'beta',
      stripeRole: 'pro',
    });
  });

  // The other half of A4, and the one the finding named: clearing used to pass
  // `null`, which erases every claim on the user rather than this one.
  it('keeps every other claim when revoking a role', () => {
    assert.deepEqual(withStripeRoleClaim({ admin: true, stripeRole: 'pro' }, null), {
      admin: true,
    });
  });

  it('removes the key rather than leaving it null or empty', () => {
    const result = withStripeRoleClaim({ stripeRole: 'pro' }, null);
    assert.deepEqual(result, {});
    assert.equal(STRIPE_ROLE_CLAIM in result, false);
  });

  it('overwrites an existing role rather than appending to it', () => {
    assert.deepEqual(withStripeRoleClaim({ stripeRole: 'basic' }, 'pro'), { stripeRole: 'pro' });
  });

  it('is a no-op to clear a role the user never had', () => {
    assert.deepEqual(withStripeRoleClaim({ admin: true }, null), { admin: true });
  });

  // The caller still needs the previous claims to decide whether this change
  // is a downgrade, so editing them in place would make that ordering silently
  // load bearing.
  it('does not mutate the claims object it was given', () => {
    const existing = { admin: true, stripeRole: 'pro' };
    withStripeRoleClaim(existing, null);
    assert.deepEqual(existing, { admin: true, stripeRole: 'pro' });
  });
});

describe('isPrivilegeDowngrade', () => {
  it('is a downgrade when the role is taken away', () => {
    assert.equal(isPrivilegeDowngrade('pro', null), true);
  });

  // An old token still asserting `pro` is the problem, whether the new value
  // is nothing or something lesser.
  it('is a downgrade when the role changes to a different one', () => {
    assert.equal(isPrivilegeDowngrade('pro', 'basic'), true);
  });

  // Revoking here would sign a user out seconds after they finished paying,
  // and an old token asserting *less* than the truth is harmless anyway.
  it('is not a downgrade when a role is granted', () => {
    assert.equal(isPrivilegeDowngrade(null, 'pro'), false);
  });

  it('is not a downgrade when nothing changed', () => {
    assert.equal(isPrivilegeDowngrade('pro', 'pro'), false);
    assert.equal(isPrivilegeDowngrade(null, null), false);
  });
});
