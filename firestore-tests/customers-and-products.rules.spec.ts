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
  sessionDocId,
  validCheckoutSession,
  validPortalSession,
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

// checkout_sessions and portal_sessions share their auth, ownership and
// rate-limit rules, so those are covered once for both; only the schemas
// differ, and each gets its own suite below.
describe.each([
  ['checkout_sessions', validCheckoutSession] as const,
  ['portal_sessions', validPortalSession] as const,
])('customers/{uid}/%s', (name, validPayload) => {
  const create = (ctx: RulesTestContext, uid: string, id: string, data = validPayload()) =>
    setDoc(sub(ctx, uid, name, id), data);

  it('can be created by its owner to kick off the handshake', async () => {
    await assertSucceeds(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId()));
  });

  it('can be read back by its owner to collect the URL the function writes', async () => {
    await seed(['customers', OWNER, name, 'sess'], validPayload());
    await assertSucceeds(getDoc(sub(asVerifiedPassword(env, OWNER), OWNER, name, 'sess')));
  });

  it("rejects creating one under another user's customer document", async () => {
    await assertFails(create(asVerifiedPassword(env, OTHER), OWNER, sessionDocId()));
  });

  it("rejects reading another user's session", async () => {
    await seed(['customers', OWNER, name, 'sess'], validPayload());
    await assertFails(getDoc(sub(asVerifiedPassword(env, OTHER), OWNER, name, 'sess')));
  });

  it('rejects an anonymous caller', async () => {
    await assertFails(create(asAnonymous(env, OWNER), OWNER, sessionDocId()));
  });

  it('rejects an unverified password account', async () => {
    await assertFails(create(asUnverifiedPassword(env, OWNER), OWNER, sessionDocId()));
  });

  it('rejects an update — the function owns the write-back', async () => {
    await seed(['customers', OWNER, name, 'sess'], validPayload());
    await assertFails(
      setDoc(sub(asVerifiedPassword(env, OWNER), OWNER, name, 'sess'), {
        ...validPayload(),
        url: 'https://evil.test',
      }),
    );
  });

  it('rejects a delete', async () => {
    await seed(['customers', OWNER, name, 'sess'], validPayload());
    await assertFails(deleteDoc(sub(asVerifiedPassword(env, OWNER), OWNER, name, 'sess')));
  });

  /*
   * Finding A2. Until this landed there was no schema validation on these
   * paths at all: any field of any size was accepted, and `success_url` in
   * particular went straight to Stripe as the address to return the user to
   * after paying. This test previously asserted the opposite, labelled
   * `CURRENTLY ACCEPTS`, so that the change of expectation would be visible in
   * the diff rather than silent.
   */
  it('rejects arbitrary unvalidated fields (finding A2)', async () => {
    await assertFails(
      create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(), {
        anything: 'x'.repeat(5000),
        success_url: 'https://attacker.test/collect',
        price: 'price_some_other_product',
      }),
    );
  });

  it('rejects the pre-validation payload the old client sent', async () => {
    await assertFails(
      create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(), {
        price: 'price_test_pro',
        mode: 'subscription',
        success_url: 'https://example.web.app/pricing?checkout=success',
        cancel_url: 'https://example.web.app/pricing?checkout=cancelled',
      }),
    );
  });

  describe('origin', () => {
    it('rejects a missing origin', async () => {
      const { origin, ...withoutOrigin } = validPayload();
      void origin;
      await assertFails(
        create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(), withoutOrigin),
      );
    });

    // A bare origin has nothing to smuggle; a URL does. The function builds
    // the redirect target itself, so anything past the host is a sign the
    // caller is trying to choose it.
    it('rejects an origin carrying a path, query or fragment', async () => {
      for (const origin of [
        'https://example.web.app/evil',
        'https://example.web.app?next=evil',
        'https://example.web.app#x',
      ]) {
        await assertFails(
          create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(), validPayload({ origin })),
        );
      }
    });

    it('rejects a non-http(s) scheme', async () => {
      await assertFails(
        create(
          asVerifiedPassword(env, OWNER),
          OWNER,
          sessionDocId(),
          validPayload({ origin: 'javascript:alert(1)' }),
        ),
      );
    });

    it('rejects plain http on a public host', async () => {
      await assertFails(
        create(
          asVerifiedPassword(env, OWNER),
          OWNER,
          sessionDocId(),
          validPayload({ origin: 'http://example.web.app' }),
        ),
      );
    });

    // The emulator serves the app from localhost, so these rules — the same
    // file production runs — have to accept it. Narrowing localhost to demo
    // projects is the function's job, since rules can't know the project.
    it('accepts a localhost origin, which is what the emulator serves', async () => {
      await assertSucceeds(
        create(
          asVerifiedPassword(env, OWNER),
          OWNER,
          sessionDocId(),
          validPayload({ origin: 'http://localhost:4200' }),
        ),
      );
    });

    it('rejects an over-long origin', async () => {
      await assertFails(
        create(
          asVerifiedPassword(env, OWNER),
          OWNER,
          sessionDocId(),
          validPayload({ origin: `https://${'a'.repeat(300)}.web.app` }),
        ),
      );
    });

    it('rejects a non-string origin', async () => {
      await assertFails(
        create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(), validPayload({ origin: 42 })),
      );
    });
  });

  /*
   * Finding A3. Rules cannot count a user's documents, so the cap lives in the
   * document ID: `{5-minute window}-{slot 0-9}`, and `create` only ever
   * applies to an ID that doesn't exist yet. Ten IDs per window is ten Cloud
   * Function invocations, and therefore ten Stripe calls, per five minutes.
   */
  describe('volume cap (finding A3)', () => {
    it('rejects the auto-generated ID the old client used', async () => {
      await assertFails(
        addDoc(subCol(asVerifiedPassword(env, OWNER), OWNER, name), validPayload()),
      );
    });

    // The cap itself: a slot is spent once used, and re-using it is an update,
    // which no rule allows.
    it('rejects re-using a slot already spent in this window', async () => {
      const id = sessionDocId(3);
      await assertSucceeds(create(asVerifiedPassword(env, OWNER), OWNER, id));
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, id));
    });

    it('accepts every one of the ten slots in a window, and nothing beyond them', async () => {
      for (let slot = 0; slot < 10; slot++) {
        await assertSucceeds(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(slot)));
      }
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(10)));
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId('00')));
    });

    // Tolerated so a client clock a few minutes out — or a write that simply
    // crosses a window boundary between picking an ID and being evaluated —
    // isn't rejected. Same skew `isNearRequestTime` already accepts.
    it('accepts the neighbouring windows', async () => {
      await assertSucceeds(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(0, -1)));
      await assertSucceeds(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(0, 1)));
    });

    // Without this, a client could pre-claim thousands of future windows in
    // one loop and the cap would be decorative.
    it('rejects a window outside that tolerance', async () => {
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(0, -2)));
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(0, 2)));
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(0, 1000)));
    });

    it('rejects an ID that merely contains a valid one', async () => {
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, `x${sessionDocId()}`));
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, `${sessionDocId()}x`));
    });
  });
});

