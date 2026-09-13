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
  validDonationSession,
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

    // Rules deliberately don't know which hostnames are ours — the custom
    // domain, the two `.web.app` names and a preview channel are all just
    // well-formed origins here, and the function decides between them. That
    // split is why attaching a custom domain needs no rules change at all.
    it('accepts a custom-domain origin, leaving the allowlist to the function', async () => {
      await assertSucceeds(
        create(
          asVerifiedPassword(env, OWNER),
          OWNER,
          sessionDocId(),
          validPayload({ origin: 'https://trivimind.com' }),
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

/*
 * The tip jar's session subcollection. It mirrors `checkout_sessions` in
 * everything but who may write one — donating is not a privilege, so an
 * anonymous session is allowed here and nowhere else in this tree — which is
 * why it does not share the block above. A shared `describe.each` would have
 * had to make the auth case conditional, and a conditional expectation is how
 * a rule that no longer holds keeps passing.
 */
describe('customers/{uid}/donation_sessions: anybody signed in may donate', () => {
  const create = (
    ctx: RulesTestContext,
    uid: string,
    id = sessionDocId(),
    data = validDonationSession(),
  ) => setDoc(sub(ctx, uid, 'donation_sessions', id), data);

  it('can be created by a verified account', async () => {
    await assertSucceeds(create(asVerifiedPassword(env, OWNER), OWNER));
  });

  // The friction this path deliberately does not have. An anonymous visitor is
  // the common donor: every page load signs one in, and asking them to make an
  // account first protects nothing — the payment goes to Stripe either way.
  it('can be created by an anonymous session', async () => {
    await assertSucceeds(create(asAnonymous(env, OWNER), OWNER));
  });

  // Unverified is accepted for the same reason. Pro refuses it because an
  // unverified account can be minted at will and Pro grants a privilege; a
  // donation grants nothing.
  it('can be created by an unverified password account', async () => {
    await assertSucceeds(create(asUnverifiedPassword(env, OWNER), OWNER));
  });

  it('rejects a signed-out caller', async () => {
    await assertFails(create(asSignedOut(env), OWNER));
  });

  // Two tests rather than two assertions in one, because a mutation run counts
  // tests: dropping the ownership check has to be visible as more than a single
  // failure, and the anonymous case is the one this path uniquely allows.
  it("rejects creating one under another user's customer document", async () => {
    await assertFails(create(asVerifiedPassword(env, OTHER), OWNER));
  });

  it("rejects an anonymous session writing under somebody else's customer document", async () => {
    await assertFails(create(asAnonymous(env, OTHER), OWNER));
  });

  it('can be read back by its owner to collect the URL the function writes', async () => {
    await seed(['customers', OWNER, 'donation_sessions', 'sess'], validDonationSession());
    await assertSucceeds(getDoc(sub(asAnonymous(env, OWNER), OWNER, 'donation_sessions', 'sess')));
  });

  it("rejects reading another user's donation session", async () => {
    await seed(['customers', OWNER, 'donation_sessions', 'sess'], validDonationSession());
    await assertFails(
      getDoc(sub(asVerifiedPassword(env, OTHER), OWNER, 'donation_sessions', 'sess')),
    );
  });

  it('rejects an update — the function owns the write-back', async () => {
    await seed(['customers', OWNER, 'donation_sessions', 'sess'], validDonationSession());
    await assertFails(
      setDoc(sub(asVerifiedPassword(env, OWNER), OWNER, 'donation_sessions', 'sess'), {
        ...validDonationSession(),
        url: 'https://evil.test',
      }),
    );
  });

  it('rejects a delete', async () => {
    await seed(['customers', OWNER, 'donation_sessions', 'sess'], validDonationSession());
    await assertFails(
      deleteDoc(sub(asVerifiedPassword(env, OWNER), OWNER, 'donation_sessions', 'sess')),
    );
  });

  describe('schema', () => {
    it('rejects any field outside the allowlist', async () => {
      await assertFails(
        create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(), {
          ...validDonationSession(),
          amount: 100_000,
        }),
      );
      await assertFails(
        create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(), {
          ...validDonationSession(),
          success_url: 'https://attacker.test/collect',
        }),
      );
    });

    // The whole reason the presets are catalog prices: an amount a client
    // chooses is a billing value the server has nothing to check it against.
    it('rejects a donation described by an amount instead of a price', async () => {
      await assertFails(
        create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(), {
          origin: 'https://example.web.app',
          amount: 500,
          currency: 'brl',
        }),
      );
    });

    it('rejects a missing or malformed price', async () => {
      await assertFails(
        create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(), {
          origin: 'https://example.web.app',
        }),
      );
      await assertFails(
        create(
          asVerifiedPassword(env, OWNER),
          OWNER,
          sessionDocId(),
          validDonationSession({ price: 'prod_123' }),
        ),
      );
      await assertFails(
        create(
          asVerifiedPassword(env, OWNER),
          OWNER,
          sessionDocId(),
          validDonationSession({ price: 99 }),
        ),
      );
    });

    it('rejects a missing or malformed origin', async () => {
      await assertFails(
        create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(), {
          price: 'price_test_coffee',
        }),
      );
      await assertFails(
        create(
          asVerifiedPassword(env, OWNER),
          OWNER,
          sessionDocId(),
          validDonationSession({ origin: 'https://example.web.app/evil' }),
        ),
      );
    });

    // Shape is as far as rules can go — whether this ID is a *donation* price
    // is checked again in `createDonationSession` against the mirrored
    // catalog, which is the half rules structurally cannot do. The Pro price
    // ID is well-formed and is refused there, not here.
    it('accepts a well-formed price ID it cannot verify, including the Pro one', async () => {
      await assertSucceeds(
        create(
          asVerifiedPassword(env, OWNER),
          OWNER,
          sessionDocId(),
          validDonationSession({ price: 'price_test_pro' }),
        ),
      );
    });
  });

  /*
   * The same cap as `checkout_sessions`, counted separately because the
   * subcollection is separate — which is the point: spending ten donation
   * slots must not stop the same account starting a Pro checkout.
   */
  describe('volume cap', () => {
    it('rejects the auto-generated ID an unbounded client would write', async () => {
      await assertFails(
        addDoc(
          subCol(asVerifiedPassword(env, OWNER), OWNER, 'donation_sessions'),
          validDonationSession(),
        ),
      );
    });

    it('accepts every one of the ten slots in a window, and nothing beyond them', async () => {
      for (let slot = 0; slot < 10; slot++) {
        await assertSucceeds(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(slot)));
      }
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(10)));
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId('00')));
    });

    it('rejects re-using a slot already spent in this window', async () => {
      const id = sessionDocId(4);
      await assertSucceeds(create(asVerifiedPassword(env, OWNER), OWNER, id));
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, id));
    });

    it('accepts the neighbouring windows and refuses anything past them', async () => {
      await assertSucceeds(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(0, -1)));
      await assertSucceeds(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(1, 1)));
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(0, -2)));
      await assertFails(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(0, 1000)));
    });

    // The two caps are independent, and that independence is the reason for a
    // second subcollection rather than a second field on the first.
    it('does not spend the checkout cap, or have its own spent by one', async () => {
      for (let slot = 0; slot < 10; slot++) {
        await assertSucceeds(create(asVerifiedPassword(env, OWNER), OWNER, sessionDocId(slot)));
      }
      await assertSucceeds(
        setDoc(
          sub(asVerifiedPassword(env, OWNER), OWNER, 'checkout_sessions', sessionDocId(0)),
          validCheckoutSession(),
        ),
      );
    });
  });
});

