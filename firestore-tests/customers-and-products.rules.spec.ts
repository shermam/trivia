import {
  assertFails,
  assertSucceeds,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { addDoc, collection, deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  asAnonymous,
  asSignedOut,
  asUnverifiedPassword,
  asVerifiedPassword,
  createTestEnv,
} from './helpers';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnv('demo-rules-customers-products');
});
afterAll(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const OWNER = 'owner-uid';
const OTHER = 'other-uid';

const sub = (ctx: RulesTestContext, uid: string, name: string, id: string) =>
  doc(ctx.firestore(), 'customers', uid, name, id);
const subCol = (ctx: RulesTestContext, uid: string, name: string) =>
  collection(ctx.firestore(), 'customers', uid, name);

async function seed(path: string[], data: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path.join('/')), data);
  });
}

describe('customers/{uid}: the Stripe customer document', () => {
  beforeEach(() => seed(['customers', OWNER], { stripeId: 'cus_123' }));

  it('is readable by its owner', async () => {
    await assertSucceeds(
      getDoc(doc(asVerifiedPassword(env, OWNER).firestore(), 'customers', OWNER)),
    );
  });

  it('is not readable by another signed-in user', async () => {
    await assertFails(getDoc(doc(asVerifiedPassword(env, OTHER).firestore(), 'customers', OWNER)));
  });

  it('is not readable while signed out', async () => {
    await assertFails(getDoc(doc(asSignedOut(env).firestore(), 'customers', OWNER)));
  });

  it('is not readable by an anonymous session', async () => {
    await assertFails(getDoc(doc(asAnonymous(env, OWNER).firestore(), 'customers', OWNER)));
  });

  // Only createCheckoutSession writes this, via the Admin SDK, which bypasses rules.
  it('is not writable by its own owner', async () => {
    await assertFails(
      setDoc(doc(asVerifiedPassword(env, OWNER).firestore(), 'customers', OWNER), {
        stripeId: 'cus_attacker',
      }),
    );
  });
});

// checkout_sessions and portal_sessions share a rule shape, so they share a suite.
describe.each(['checkout_sessions', 'portal_sessions'])('customers/{uid}/%s', (name) => {
  const payload = { price: 'price_123', mode: 'subscription', return_url: 'https://example.test' };

  it('can be created by its owner to kick off the handshake', async () => {
    await assertSucceeds(addDoc(subCol(asVerifiedPassword(env, OWNER), OWNER, name), payload));
  });

  it('can be read back by its owner to collect the URL the function writes', async () => {
    await seed(['customers', OWNER, name, 'sess'], payload);
    await assertSucceeds(getDoc(sub(asVerifiedPassword(env, OWNER), OWNER, name, 'sess')));
  });

  it("rejects creating one under another user's customer document", async () => {
    await assertFails(addDoc(subCol(asVerifiedPassword(env, OTHER), OWNER, name), payload));
  });

  it("rejects reading another user's session", async () => {
    await seed(['customers', OWNER, name, 'sess'], payload);
    await assertFails(getDoc(sub(asVerifiedPassword(env, OTHER), OWNER, name, 'sess')));
  });

  it('rejects an anonymous caller', async () => {
    await assertFails(addDoc(subCol(asAnonymous(env, OWNER), OWNER, name), payload));
  });

  it('rejects an unverified password account', async () => {
    await assertFails(addDoc(subCol(asUnverifiedPassword(env, OWNER), OWNER, name), payload));
  });

  it('rejects an update — the function owns the write-back', async () => {
    await seed(['customers', OWNER, name, 'sess'], payload);
    await assertFails(
      setDoc(sub(asVerifiedPassword(env, OWNER), OWNER, name, 'sess'), {
        ...payload,
        url: 'https://evil.test',
      }),
    );
  });

  it('rejects a delete', async () => {
    await seed(['customers', OWNER, name, 'sess'], payload);
    await assertFails(deleteDoc(sub(asVerifiedPassword(env, OWNER), OWNER, name, 'sess')));
  });

  /*
   * Documents the current state rather than endorsing it. There is no schema
   * validation on these paths at all — any field of any size is accepted, and
   * every created document triggers a Cloud Function that calls Stripe. That is
   * findings A2/A3; the PR adding validation and a volume cap will flip this to
   * assertFails, and this test is here so that flip is visible in the diff.
   */
  it(`CURRENTLY ACCEPTS arbitrary unvalidated fields (findings A2/A3)`, async () => {
    await assertSucceeds(
      addDoc(subCol(asVerifiedPassword(env, OWNER), OWNER, name), {
        anything: 'x'.repeat(5000),
        success_url: 'https://attacker.test/collect',
        price: 'price_some_other_product',
      }),
    );
  });
});

describe('customers/{uid}/subscriptions: synced read-only from Stripe', () => {
  beforeEach(() => seed(['customers', OWNER, 'subscriptions', 'sub_1'], { status: 'active' }));

  it('is readable by its owner — this drives the real-time Pro signal', async () => {
    await assertSucceeds(
      getDoc(sub(asVerifiedPassword(env, OWNER), OWNER, 'subscriptions', 'sub_1')),
    );
  });

  it("rejects reading another user's subscription", async () => {
    await assertFails(getDoc(sub(asVerifiedPassword(env, OTHER), OWNER, 'subscriptions', 'sub_1')));
  });

  // The whole Pro gate would collapse if a user could grant themselves this.
  it('rejects a user writing their own subscription document', async () => {
    await assertFails(
      setDoc(sub(asVerifiedPassword(env, OWNER), OWNER, 'subscriptions', 'sub_1'), {
        status: 'active',
        role: 'pro',
      }),
    );
  });
});

describe('products and prices: the public catalog', () => {
  beforeEach(async () => {
    await seed(['products', 'prod_1'], { active: true, name: 'Pro' });
    await seed(['products', 'prod_1', 'prices', 'price_1'], { active: true, unit_amount: 99 });
  });

  it('is readable while signed out — /pricing renders before auth resolves', async () => {
    await assertSucceeds(getDoc(doc(asSignedOut(env).firestore(), 'products', 'prod_1')));
  });

  it('has publicly readable prices', async () => {
    await assertSucceeds(
      getDoc(doc(asSignedOut(env).firestore(), 'products', 'prod_1', 'prices', 'price_1')),
    );
  });

  it('rejects a client writing a product', async () => {
    await assertFails(
      setDoc(doc(asVerifiedPassword(env, OWNER).firestore(), 'products', 'prod_1'), {
        active: true,
        name: 'Free Pro',
      }),
    );
  });

  // Otherwise a user could mint a $0 price and check out against it.
  it('rejects a client writing a price', async () => {
    await assertFails(
      setDoc(
        doc(asVerifiedPassword(env, OWNER).firestore(), 'products', 'prod_1', 'prices', 'price_1'),
        { active: true, unit_amount: 0 },
      ),
    );
  });
});

describe('collections with no rule at all are denied by default', () => {
  it('rejects reading an undeclared collection', async () => {
    await assertFails(getDoc(doc(asVerifiedPassword(env, OWNER).firestore(), 'secrets', 'x')));
  });

  it('rejects writing an undeclared collection', async () => {
    await assertFails(
      setDoc(doc(asVerifiedPassword(env, OWNER).firestore(), 'secrets', 'x'), { a: 1 }),
    );
  });
});