describe('customers/{uid}/checkout_sessions: the price a client may ask to be charged', () => {
  const create = (data: Record<string, unknown>) =>
    setDoc(sub(asVerifiedPassword(env, OWNER), OWNER, 'checkout_sessions', sessionDocId()), data);

  it('rejects a missing price', async () => {
    await assertFails(create({ origin: 'https://example.web.app' }));
  });

  it('rejects an ID for some other kind of Stripe object', async () => {
    await assertFails(create(validCheckoutSession({ price: 'prod_123' })));
    await assertFails(create(validCheckoutSession({ price: 'cus_123' })));
  });

  it('rejects a bare prefix with no handle', async () => {
    await assertFails(create(validCheckoutSession({ price: 'price_' })));
  });

  it('rejects a non-string price', async () => {
    await assertFails(create(validCheckoutSession({ price: 99 })));
  });

  // Shape is as far as rules can go — whether this ID is a price *we sell* is
  // checked again in `createCheckoutSession` against the mirrored catalog,
  // which is the half rules structurally cannot do.
  it('accepts a well-formed price ID for a product it cannot verify', async () => {
    await assertSucceeds(create(validCheckoutSession({ price: 'price_someOtherProduct' })));
  });
});

describe('customers/{uid}/portal_sessions: nothing but an origin', () => {
  it('rejects a price on a portal session', async () => {
    await assertFails(
      setDoc(
        sub(asVerifiedPassword(env, OWNER), OWNER, 'portal_sessions', sessionDocId()),
        validPortalSession({ price: 'price_test_pro' }),
      ),
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