describe('customers/{uid}/donations: the record of what was actually paid', () => {
  beforeEach(() =>
    seed(['customers', OWNER, 'donations', 'cs_1'], {
      amount: 500,
      currency: 'brl',
      createdAt: new Date(),
      eventCreated: 1_757_600_000,
    }),
  );

  it('is readable by its owner', async () => {
    await assertSucceeds(getDoc(sub(asVerifiedPassword(env, OWNER), OWNER, 'donations', 'cs_1')));
  });

  // A guest donation is never recorded, but the account an anonymous session
  // *is* can still read its own subcollection — the read rule is about
  // ownership, not about verification, and matches who may create a session.
  it('is readable by an anonymous session that owns it', async () => {
    await assertSucceeds(getDoc(sub(asAnonymous(env, OWNER), OWNER, 'donations', 'cs_1')));
  });

  it("rejects reading another user's donation", async () => {
    await assertFails(getDoc(sub(asVerifiedPassword(env, OTHER), OWNER, 'donations', 'cs_1')));
  });

  it('rejects reading while signed out', async () => {
    await assertFails(getDoc(sub(asSignedOut(env), OWNER, 'donations', 'cs_1')));
  });

  // The reject case that matters: a client able to write this could declare a
  // donation nobody paid for.
  it('rejects a user writing their own donation record', async () => {
    await assertFails(
      setDoc(sub(asVerifiedPassword(env, OWNER), OWNER, 'donations', 'cs_forged'), {
        amount: 100_000,
        currency: 'brl',
        createdAt: new Date(),
      }),
    );
  });

  it('rejects a user amending or deleting one', async () => {
    await assertFails(
      setDoc(sub(asVerifiedPassword(env, OWNER), OWNER, 'donations', 'cs_1'), { amount: 999_999 }),
    );
    await assertFails(deleteDoc(sub(asVerifiedPassword(env, OWNER), OWNER, 'donations', 'cs_1')));
  });

  // `supporterSince` lives on `customers/{uid}`, which has no client write rule
  // at all — so this is the same refusal from the other side, and it is the one
  // that will matter the day a badge reads the field.
  it('rejects a client writing its own supporter flag', async () => {
    await assertFails(
      setDoc(doc(asVerifiedPassword(env, OWNER).firestore(), 'customers', OWNER), {
        supporterSince: new Date(),
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
